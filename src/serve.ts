import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { htmlReport } from "./emit/html.js";
import { generateClient } from "./emit/client.js";
import { toAsyncApi, toOpenApi } from "./emit/openapi.js";
import { toYaml } from "./emit/yaml.js";
import { listSites, loadModel, readOverrides, siteName } from "./registry.js";
import { HttpError, siteApi, type SiteApi, type SiteApiOptions } from "./runtime/site-api.js";
import type { Operation, Overrides, SiteModel } from "./types.js";

// A local REST server for every mapped site, on 127.0.0.1 only:
//   GET  /                                   sites and their docs
//   GET  /sites/<site>/docs                  interactive docs (try calls live)
//   GET  /sites/<site>/openapi.json|yaml     the spec, with this server as its base URL
//   POST /sites/<site>/ops/<operationId>     call an operation with JSON parameters
//   ANY  /sites/<site>/api/<original path>   the site's own paths, proxied through the runtime
// Calls need the token printed at start (header x-site-to-api-token): they act as the user.

export interface ServeOptions extends SiteApiOptions {
  port?: number;
  token?: string;
}

export interface Server {
  url: string;
  token: string;
  close(): Promise<void>;
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 5_000_000) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function matchPath(
  operation: Operation,
  method: string,
  path: string,
): Record<string, string> | undefined {
  if (operation.method !== method) return undefined;
  const pattern = operation.path.split("/");
  const parts = path.split("/");
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const name = /^\{(.+)\}$/.exec(pattern[i] ?? "")?.[1];
    if (name) params[name] = decodeURIComponent(parts[i] ?? "");
    else if (pattern[i] !== parts[i]) return undefined;
  }
  return params;
}

function indexPage(sites: { site: string; operations: number; updated: string }[]): string {
  const rows = sites
    .map(
      (s) =>
        `<li><a href="/sites/${encodeURIComponent(s.site)}/docs">${s.site}</a> <span>${s.operations} operations, updated ${s.updated.slice(0, 10)}</span></li>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mapped sites</title>
<style>:root{--bg:#fbfbfa;--text:#1d1d1f;--muted:#6b6b70}@media(prefers-color-scheme:dark){:root{--bg:#141416;--text:#ececef;--muted:#9a9aa2}}body{background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}a{color:inherit;font-weight:600}span{color:var(--muted);margin-left:8px}</style>
<h1>Mapped sites</h1><ul>${rows || "<li>None yet. Run <code>site-to-api record &lt;url&gt;</code>.</li>"}</ul>
<script>if(location.hash.startsWith('#token=')){for(const a of document.querySelectorAll('a'))a.href+=location.hash;}</script>`;
}

interface Ctx {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  parts: string[];
  base: string;
}

interface SiteCtx extends Ctx {
  site: string;
  model: SiteModel;
  overrides: Overrides;
}

/** Docs, specs and the client: readable without the token (no calls are made). */
function publicFile(ctx: SiteCtx): boolean {
  const { response, model, overrides, site, base } = ctx;
  const what = ctx.parts[2];
  const root = `${base}/sites/${encodeURIComponent(site)}`;
  if (what === "docs")
    send(response, 200, htmlReport(model, overrides.redact, { endpoint: root }), "text/html");
  else if (what === "openapi.json" || what === "openapi.yaml") {
    const doc = toOpenApi(model, overrides.redact);
    doc.servers = [{ url: `${root}/api` }];
    if (what.endsWith("json")) send(response, 200, doc);
    else send(response, 200, toYaml(doc), "application/yaml");
  } else if (what === "asyncapi.yaml")
    send(response, 200, toYaml(toAsyncApi(model) ?? {}), "application/yaml");
  else if (what === "client.ts") send(response, 200, generateClient(model), "text/plain");
  else return false;
  return true;
}

async function callOperation(ctx: SiteCtx, client: SiteApi, id: string): Promise<void> {
  const params =
    ctx.request.method === "GET"
      ? Object.fromEntries(ctx.url.searchParams)
      : await readBody(ctx.request);
  const data = client.pageEndpoint(id)
    ? await client.fetchPage(id, params as Record<string, string>)
    : await client.call(id, params);
  send(ctx.response, 200, data);
}

/** The site's own paths under /api, mapped onto its operations. */
async function proxyPath(ctx: SiteCtx, client: SiteApi): Promise<boolean> {
  const method = ctx.request.method ?? "GET";
  const path = "/" + ctx.parts.slice(3).map(encodeURIComponent).join("/");
  for (const operation of ctx.model.operations) {
    const pathParams = matchPath(operation, method, path);
    if (!pathParams) continue;
    const body = method === "GET" || method === "HEAD" ? {} : await readBody(ctx.request);
    const result = await client.request(operation.id, {
      ...Object.fromEntries(ctx.url.searchParams),
      ...pathParams,
      ...(Object.keys(body).length ? { body } : {}),
    });
    const json = result.json !== undefined;
    send(
      ctx.response,
      result.status,
      result.json ?? result.text ?? "",
      json ? "application/json" : "text/plain",
    );
    return true;
  }
  return false;
}

function allowedHost(request: IncomingMessage): boolean {
  const host = request.headers.host ?? "";
  const origin = request.headers.origin;
  // Pages on other sites may not call in; browser extensions may (calls still need the token).
  const allowedOrigin =
    !origin || origin === `http://${host}` || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  return /^(127\.0\.0\.1|localhost):\d+$/.test(host) && allowedOrigin;
}

export async function serve(options: ServeOptions = {}): Promise<Server> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const apis = new Map<string, Promise<SiteApi>>();
  const api = (site: string) => {
    if (!apis.has(site)) apis.set(site, siteApi(site, options));
    return apis.get(site) as Promise<SiteApi>;
  };
  let base = "";
  const authorized = (request: IncomingMessage) => {
    const given = Buffer.from(String(request.headers["x-site-to-api-token"] ?? ""));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  async function siteRoute(ctx: Ctx, name: string): Promise<void> {
    const site = siteName(name);
    const model = await loadModel(site);
    if (!model) return send(ctx.response, 404, { error: `${site} is not mapped` });
    const siteCtx: SiteCtx = { ...ctx, site, model, overrides: await readOverrides(site) };
    if (publicFile(siteCtx)) return;
    if (!authorized(ctx.request))
      return send(ctx.response, 401, { error: "Missing or wrong x-site-to-api-token" });
    const client = await api(site);
    const [, , what, id] = ctx.parts;
    if (what === "ops" && id) return callOperation(siteCtx, client, id);
    if (what === "api" && (await proxyPath(siteCtx, client))) return;
    send(ctx.response, 404, { error: "Not found" });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHost(request)) return send(response, 403, { error: "Forbidden" });
    const url = new URL(request.url ?? "/", base);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const ctx: Ctx = { request, response, url, parts, base };
    if (!parts.length) return send(response, 200, indexPage(await listSites()), "text/html");
    if (parts[0] !== "sites") return send(response, 404, { error: "Not found" });
    if (!parts[1]) return send(response, 200, await listSites());
    return siteRoute(ctx, parts[1]);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? 502 : 500;
      send(response, status, {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof HttpError ? { upstream: error.response } : {}),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
