import { createInterface } from "node:readline";
import { explore } from "./explore.js";
import { readDocs } from "./docs.js";
import { watch } from "./watch.js";
import { listSites, loadModel, readOverrides, siteName } from "./registry.js";
import { siteApi, type SiteApi, type SiteApiOptions } from "./runtime/site-api.js";
import type { SiteAction } from "./runtime/actions.js";
import type { ChannelOptions } from "./runtime/channels.js";
import type { JsonSchema, Operation, PageEndpoint, Param, SiteModel } from "./types.js";

// A stdio MCP server. With a site: one tool per operation and page endpoint, with typed inputs.
// Without one: tools to list mapped sites, inspect operations and call any of them.

type Json = Record<string, unknown>;
const LIMIT = 60_000;

function hiddenParam(param: Param): boolean {
  if (param.constant || param.generated) return true;
  return param.in === "header" && /^(authorization|x-csrf|x-xsrf)/i.test(param.name);
}

function paramProperty(param: Param): JsonSchema {
  const example = param.examples?.[0];
  return {
    ...param.schema,
    description: `${param.in} parameter${example ? `, e.g. ${example.slice(0, 60)}` : ""}`,
  };
}

function bodyProperties(operation: Operation): Record<string, JsonSchema> {
  const properties = (operation.requestBody?.schema.properties ?? {}) as Record<string, JsonSchema>;
  if (operation.kind === "graphql")
    return { variables: properties.variables ?? { type: "object" } };
  return properties;
}

