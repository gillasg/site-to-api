import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { coverage } from "./coverage.js";
import { readDocs } from "./docs.js";
import { generateClient } from "./emit/client.js";
import { htmlReport } from "./emit/html.js";
import { toAsyncApi, toOpenApi } from "./emit/openapi.js";
import { markdownReport, redactedSamples } from "./emit/report.js";
import { toYaml } from "./emit/yaml.js";
import { checkHealth, repair } from "./health.js";
import { loadCapture } from "./load/index.js";
import { loadModel, readOverrides, siteName, writeOverrides } from "./registry.js";
import type { ChannelOptions } from "./runtime/channels.js";
import type { Params } from "./runtime/request.js";
import { exportSession } from "./runtime/session-export.js";
import { siteApi } from "./runtime/site-api.js";
import { loadFlows } from "./workflow.js";

// The site_api actions beyond sites/operations/call/watch/learn/explore, shared by every host
// (this package's MCP server, the Browser Use Extension's MCP tools, Aeon's site_api tool).

export const SITE_TOOL_ACTIONS = [
  "docs",
  "actions",
  "action",
  "channel",
  "session",
  "export",
  "heal",
  "coverage",
  "edit",
  "name",
  "signing",
] as const;
export type SiteToolAction = (typeof SITE_TOOL_ACTIONS)[number];

export interface SiteToolInput {
  site: string;
  /** action: the saved action's name; channel: the channel id; signing: the operation. */
  name?: string;
  operation?: string;
  /** action: inputs; channel: { send, seconds, match }. */
  params?: Record<string, unknown>;
  /** actions: save a new action from these operation ids, in order. */
  steps?: string[];
  description?: string;
  /** edit: the change in plain English. */
  change?: string;
  /** export: folder to write into. */
  folder?: string;
  /** heal: re-record the flows behind failing operations. */
  repair?: boolean;
}

/** Plain-language guidance for each extra action, for tool descriptions. */
export const SITE_TOOL_HELP = [
  "docs: the site's published API documents (OpenAPI/Swagger) and GraphQL schemas, read with the user's session: operations nobody clicked yet. Saved in the site's folder.",
  "actions: list saved multi-step actions, or save one with name, steps (operation ids in order) and description. action runs one by name with params as inputs; each step's result feeds the next.",
  "channel: the site's live WebSocket/event streams (operations lists them); with name, listens on one from the site's page (params: send [messages], seconds, match) and returns what arrived.",
  "session: export the user's session so calls run without the browser (renewed from the browser when it expires). export: OpenAPI, AsyncAPI, a typed client and reports into folder.",
  "heal: probe every read operation and report broken or drifted ones (repair: true re-records them). coverage: what to capture next to widen the API. edit: change the API in plain English (change). name: AI names and descriptions. signing: how a signed operation is signed.",
  "Mapping actions (like, send, post, buy) without doing them: explore with actions: true, or in browser code page.network.start({ types: 'all', dryRun: true }): requests that would change something are recorded and blocked, never sent.",
];

