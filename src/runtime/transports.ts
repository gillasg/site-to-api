import { parseJson } from "../infer/schema.js";
import type { SecurityScheme } from "../types.js";
import { sharedBridge, type Bridge } from "./bridge.js";
import type { RuntimeRequest, RuntimeResponse } from "./request.js";
import { cookieHeader, storeSetCookies, type SessionFile } from "./session.js";

// Two ways to make a call:
// - page: inside one of the site's own tabs in the user's browser. Cookies, CORS, CSRF and any
//   signing the site's code adds to fetch or XMLHttpRequest all apply. Works behind every login.
// - direct: from Node with an exported session (or nothing, for public endpoints). Fast and
//   needs no browser, but signed requests and fresh logins need the page.

export interface CallContext {
  /** Security schemes the operation uses, resolved by the transport where possible. */
  auth: SecurityScheme[];
  /** The page the site makes this call from: the tab is opened there. */
  home: string;
  via?: "fetch" | "xhr";
  /** In-page code that makes the call itself: `async (request) => ({ status, json })`. */
  signer?: string;
}

export interface Transport {
  readonly name: "page" | "direct";
  send(request: RuntimeRequest, context: CallContext): Promise<RuntimeResponse>;
}

// Runs in the page. Resolves auth values the page holds (cookies, meta tags, storage), then
// calls with the page's own fetch or XMLHttpRequest so the site's hooks apply.
const PAGE_CALL = `async (req) => {
  const pointer = (value, path) => path.split('/').slice(1).reduce((v, k) => v == null ? v : v[k === '*' ? 0 : k.replace(/~1/g, '/').replace(/~0/g, '~')], value);
  const cookie = (name) => { const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '=')); return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined; };
  const headers = { ...req.headers };
  for (const auth of req.auth) {
    const s = auth.source; if (!s || headers[auth.key] !== undefined) continue;
    let value;
    if (s.kind === 'meta') value = document.querySelector('meta[name="' + s.name + '"],meta[property="' + s.name + '"]')?.content;
    else if (s.kind === 'cookie') value = cookie(s.name);
    else if (s.kind === 'constant') value = s.value;
    else if (s.kind === 'storage') { const raw = window[s.storage].getItem(s.key); if (raw != null) { if (s.pointer) { try { value = pointer(JSON.parse(raw), s.pointer); } catch {} } else value = raw; } }
    if (value == null || value === '') continue;
    if (auth.type === 'bearer') headers.authorization = /^bearer /i.test(value) ? value : 'Bearer ' + value;
    else if (auth.in === 'header' && auth.key) headers[auth.key] = String(value);
  }
  const forbidden = /^(cookie|cookie2|host|origin|referer|user-agent|content-length|connection|accept-encoding|sec-.*|proxy-.*|te|trailer|transfer-encoding|upgrade|via|keep-alive|date|dnt|expect)$/i;
  for (const name of Object.keys(headers)) if (forbidden.test(name)) delete headers[name];
  const request = { url: req.url, method: req.method, headers, body: req.body };
  if (req.signer) return await (SIGNER)(request);
  if (req.via === 'xhr') return await new Promise((resolve) => {
    const x = new XMLHttpRequest(); x.open(req.method, req.url, true); x.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) { try { x.setRequestHeader(k, v); } catch {} }
    x.onload = () => resolve({ status: x.status, url: x.responseURL, headers: Object.fromEntries(x.getAllResponseHeaders().trim().split(/\\r?\\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()])), text: x.responseText.slice(0, 8000000) });
    x.onerror = () => resolve({ status: 0, headers: {}, text: 'network error' });
    x.send(req.body ?? null);
  });
  const response = await fetch(req.url, { method: req.method, headers, body: req.body, credentials: 'include', redirect: 'follow' });
  return { status: response.status, url: response.url, headers: Object.fromEntries(response.headers), text: (await response.text()).slice(0, 8000000) };
}`;

export function pageCallExpression(request: RuntimeRequest, context: CallContext): string {
  const arg = {
    ...request,
    auth: context.auth,
    via: context.via ?? "fetch",
    signer: context.signer ? true : undefined,
  };
  const fn = PAGE_CALL.replace("(SIGNER)", `(${context.signer ?? "null"})`);
  return `(${fn})(${JSON.stringify(arg)})`;
}

