import { createInterface } from "node:readline";
import { listSites, loadModel, siteName } from "./registry.js";
import { siteApi, type SiteApi, type SiteApiOptions } from "./runtime/site-api.js";
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

function siteTools(model: SiteModel): Json[] {
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
  return [...ops, ...pages];
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
  const siteTool = async (current: SiteModel, name: unknown, args: Json): Promise<unknown> => {
    const ids = [...current.operations.map((op) => op.id), ...current.pages.map((p) => p.id)];
    const id = ids.find((item) => toolName(item) === name);
    if (!id) throw new Error(`Unknown tool ${String(name)}`);
    return callTool(await api(current.site), id, args);
  };
  const generalTool = async (name: unknown, args: Json): Promise<unknown> => {
    if (name === "list_sites") return listSites();
    if (name === "list_operations") {
      const found = await loadModel(String(args.site));
      if (!found) throw new Error(`${String(args.site)} is not mapped`);
      return siteTools(found).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input: tool.inputSchema,
      }));
    }
    if (name !== "call_operation") throw new Error(`Unknown tool ${String(name)}`);
    const maxItems = typeof args.maxItems === "number" ? { maxItems: args.maxItems } : {};
    return callTool(await api(String(args.site)), String(args.operation), {
      ...((args.params as Json | undefined) ?? {}),
      ...maxItems,
    });
  };
  const handle = async (message: Json): Promise<unknown> => {
    const params = (message.params ?? {}) as Json;
    if (message.method === "initialize") return initializeResult(params, model);
    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools: model ? siteTools(model) : GENERAL_TOOLS };
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
