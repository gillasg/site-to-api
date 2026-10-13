import { appendFile, chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffModels, isEmptyDiff, type ModelDiff } from "./diff.js";
import { generateClient } from "./emit/client.js";
import { htmlReport } from "./emit/html.js";
import { toAsyncApi, toOpenApi } from "./emit/openapi.js";
import { markdownReport } from "./emit/report.js";
import { toYaml } from "./emit/yaml.js";
import type { SessionFile } from "./runtime/session.js";
import type { Overrides, SiteModel } from "./types.js";

// The registry of mapped sites on disk: ~/.site-to-api/sites/<site>/ holds the model, the
// exported spec and client, recorded flows, overrides, health and every version. Other tools
// (crawlers, browser extensions) read it and watch its events file.

export function registryRoot(): string {
  return process.env.SITE_TO_API_HOME ?? join(homedir(), ".site-to-api");
}

/** `https://www.shop.example/x` → `shop.example`. */
export function siteName(input: string): string {
  const trimmed = input.trim();
  const host = /^[a-z]+:\/\//i.test(trimmed)
    ? new URL(trimmed).host
    : (trimmed.split("/")[0] ?? trimmed);
  return host.toLowerCase().replace(/^www\./, "");
}

export function siteDir(site: string): string {
  return join(registryRoot(), "sites", siteName(site).replace(/:/g, "_"));
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, mode ? { mode } : {});
  await rename(temporary, path);
  if (mode && process.platform !== "win32") await chmod(path, mode);
}

export async function listSites(): Promise<
  { site: string; operations: number; updated: string }[]
> {
  const root = join(registryRoot(), "sites");
  const names = await readdir(root).catch(() => [] as string[]);
  const sites = await Promise.all(
    names.map(async (name) => {
      const model = await readJson<SiteModel>(join(root, name, "model.json"));
      return model
        ? { site: model.site, operations: model.operations.length, updated: model.generatedAt }
        : undefined;
    }),
  );
  return sites
    .filter((site): site is NonNullable<typeof site> => !!site)
    .sort((a, b) => a.site.localeCompare(b.site));
}

export const loadModel = (site: string): Promise<SiteModel | undefined> =>
  readJson<SiteModel>(join(siteDir(site), "model.json"));

export async function readOverrides(site: string): Promise<Overrides> {
  return (await readJson<Overrides>(join(siteDir(site), "overrides.json"))) ?? {};
}

export async function writeOverrides(site: string, overrides: Overrides): Promise<void> {
  await mkdir(siteDir(site), { recursive: true });
  await writeAtomic(
    join(siteDir(site), "overrides.json"),
    JSON.stringify(overrides, null, 2) + "\n",
  );
}

export interface FlowMeta {
  name: string;
  /** The capture file in the flows folder (HAR or a mitmproxy flow file). */
  file: string;
  /** Browser code that repeats the flow, so repairs can re-record it without a model. */
  steps?: string[];
  description?: string;
  startUrl?: string;
  recordedAt: string;
  storage?: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> };
}

/** Saves a capture (a HAR object, or raw file bytes with their extension) as a named flow. */
export async function saveFlow(
  site: string,
  meta: Omit<FlowMeta, "file">,
  capture: unknown,
  extension = "har",
): Promise<string> {
  const folder = join(siteDir(site), "flows");
  await mkdir(folder, { recursive: true });
  const safe = meta.name.replace(/[^\w.-]+/g, "-");
  const file = `${safe}.${extension}`;
  if (Buffer.isBuffer(capture)) await writeFile(join(folder, file), capture, { mode: 0o600 });
  else await writeAtomic(join(folder, file), JSON.stringify(capture), 0o600);
  await writeAtomic(
    join(folder, `${safe}.json`),
    JSON.stringify({ ...meta, name: safe, file }, null, 2),
    0o600,
  );
  return join(folder, file);
}

export async function listFlows(site: string): Promise<{ meta: FlowMeta; harPath: string }[]> {
  const folder = join(siteDir(site), "flows");
  const files = await readdir(folder).catch(() => [] as string[]);
  const flows = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const meta = await readJson<FlowMeta>(join(folder, file));
        return meta?.file ? { meta, harPath: join(folder, meta.file) } : undefined;
      }),
  );
  return flows.filter((flow): flow is NonNullable<typeof flow> => !!flow);
}

