#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { coverage } from "./coverage.js";
import { originMatches } from "./filter.js";
import { formatDiff, diffModels } from "./diff.js";
import { generateClient } from "./emit/client.js";
import { htmlReport } from "./emit/html.js";
import { toAsyncApi, toOpenApi } from "./emit/openapi.js";
import { markdownReport, redactedSamples } from "./emit/report.js";
import { toYaml } from "./emit/yaml.js";
import { checkHealth, repair } from "./health.js";
import { runMcpServer } from "./mcp.js";
import { STAGES, type Stage } from "./pipeline.js";
import { PassiveRecorder, RecordingSession } from "./record.js";
import {
  addLearnedNoise,
  learnedNoise,
  listSites,
  loadModel,
  loadVersion,
  readOverrides,
  siteDir,
  siteName,
  versions,
  writeSession,
} from "./registry.js";
import { closeSharedBridge } from "./runtime/bridge.js";
import { sessionExportExpression, type SessionFile } from "./runtime/session.js";
import { siteApi } from "./runtime/site-api.js";
import { PageTransport } from "./runtime/transports.js";
import { serve } from "./serve.js";
import { importCaptures, loadFlows, rebuild, saveRecording } from "./workflow.js";
import type { SiteModel } from "./types.js";

const usage = `site-to-api: parse any site into a typed API.

Map a site
  record <url> [--name n] [--attach <tab>] [--no-build]   record a flow in your browser, then build
  record --passive <domain,...>                           record every tab on these domains
  describe <site> "<flow>" [--url u]                      an AI agent performs the flow while recording
  import <site> <file.har|flows> ...                      add HAR or mitmproxy captures
  build <site> [--until ${STAGES.join("|")}] [--work dir]  rebuild from all flows
  edit <site> "<change>"                                  change the API in plain English
  name <site>                                             AI names and descriptions for operations

Use it
  sites | ops <site>                                      list sites / operations
  call <site> <operation> [json] [--param k=v] [--all] [--max-items n] [--transport page|direct]
  serve [--port n]                                        local REST API + docs for every site
  mcp [site]                                              stdio MCP server
  session <site>                                          export your session for calls without a browser
  export <site> [--out dir]                               OpenAPI JSON/YAML, AsyncAPI, client, reports, samples

Keep it working
  heal <site> [--repair] [--include-actions]              probe operations, re-record broken ones
  coverage <site>                                         flows that would widen the API
  diff <site> [from] [to]                                 what changed between versions
  signing <site> <operation>                              show the code that signs a request
  noise [add <regex> | list]                              learned and hand-added noise patterns
  login                                                   connect an AI model (optional features)`;

type Args = { positional: string[]; flags: Record<string, string | true> };

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) flags[name] = inline;
    else if (
      next !== undefined &&
      !next.startsWith("--") &&
      !["all", "no-build", "repair", "include-actions", "json"].includes(name)
    ) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
    if (name === "param") {
      const [key, value] = String(flags[name]).split("=", 2);
      flags[`param.${key}`] = value ?? "";
    }
  }
  return { positional, flags };
}

const out = (text: string): void => void process.stdout.write(text + "\n");
const flag = (args: Args, name: string) =>
  typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined;

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  await rl.question(prompt);
  rl.close();
}

async function buildAndReport(
  site: string,
  options: { until?: Stage; workDir?: string } = {},
): Promise<void> {
  const result = await rebuild(site, options);
  if (result.stage !== "trace") {
    out(
      `Stopped after ${result.stage}. ${options.workDir ? `Intermediate files are in ${options.workDir}.` : ""}`,
    );
    return;
  }
  const model = result.model;
  out(
    `${model.site}: ${model.operations.length} operations, ${model.pages.length} page endpoints, ${model.channels.length} streams (version ${result.version}).`,
  );
  for (const op of model.operations)
    out(`  ${op.bucket.padEnd(6)} ${op.method.padEnd(6)} ${op.id}  ${op.path}`);
  if (result.changed && result.diff) out(formatDiff(result.diff));
  out(`Files: ${result.dir}`);
}

async function record(args: Args): Promise<void> {
  const passive = flag(args, "passive");
  if (passive) {
    const domains = passive.split(",").map((d) => siteName(d));
    const recorder = await PassiveRecorder.start(domains);
    await waitForEnter(
      `Recording every tab on ${domains.join(", ")}. Use the sites, then press Enter to stop… `,
    );
    const recording = await recorder.stop();
    await saveRecording(domains[0] as string, recording, {
      name: flag(args, "name") ?? `passive-${Date.now()}`,
    });
    if (args.flags["no-build"] !== true) await buildAndReport(domains[0] as string);
    return;
  }
  const url = args.positional[1];
  if (!url) throw new Error("Usage: site-to-api record <url>");
  const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  const attach = flag(args, "attach");
  const session = await RecordingSession.start({
    url: target,
    ...(attach ? { attach: /^\d+$/.test(attach) ? Number(attach) : attach } : {}),
  });
  await waitForEnter(
    `Recording ${target}. Do the flow in the browser tab, then press Enter here… `,
  );
  const recording = await session.stop();
  const name = flag(args, "name");
  const path = await saveRecording(target, recording, name ? { name } : {});
  out(`Saved ${recording.har.log.entries.length} requests to ${path}`);
  if (args.flags["no-build"] !== true) await buildAndReport(target);
}