function inputSchema(operation: Operation): Json {
  const properties: Record<string, JsonSchema> = {};
  const visible = operation.params.filter((param) => !hiddenParam(param));
  for (const param of visible) properties[param.name] = paramProperty(param);
  for (const [name, schema] of Object.entries(bodyProperties(operation)))
    properties[name] ??= schema;
  if (operation.pagination)
    properties.maxItems = {
      type: "integer",
      description: "Fetch every page, up to this many items",
    };
  const required = visible.filter((param) => param.in === "path").map((param) => param.name);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function toolName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function siteTools(model: SiteModel, saved: Record<string, SiteAction> = {}): Json[] {
  const ops = model.operations.map((op) => ({
    name: toolName(op.id),
    description: `${op.summary ?? op.description ?? op.id}: ${op.method} ${op.path} on ${model.site} (${op.role}, ${op.bucket} confidence).`,
    inputSchema: inputSchema(op),
    annotations: { readOnlyHint: op.role === "read", destructiveHint: op.method === "DELETE" },
  }));
  const pages = model.pages.map((page: PageEndpoint) => ({
    name: toolName(page.id),
    description: `Data from the ${page.path} page on ${model.site}.`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(page.params.map((p) => [p.name, { type: "string" }])),
      required: page.params.map((p) => p.name),
    },
    annotations: { readOnlyHint: true },
  }));
  const actions = Object.entries(saved).map(([name, action]) => ({
    name: toolName(name),
    description: `${action.description ?? name}: runs ${action.steps.map((step) => step.operation).join(" → ")} on ${model.site}.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  }));
  return [...ops, ...pages, ...actions];
}

function listOperations(model: SiteModel, saved: Record<string, SiteAction>): Json {
  return {
    operations: siteTools(model, saved).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.inputSchema,
    })),
    channels: model.channels.map((channel) => ({
      id: channel.id,
      kind: channel.kind,
      url: channel.url,
    })),
  };
}

function channelOptions(args: Json): ChannelOptions {
  return {
    ...(Array.isArray(args.send) ? { send: args.send as unknown[] } : {}),
    ...(typeof args.seconds === "number" ? { seconds: args.seconds } : {}),
    ...(typeof args.match === "string" ? { match: args.match } : {}),
  };
}

const GENERAL_TOOLS: Json[] = [
  {
    name: "list_sites",
    description: "Sites mapped into typed APIs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_operations",
    description: "A site's operations with their parameters.",
    inputSchema: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
  },
  {
    name: "call_operation",
    description:
      "Call one of a site's operations (or page endpoints) as the user, through their browser session.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        operation: { type: "string" },
        params: { type: "object" },
        maxItems: { type: "integer" },
      },
      required: ["site", "operation"],
    },
  },
  {
    name: "watch_operation",
    description:
      "Call an operation again and get only the items that are new or changed since the last check of the same watch (new listings, price changes, new messages). The first check returns first: true.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        operation: { type: "string" },
        params: { type: "object" },
        key: { type: "string", description: "Field identifying an item (default: id, url, ...)." },
        items: { type: "string", description: "Dot path to the list in the result." },
      },
      required: ["site", "operation"],
    },
  },
  {
    name: "run_action",
    description:
      "Run one of a site's saved multi-step actions (list_operations shows them): its operations run in order, each step's result feeding the next.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        action: { type: "string" },
        inputs: { type: "object" },
      },
      required: ["site", "action"],
    },
  },
  {
    name: "listen_channel",
    description:
      "Open one of a site's live channels (WebSocket or event stream, see list_operations) from its page, send messages, listen for a while and return what arrived.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        channel: { type: "string" },
        send: { type: "array", description: "Messages to send once connected (WebSocket)." },
        seconds: { type: "number", description: "How long to listen (default 10, at most 120)." },
        match: { type: "string", description: "Keep only messages containing this text." },
      },
      required: ["site", "channel"],
    },
  },
  {
    name: "site_docs",
    description:
      "A mapped site's published API documents (OpenAPI/Swagger) and GraphQL schemas, read from its page with the user's session: operations nobody has clicked yet. Saves them in the site's folder.",
    inputSchema: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
  },
  {
    name: "explore_sites",
    description:
      "Map sites by name: an AI agent uses each one in the browser (search, filters, pages, details) while it is recorded, then builds its API. Needs a connected model.",
    inputSchema: {
      type: "object",
      properties: {
        sites: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
        goal: { type: "string", description: "Extra things to do on each site." },
        actions: {
          type: "boolean",
          description:
            "Also map actions (like, send, post, buy) in dry run: their requests are recorded and blocked, never sent.",
        },
      },
      required: ["sites"],
    },
  },
];

async function callTool(api: SiteApi, operation: string, params: Json): Promise<unknown> {
  if (api.pageEndpoint(operation))
    return api.fetchPage(operation, params as Record<string, string>);
  const { maxItems, ...rest } = params;
  if (typeof maxItems === "number") {
    const items: unknown[] = [];
    for await (const item of api.paginate(operation, rest, { maxItems })) items.push(item);
    return items;
  }
  return api.call(operation, rest);
}

function watchTool(args: Json): Promise<unknown> {
  return watch(String(args.site), String(args.operation), (args.params as Json | undefined) ?? {}, {
    ...(typeof args.key === "string" ? { key: args.key } : {}),
    ...(typeof args.items === "string" ? { items: args.items } : {}),
  });
}

function textResult(value: unknown, isError = false): Json {
  let text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null");
  if (text.length > LIMIT)
    text = text.slice(0, LIMIT) + `\n[${text.length - LIMIT} more characters clipped]`;
  return { content: [{ type: "text", text }], isError };
}

function initializeResult(params: Json, model: SiteModel | undefined): Json {
  return {
    protocolVersion:
      typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: model ? `site-to-api ${model.site}` : "site-to-api", version: "0.1.0" },
  };
}

export async function runMcpServer(site?: string, options: SiteApiOptions = {}): Promise<void> {
  const apis = new Map<string, Promise<SiteApi>>();
  const api = (name: string) => {
    const key = siteName(name);
    if (!apis.has(key)) apis.set(key, siteApi(key, options));
    return apis.get(key) as Promise<SiteApi>;
  };
  const model = site ? await loadModel(site) : undefined;
  if (site && !model) throw new Error(`${siteName(site)} is not mapped yet.`);
  const saved = model ? ((await readOverrides(model.site)).actions ?? {}) : {};
  const siteTool = async (current: SiteModel, name: unknown, args: Json): Promise<unknown> => {
    const ids = [...current.operations.map((op) => op.id), ...current.pages.map((p) => p.id)];
    const id = ids.find((item) => toolName(item) === name);
    const action = Object.keys(saved).find((item) => toolName(item) === name);
    if (!id && action) return (await api(current.site)).action(action, args);
    if (!id) throw new Error(`Unknown tool ${String(name)}`);
    return callTool(await api(current.site), id, args);
  };
  const general: Record<string, (args: Json) => Promise<unknown>> = {
    list_sites: () => listSites(),
    list_operations: async (args) => {
      const found = await loadModel(String(args.site));
      if (!found) throw new Error(`${String(args.site)} is not mapped`);
      return listOperations(found, (await readOverrides(found.site)).actions ?? {});
    },
    run_action: async (args) =>
      (await api(String(args.site))).action(
        String(args.action),
        (args.inputs as Json | undefined) ?? {},
      ),
    listen_channel: async (args) =>
      (await api(String(args.site))).channel(String(args.channel), channelOptions(args)),
    watch_operation: watchTool,
    site_docs: (args) => readDocs(String(args.site)),
    explore_sites: (args) =>
      explore(args.sites as string[], {
        ...(typeof args.goal === "string" ? { goal: args.goal } : {}),
        ...(args.actions === true ? { actions: true } : {}),
      }),
    call_operation: async (args) => {
      const maxItems = typeof args.maxItems === "number" ? { maxItems: args.maxItems } : {};
      return callTool(await api(String(args.site)), String(args.operation), {
        ...((args.params as Json | undefined) ?? {}),
        ...maxItems,
      });
    },
  };
  const generalTool = (name: unknown, args: Json): Promise<unknown> => {
    const run = general[String(name)];
    if (!run) throw new Error(`Unknown tool ${String(name)}`);
    return run(args);
  };
  const handle = async (message: Json): Promise<unknown> => {
    const params = (message.params ?? {}) as Json;
    if (message.method === "initialize") return initializeResult(params, model);
    if (message.method === "ping") return {};
    if (message.method === "tools/list")
      return { tools: model ? siteTools(model, saved) : GENERAL_TOOLS };
    if (message.method !== "tools/call")
      throw new Error(`Unsupported method: ${String(message.method)}`);
    const args = (params.arguments ?? {}) as Json;
    try {
      return textResult(
        model ? await siteTool(model, params.name, args) : await generalTool(params.name, args),
      );
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  };
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    void handle(message).then(
      (result) =>
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n"),
      (error: unknown) =>
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }) + "\n",
        ),
    );
  }
}