/** Checks captures can be read: HAR (from any tool) or mitmproxy flow files (phone and desktop apps). */
export async function checkCaptures(paths: string[]): Promise<void> {
  for (const path of paths) {
    const exchanges = await loadCapture(path).catch((error: unknown) => {
      throw new Error(
        `${path} is not a HAR or mitmproxy capture: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
    if (!exchanges.length) throw new Error(`${path} has no requests`);
  }
}

/** Writes OpenAPI (JSON and YAML), AsyncAPI, a typed client, reports and samples into dir. */
export async function exportSite(site: string, dir: string): Promise<string[]> {
  const model = await loadModel(site);
  if (!model) throw new Error(`${siteName(site)} is not mapped yet.`);
  const overrides = await readOverrides(site);
  await mkdir(dir, { recursive: true });
  const openapi = toOpenApi(model, overrides.redact);
  const asyncapi = toAsyncApi(model);
  const files: Record<string, string> = {
    "openapi.json": JSON.stringify(openapi, null, 2),
    "openapi.yaml": toYaml(openapi),
    ...(asyncapi ? { "asyncapi.yaml": toYaml(asyncapi) } : {}),
    "client.ts": generateClient(model),
    "report.md": markdownReport(model, overrides.redact),
    "report.html": htmlReport(model, overrides.redact),
    "samples.json": JSON.stringify(redactedSamples(model, overrides.redact), null, 2),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return Object.keys(files).map((name) => join(dir, name));
}

/** How a signed operation is signed, with the code around the function that signs it. */
export async function signingInfo(site: string, operationId: string): Promise<unknown> {
  const model = await loadModel(site);
  const op = model?.operations.find((o) => o.id === operationId);
  if (!op?.signing) return { operation: operationId, signed: false };
  const frame = op.signing.initiator;
  let code: string | undefined;
  if (frame) {
    const source = await fetch(frame.url)
      .then((r) => r.text())
      .catch(() => "");
    const lines = source.split("\n");
    code =
      lines.length > 3
        ? lines
            .slice(Math.max(0, frame.line - 6), frame.line + 6)
            .join("\n")
            .slice(0, 4000)
        : source.slice(0, 1500) || undefined;
  }
  return {
    operation: operationId,
    signed: true,
    values: [...op.signing.headers, ...op.signing.query],
    via: op.signing.via,
    ...(frame
      ? { builtBy: `${frame.functionName || "anonymous"} at ${frame.url}:${frame.line}` }
      : {}),
    ...(code ? { code } : {}),
  };
}

async function savedActions(input: SiteToolInput): Promise<unknown> {
  const overrides = await readOverrides(input.site);
  if (input.name && input.steps?.length) {
    overrides.actions = {
      ...(overrides.actions ?? {}),
      [input.name]: {
        ...(input.description ? { description: input.description } : {}),
        steps: input.steps.map((operation) => ({ operation })),
      },
    };
    await writeOverrides(input.site, overrides);
    return { saved: input.name, steps: input.steps };
  }
  return Object.entries(overrides.actions ?? {}).map(([name, action]) => ({
    name,
    description: action.description,
    steps: action.steps.map((step) => step.operation),
  }));
}

async function channel(input: SiteToolInput): Promise<unknown> {
  const api = await siteApi(input.site);
  if (!input.name) return api.model.channels.map((c) => ({ id: c.id, kind: c.kind, url: c.url }));
  return api.channel(input.name, (input.params ?? {}) as ChannelOptions);
}

async function heal(input: SiteToolInput): Promise<unknown> {
  const report = await checkHealth(input.site);
  const failing = report.results
    .filter((r) => r.status === "broken" || r.status === "drift")
    .map((r) => r.id);
  if (!input.repair || !failing.length) return report;
  return { before: report, after: (await repair(input.site, failing)).after };
}

const require = (value: string | undefined, what: string): string => {
  if (!value) throw new Error(`Give ${what}`);
  return value;
};

const HANDLERS: Record<SiteToolAction, (input: SiteToolInput) => Promise<unknown>> = {
  docs: (input) => readDocs(input.site),
  actions: savedActions,
  action: async (input) =>
    (await siteApi(input.site)).action(
      require(input.name, "name: the action to run"),
      (input.params ?? {}) as Params,
    ),
  channel,
  session: async (input) => {
    const model = await loadModel(input.site);
    if (!model) throw new Error(`${input.site} is not mapped yet.`);
    const { session, path } = await exportSession(model);
    return { saved: path, cookies: session.cookies.length };
  },
  export: async (input) => ({
    files: await exportSite(input.site, require(input.folder, "folder: where to write")),
  }),
  heal,
  coverage: async (input) => {
    const model = await loadModel(input.site);
    if (!model) throw new Error(`${input.site} is not mapped yet.`);
    return coverage(model, (await loadFlows(input.site)).exchanges).map((s) => s.message);
  },
  edit: async (input) =>
    (await import("./agent.js")).editApi(
      input.site,
      require(input.change, "change: what to change"),
    ),
  name: async (input) => (await import("./agent.js")).nameOperations(input.site),
  signing: (input) =>
    signingInfo(
      input.site,
      require(input.operation ?? input.name, "operation: the signed operation"),
    ),
};

export function isSiteToolAction(action: unknown): action is SiteToolAction {
  return SITE_TOOL_ACTIONS.includes(action as SiteToolAction);
}

/** Runs one of the extra site_api actions. */
export function runSiteToolAction(action: SiteToolAction, input: SiteToolInput): Promise<unknown> {
  return HANDLERS[action]({ ...input, site: siteName(input.site) });
}