function callParams(args: Args): Record<string, unknown> {
  const json = args.positional[3];
  const params: Record<string, unknown> = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(args.flags))
    if (key.startsWith("param.")) params[key.slice(6)] = value;
  return params;
}

async function call(args: Args): Promise<void> {
  const [, site, operation] = args.positional;
  if (!site || !operation) throw new Error("Usage: site-to-api call <site> <operation> [json]");
  const transport = flag(args, "transport") as "page" | "direct" | undefined;
  const api = await siteApi(site, transport ? { transport } : {});
  const params = callParams(args);
  if (args.flags.all === true || flag(args, "max-items")) {
    const items: unknown[] = [];
    for await (const item of api.paginate(operation, params, {
      maxItems: Number(flag(args, "max-items") ?? 10_000),
    }))
      items.push(item);
    out(JSON.stringify(items, null, 2));
    return;
  }
  const result = api.pageEndpoint(operation)
    ? await api.fetchPage(operation, params as Record<string, string>)
    : await api.call(operation, params);
  out(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

async function exportSession(site: string): Promise<void> {
  const model = await loadModel(site);
  if (!model) throw new Error(`${siteName(site)} is not mapped yet.`);
  const page = new PageTransport();
  const home =
    model.origins.find((o) => originMatches(new URL(o), model.site)) ?? `https://${model.site}`;
  const info = (await page.inPage(home + "/", sessionExportExpression())) as {
    userAgent: string;
    language: string;
    origin: string;
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  };
  const { sharedBridge } = await import("./runtime/bridge.js");
  const cookies = (await (
    await sharedBridge()
  ).run(
    `(await globalThis.__siteToApiTabs[${JSON.stringify(new URL(home).origin)}].cdp('Network.getCookies', { urls: ${JSON.stringify(model.origins.map((o) => o + "/"))} })).cookies`,
    { session: "site-to-api" },
  )) as SessionFile["cookies"];
  const session: SessionFile = {
    site: model.site,
    savedAt: new Date().toISOString(),
    userAgent: info.userAgent,
    language: info.language,
    cookies,
    localStorage: { [info.origin]: info.localStorage },
    sessionStorage: { [info.origin]: info.sessionStorage },
  };
  const path = await writeSession(session);
  out(
    `Saved ${cookies.length} cookies and web storage to ${path} (readable only by you). Calls run without the browser for 12 hours.`,
  );
}

async function exportFiles(site: string, dir: string): Promise<void> {
  const model = await loadModel(site);
  if (!model) throw new Error(`${siteName(site)} is not mapped yet.`);
  const overrides = await readOverrides(site);
  await mkdir(dir, { recursive: true });
  const openapi = toOpenApi(model, overrides.redact);
  await writeFile(join(dir, "openapi.json"), JSON.stringify(openapi, null, 2));
  await writeFile(join(dir, "openapi.yaml"), toYaml(openapi));
  const asyncapi = toAsyncApi(model);
  if (asyncapi) await writeFile(join(dir, "asyncapi.yaml"), toYaml(asyncapi));
  await writeFile(join(dir, "client.ts"), generateClient(model));
  await writeFile(join(dir, "report.md"), markdownReport(model, overrides.redact));
  await writeFile(join(dir, "report.html"), htmlReport(model, overrides.redact));
  await writeFile(
    join(dir, "samples.json"),
    JSON.stringify(redactedSamples(model, overrides.redact), null, 2),
  );
  out(`Exported to ${dir}`);
}

async function heal(args: Args, site: string): Promise<void> {
  const report = await checkHealth(site, {
    includeActions: args.flags["include-actions"] === true,
  });
  for (const r of report.results)
    out(
      `${r.status.padEnd(10)} ${r.id}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}${r.error ? `: ${r.error}` : ""}${r.changes?.length ? `\n    ${r.changes.join("\n    ")}` : ""}`,
    );
  const failing = report.results
    .filter((r) => r.status === "broken" || r.status === "drift")
    .map((r) => r.id);
  if (args.flags.repair === true && failing.length) {
    out(`Re-recording the flows behind ${failing.join(", ")}…`);
    const result = await repair(site, failing);
    for (const r of result.after.results) out(`after repair: ${r.status.padEnd(10)} ${r.id}`);
  }
}

async function signing(site: string, operationId: string): Promise<void> {
  const model = await loadModel(site);
  const op = model?.operations.find((o) => o.id === operationId);
  if (!op?.signing) return out(`${operationId} is not signed.`);
  out(
    `Signed values: ${[...op.signing.headers, ...op.signing.query].join(", ")}; calls go through the page's ${op.signing.via}.`,
  );
  const frame = op.signing.initiator;
  if (!frame) return;
  out(`Built by ${frame.functionName || "an anonymous function"} at ${frame.url}:${frame.line}`);
  const source = await fetch(frame.url)
    .then((r) => r.text())
    .catch(() => "");
  const lines = source.split("\n");
  if (lines.length > 3)
    out(
      lines
        .slice(Math.max(0, frame.line - 6), frame.line + 6)
        .join("\n")
        .slice(0, 4000),
    );
  else if (source) out(source.slice(0, 1500));
}

async function mappedModel(site: string): Promise<SiteModel> {
  const model = await loadModel(site);
  if (!model) throw new Error(`${siteName(site)} is not mapped yet.`);
  return model;
}

async function showCoverage(site: string): Promise<void> {
  const model = await mappedModel(site);
  const { exchanges } = await loadFlows(site);
  for (const s of coverage(model, exchanges)) out(`- ${s.message}`);
}

async function showDiff(args: Args, site: string): Promise<void> {
  const list = await versions(site);
  const to = Number(args.positional[3] ?? list[list.length - 1]?.version);
  const from = Number(args.positional[2] ?? to - 1);
  const after = (await loadVersion(site, to)) ?? (await mappedModel(site));
  out(formatDiff(diffModels(await loadVersion(site, from), after)));
}

async function describe(args: Args, site: string): Promise<void> {
  const { performFlow } = await import("./agent.js");
  const url = flag(args, "url");
  const result = await performFlow(site, args.positional[2] ?? "", {
    ...(url ? { startUrl: url } : {}),
    onStep: (code) => process.stderr.write(`> ${code.split("\n")[0]?.slice(0, 120)}\n`),
  });
  out(result.summary);
  await buildAndReport(site);
}

async function build(args: Args, site: string): Promise<void> {
  const until = flag(args, "until") as Stage | undefined;
  if (until && !STAGES.includes(until))
    throw new Error(`--until must be one of ${STAGES.join(", ")}`);
  const work = flag(args, "work") ?? (until ? join(siteDir(site), "build") : undefined);
  await buildAndReport(site, {
    ...(until ? { until } : {}),
    ...(work ? { workDir: resolve(work) } : {}),
  });
}

async function listOperations(site: string): Promise<void> {
  const model = await mappedModel(site);
  for (const op of model.operations) {
    const inputs = op.params.filter((p) => !p.constant && !p.generated).map((p) => p.name);
    out(`${op.id}\t${op.method} ${op.path}\t${inputs.join(", ")}`);
  }
  for (const page of model.pages) out(`${page.id}\tPAGE ${page.path}`);
}

async function serveForever(args: Args): Promise<void> {
  const port = flag(args, "port");
  const server = await serve(port ? { port: Number(port) } : {});
  out(`Serving every mapped site at ${server.url}/#token=${server.token}`);
  out(`Calls need the header x-site-to-api-token: ${server.token}`);
  await new Promise(() => undefined);
}

async function noise(args: Args): Promise<void> {
  const [, action, pattern] = args.positional;
  if (action === "add" && pattern) await addLearnedNoise([pattern]);
  for (const item of await learnedNoise()) out(item);
}

async function signIn(): Promise<void> {
  const login = await import("pi-ai-login");
  await login.login({
    onUrl: (url) => out(`Opening the sign-in page… If nothing opens, visit:\n${url}`),
  });
}

/** Commands that work without a site. */
const GLOBAL: Record<string, (args: Args) => Promise<void>> = {
  record,
  sites: async () => {
    for (const s of await listSites())
      out(`${s.site}\t${s.operations} operations\t${s.updated.slice(0, 10)}`);
  },
  serve: serveForever,
  mcp: (args) => runMcpServer(args.positional[1]),
  login: signIn,
  noise,
};

/** Commands about one site: `site-to-api <command> <site> …`. */
const PER_SITE: Record<string, (args: Args, site: string) => Promise<void>> = {
  build,
  import: async (args, site) => {
    for (const path of await importCaptures(site, args.positional.slice(2))) out(`Added ${path}`);
    await buildAndReport(site);
  },
  ops: (_args, site) => listOperations(site),
  call: (args) => call(args),
  session: (_args, site) => exportSession(site),
  export: (args, site) => exportFiles(site, resolve(flag(args, "out") ?? `${siteName(site)}-api`)),
  heal,
  signing: (args, site) => signing(site, args.positional[2] ?? ""),
  coverage: (_args, site) => showCoverage(site),
  diff: showDiff,
  describe,
  edit: async (args, site) =>
    out((await (await import("./agent.js")).editApi(site, args.positional[2] ?? "")).note),
  name: async (_args, site) =>
    out(JSON.stringify(await (await import("./agent.js")).nameOperations(site), null, 2)),
};

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const [command = "", site] = args.positional;
  const global = GLOBAL[command];
  const perSite = PER_SITE[command];
  if (global) await global(args);
  else if (perSite) {
    if (!site) throw new Error(`Usage: site-to-api ${command} <site>`);
    await perSite(args, site);
  } else {
    out(usage);
    return command && command !== "help" ? 1 : 0;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  async (code) => {
    await closeSharedBridge();
    process.exit(code);
  },
  async (error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    await closeSharedBridge();
    process.exit(1);
  },
);