function finish(raw: {
  status: number;
  headers?: Record<string, string>;
  text?: string;
  json?: unknown;
  url?: string;
}): RuntimeResponse {
  const response: RuntimeResponse = { status: raw.status, headers: raw.headers ?? {} };
  if (raw.url) response.url = raw.url;
  if (raw.json !== undefined) response.json = raw.json;
  else {
    const json = parseJson(raw.text);
    if (json !== undefined) response.json = json;
    else if (raw.text !== undefined) response.text = raw.text;
  }
  return response;
}

/** Keeps one background tab per site page origin, opened on first use and reused after. */
export class PageTransport implements Transport {
  readonly name = "page" as const;

  constructor(
    private readonly bridge: () => Promise<Bridge> = sharedBridge,
    private readonly session = "site-to-api",
  ) {}

  /** Runs `expression` inside the site's tab for `home`, opening the tab when needed. */
  async inPage(home: string, expression: string, timeoutMs = 120_000): Promise<unknown> {
    const origin = new URL(home).origin;
    const code = `
const __store = (globalThis.__siteToApiTabs ??= {});
let __tab = __store[${JSON.stringify(origin)}];
if (__tab) { try { if ((await __tab.inspect(() => location.origin)) !== ${JSON.stringify(origin)}) __tab = undefined; } catch { __tab = undefined; } }
if (!__tab) { __tab = await browser.openTab(${JSON.stringify(home)}); __store[${JSON.stringify(origin)}] = __tab; }
await __tab.inspect(${JSON.stringify(expression)})`;
    return (await this.bridge()).run(code, { session: this.session, timeoutMs });
  }

  async send(request: RuntimeRequest, context: CallContext): Promise<RuntimeResponse> {
    const raw = (await this.inPage(
      context.home,
      pageCallExpression(request, context),
    )) as Parameters<typeof finish>[0];
    if (!raw || typeof raw.status !== "number") throw new Error("The page returned no response.");
    return finish(raw);
  }
}

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Plain HTTP from Node, with the user's exported cookies and browser-like headers. */
export class DirectTransport implements Transport {
  readonly name = "direct" as const;

  constructor(private session?: SessionFile) {}

  /** Swaps in a renewed session. */
  useSession(session: SessionFile): void {
    this.session = session;
  }

  private sessionValue(
    source: NonNullable<SecurityScheme["source"]>,
    home: string,
  ): string | undefined {
    if (source.kind === "constant") return source.value;
    if (source.kind === "cookie")
      return this.session?.cookies.find((c) => c.name === source.name)?.value;
    if (source.kind === "storage") return storageValue(this.session, new URL(home).origin, source);
    return undefined;
  }

  private authHeaders(context: CallContext, headers: Record<string, string>): void {
    for (const auth of context.auth) {
      if (!auth.source || !auth.key || headers[auth.key] !== undefined) continue;
      const value = this.sessionValue(auth.source, context.home);
      if (!value) continue;
      if (auth.type === "bearer")
        headers.authorization = /^bearer /i.test(value) ? value : `Bearer ${value}`;
      else if (auth.in === "header") headers[auth.key] = value;
    }
  }

  async send(request: RuntimeRequest, context: CallContext): Promise<RuntimeResponse> {
    const home = new URL(context.home);
    const headers: Record<string, string> = {
      "user-agent": this.session?.userAgent ?? BROWSER_USER_AGENT,
      accept: "application/json, text/plain, */*",
      "accept-language": this.session?.language ?? "en-US,en;q=0.9",
      origin: home.origin,
      referer: home.href,
      ...request.headers,
    };
    this.authHeaders(context, headers);
    const cookies = this.session ? cookieHeader(this.session, request.url) : "";
    if (cookies) headers.cookie = cookies;
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "follow",
    });
    if (this.session)
      storeSetCookies(this.session, request.url, response.headers.getSetCookie?.() ?? []);
    return finish({
      status: response.status,
      url: response.url,
      headers: Object.fromEntries(response.headers),
      text: await response.text(),
    });
  }
}

function storageValue(
  session: SessionFile | undefined,
  origin: string,
  source: { storage: "localStorage" | "sessionStorage"; key: string; pointer?: string },
): string | undefined {
  const raw = session?.[source.storage]?.[origin]?.[source.key];
  if (raw === undefined || !source.pointer) return raw;
  let value: unknown = parseJson(raw);
  for (const key of source.pointer.split("/").slice(1))
    value = (value as Record<string, unknown> | undefined)?.[key === "*" ? "0" : key];
  return value === undefined || value === null ? undefined : String(value);
}