export interface VersionEntry {
  version: number;
  savedAt: string;
  operations: number;
  diff: ModelDiff;
}

export interface SaveResult {
  dir: string;
  version: number;
  diff: ModelDiff;
  changed: boolean;
}

/** Writes the model and everything generated from it; a new version only when the API changed. */
export async function saveModel(model: SiteModel, overrides: Overrides = {}): Promise<SaveResult> {
  const dir = siteDir(model.site);
  await mkdir(join(dir, "versions"), { recursive: true });
  const previous = await loadModel(model.site);
  const diff = diffModels(previous, model);
  const index = (await readJson<VersionEntry[]>(join(dir, "versions", "index.json"))) ?? [];
  const changed = !previous || !isEmptyDiff(diff);
  const version = changed
    ? (index[index.length - 1]?.version ?? 0) + 1
    : (index[index.length - 1]?.version ?? 1);
  if (changed) {
    index.push({ version, savedAt: model.generatedAt, operations: model.operations.length, diff });
    await writeAtomic(join(dir, "versions", `${version}.json`), JSON.stringify(model), 0o600);
    await writeAtomic(join(dir, "versions", "index.json"), JSON.stringify(index, null, 2));
  }
  await writeAtomic(join(dir, "model.json"), JSON.stringify(model, null, 2), 0o600);
  await exportAll(model, dir, overrides);
  if (changed) await appendEvent(model.site, { type: "version", version, diff });
  return { dir, version, diff, changed };
}

/** The shareable outputs, all redacted: OpenAPI (JSON and YAML), AsyncAPI, client, reports. */
export async function exportAll(
  model: SiteModel,
  dir: string,
  overrides: Overrides = {},
): Promise<void> {
  const openapi = toOpenApi(model, overrides.redact);
  await writeAtomic(join(dir, "openapi.json"), JSON.stringify(openapi, null, 2) + "\n");
  await writeAtomic(join(dir, "openapi.yaml"), toYaml(openapi));
  const asyncapi = toAsyncApi(model);
  if (asyncapi) await writeAtomic(join(dir, "asyncapi.yaml"), toYaml(asyncapi));
  await writeAtomic(join(dir, "client.ts"), generateClient(model));
  await writeAtomic(join(dir, "report.md"), markdownReport(model, overrides.redact));
  await writeAtomic(join(dir, "report.html"), htmlReport(model, overrides.redact));
}

export async function versions(site: string): Promise<VersionEntry[]> {
  return (await readJson<VersionEntry[]>(join(siteDir(site), "versions", "index.json"))) ?? [];
}

export const loadVersion = (site: string, version: number): Promise<SiteModel | undefined> =>
  readJson<SiteModel>(join(siteDir(site), "versions", `${version}.json`));

export const readSession = (site: string): Promise<SessionFile | undefined> =>
  readJson<SessionFile>(join(siteDir(site), "session.json"));

export async function writeSession(session: SessionFile): Promise<string> {
  await mkdir(siteDir(session.site), { recursive: true });
  const path = join(siteDir(session.site), "session.json");
  await writeAtomic(path, JSON.stringify(session, null, 2), 0o600);
  return path;
}

/** Events other tools listen to: new versions, health results, repairs. One JSON per line. */
export async function appendEvent(site: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(siteDir(site), { recursive: true });
  await appendFile(
    join(siteDir(site), "events.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), site: siteName(site), ...event }) + "\n",
  );
}

export async function learnedNoise(): Promise<string[]> {
  return (await readJson<string[]>(join(registryRoot(), "noise.json"))) ?? [];
}

export async function addLearnedNoise(patterns: string[]): Promise<void> {
  if (!patterns.length) return;
  await mkdir(registryRoot(), { recursive: true });
  const current = await learnedNoise();
  await writeAtomic(
    join(registryRoot(), "noise.json"),
    JSON.stringify([...new Set([...current, ...patterns])], null, 2),
  );
}
