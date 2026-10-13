import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { schemaChanges, resolveAll } from "./diff.js";
import { inferSchema } from "./infer/schema.js";
import { RecordingSession } from "./record.js";
import { appendEvent, listFlows, siteDir, siteName } from "./registry.js";
import type { Bridge } from "./runtime/bridge.js";
import { SET, type Params } from "./runtime/request.js";
import { siteApi, type SiteApiOptions, type SiteClient } from "./runtime/site-api.js";
import type { Operation } from "./types.js";
import { rebuild, saveRecording } from "./workflow.js";

// Self-repair: probes replay recorded requests and compare the answers to the stored schemas.
// Broken or drifted operations get their flow re-recorded (replaying its saved steps) and the
// API rebuilt as a new version. Results go to health.json and the events file.

export interface HealthResult {
  id: string;
  status: "ok" | "drift" | "broken" | "signed-out" | "skipped";
  httpStatus?: number;
  changes?: string[];
  error?: string;
}

export interface HealthReport {
  site: string;
  checkedAt: string;
  results: HealthResult[];
}

/** The parameters of an operation's last recorded call, so a probe asks exactly that again. */
export function sampleParams(operation: Operation): Params {
  const sample = operation.samples[operation.samples.length - 1];
  const params: Params = {};
  const sets: Params = {};
  for (const param of operation.params) {
    if (param.in === "path" && param.examples?.[0] !== undefined)
      params[param.name] = param.examples[param.examples.length - 1];
  }
  if (sample)
    for (const [key, value] of new URL(sample.url).searchParams) sets[`query:${key}`] = value;
  return { ...params, [SET]: sets };
}

function safe(operation: Operation, includeActions: boolean): boolean {
  return includeActions || operation.role === "read";
}

/** Only a missing required field or a changed type breaks callers; new fields do not. */
const isBreaking = (line: string) => /\(required\) missing|changed type/.test(line);

function compare(
  client: SiteClient,
  operation: Operation,
  status: number,
  json: unknown,
): HealthResult {
  const stored = Object.entries(operation.responses).find(([code]) => code.startsWith("2"))?.[1]
    ?.schema;
  if (!stored || json === undefined) return { id: operation.id, status: "ok", httpStatus: status };
  const changes = schemaChanges(resolveAll(client.model, stored), inferSchema([json]));
  return {
    id: operation.id,
    status: changes.some(isBreaking) ? "drift" : "ok",
    httpStatus: status,
    ...(changes.length ? { changes } : {}),
  };
}

async function probe(client: SiteClient, operation: Operation): Promise<HealthResult> {
  try {
    const response = await client.request(operation.id, sampleParams(operation));
    const status = response.status;
    if (status === 401 || status === 403)
      return { id: operation.id, status: "signed-out", httpStatus: status };
    if (status >= 400 || status === 0)
      return { id: operation.id, status: "broken", httpStatus: status };
    return compare(client, operation, status, response.json);
  } catch (error) {
    return {
      id: operation.id,
      status: "broken",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CheckOptions extends SiteApiOptions {
  includeActions?: boolean;
  operations?: string[];
}

export async function checkHealth(site: string, options: CheckOptions = {}): Promise<HealthReport> {
  const client = await siteApi(site, options);
  const results: HealthResult[] = [];
  for (const operation of client.operations) {
    if (options.operations && !options.operations.includes(operation.id)) continue;
    if (!safe(operation, options.includeActions ?? false)) {
      results.push({ id: operation.id, status: "skipped" });
      continue;
    }
    results.push(await probe(client, operation));
  }
  const report: HealthReport = { site: client.site, checkedAt: new Date().toISOString(), results };
  await writeFile(join(siteDir(client.site), "health.json"), JSON.stringify(report, null, 2));
  const counts = Object.fromEntries(
    ["ok", "drift", "broken", "signed-out", "skipped"].map((status) => [
      status,
      results.filter((r) => r.status === status).length,
    ]),
  );
  await appendEvent(client.site, {
    type: "health",
    counts,
    failing: results.filter((r) => r.status === "drift" || r.status === "broken").map((r) => r.id),
  });
  return report;
}

export async function readHealth(site: string): Promise<HealthReport | undefined> {
  try {
    return JSON.parse(await readFile(join(siteDir(site), "health.json"), "utf8")) as HealthReport;
  } catch {
    return undefined;
  }
}

export interface RepairOptions extends CheckOptions {
  bridge?: () => Promise<Bridge>;
  /** Wait this long on each page for the site's own requests. Default 6 s. */
  settleMs?: number;
}

interface RepairTarget {
  startUrl: string;
  steps?: string[];
  description?: string;
}

/** The flows behind the failing operations: where each starts and the steps that repeat it. */
async function repairTargets(client: SiteClient, failing: string[]): Promise<RepairTarget[]> {
  const flows = await listFlows(client.site);
  const targets = new Map<string, RepairTarget>();
  for (const operation of client.operations.filter((op) => failing.includes(op.id))) {
    const flow = flows.find(
      (item) => operation.sources.includes(item.meta.name) && item.meta.startUrl,
    );
    const startUrl = flow?.meta.startUrl ?? operation.pageUrls[0] ?? client.home(operation);
    targets.set(startUrl + (flow?.meta.name ?? ""), {
      startUrl,
      ...(flow?.meta.steps ? { steps: flow.meta.steps } : {}),
      ...(flow?.meta.description ? { description: flow.meta.description } : {}),
    });
  }
  return [...targets.values()];
}

async function rerecord(
  site: string,
  target: RepairTarget,
  options: RepairOptions,
): Promise<string> {
  const session = await RecordingSession.start({
    url: target.startUrl,
    foreground: false,
    ...(options.bridge ? { bridge: options.bridge } : {}),
  });
  try {
    await session.run(`await new Promise((r) => setTimeout(r, ${options.settleMs ?? 6000}));`);
    for (const step of target.steps ?? []) await session.run(step).catch(() => undefined);
  } finally {
    const recording = await session.stop();
    const { startUrl, ...meta } = target;
    void startUrl;
    await saveRecording(site, recording, { name: `repair-${Date.now()}`, ...meta });
  }
  return target.startUrl;
}

/** Re-records the flows behind failing operations, rebuilds, and checks them again. */
export async function repair(
  site: string,
  failing: string[],
  options: RepairOptions = {},
): Promise<{ rerecorded: string[]; after: HealthReport }> {
  const name = siteName(site);
  const client = await siteApi(name, options);
  const rerecorded: string[] = [];
  for (const target of await repairTargets(client, failing))
    rerecorded.push(await rerecord(name, target, options));
  const rebuilt = await rebuild(name);
  await appendEvent(name, { type: "repair", operations: failing, version: rebuilt.version });
  const after = await checkHealth(name, { ...options, operations: failing });
  return { rerecorded, after };
}
