// The data model shared by every stage: recorded exchanges in, a site model out.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** A JSON Schema (2020-12 subset) as emitted into OpenAPI 3.1. */
export type JsonSchema = { [key: string]: unknown };

export interface Initiator {
  type: string;
  url?: string;
  stack?: { url: string; functionName: string; line: number }[];
}

export interface Frame {
  direction: "sent" | "received";
  at: number;
  opcode?: number;
  data: string;
}

export interface SseMessage {
  at: number;
  event: string;
  data: string;
}

/** One recorded request and its response, normalised from HAR, mitmproxy or a live capture. */
export interface Exchange {
  id: string;
  /** Which capture file or flow it came from. */
  source: string;
  startedAt: number;
  method: string;
  url: string;
  /** Lower-case resource type when the recorder knew it: xhr, fetch, document, websocket… */
  resourceType?: string;
  /** Header names are lower-case. */
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseMime?: string;
  responseBody?: string;
  responseBase64?: boolean;
  initiator?: Initiator;
  frames?: Frame[];
  messages?: SseMessage[];
  /** The page that made the request, when known. */
  pageUrl?: string;
}

export type Category = "api" | "document" | "channel" | "auth";

export interface Param {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: JsonSchema;
  /** A value that was the same in every sample. */
  constant?: string;
  /** Values the client makes up itself: fresh ones are generated on every call. */
  generated?: "uuid" | "timestamp-ms" | "timestamp-s" | "nonce";
  examples?: string[];
}

export interface Dependency {
  /** Where the value goes: `path:productId`, `query:cursor`, `body:/items/0/id`, `header:x-csrf-token`. */
  target: string;
  /** Where it came from: an earlier operation's response, a cookie, a page's meta tag… */
  source:
    | { kind: "response"; operationId: string; pointer: string }
    | { kind: "response-header"; operationId: string; header: string }
    | { kind: "cookie"; name: string }
    | { kind: "meta"; name: string; page: string }
    | { kind: "input"; name: string; page: string }
    | { kind: "storage"; storage: "localStorage" | "sessionStorage"; key: string; pointer?: string }
    | { kind: "generated"; generator: "uuid" | "timestamp-ms" | "timestamp-s" | "nonce" };
  /** Share of samples where the value was traced to this source. */
  confidence: number;
}

export interface Pagination {
  style: "cursor" | "offset" | "page" | "link";
  /** The request parameter that moves to the next page (`body:/variables/after` for bodies). */
  param?: string;
  limitParam?: string;
  /** JSON pointer to the next cursor, next link, or "has more" flag in the response. */
  nextPointer?: string;
  /** `header:link` when the next link comes in a Link header. */
  nextHeader?: string;
  hasMorePointer?: string;
  totalPointer?: string;
  itemsPointer?: string;
}

export interface Signing {
  headers: string[];
  query: string[];
  /** The script frame that built the request, to find the signing code. */
  initiator?: { url: string; functionName: string; line: number };
  /** Make calls through the page's own XMLHttpRequest (its hooks sign them) or its fetch. */
  via: "fetch" | "xhr";
}

export interface Sample {
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  pageUrl?: string;
}

export interface Operation {
  id: string;
  summary?: string;
  description?: string;
  method: string;
  origin: string;
  /** Path template, e.g. /api/products/{productId}. */
  path: string;
  kind: "rest" | "graphql" | "jsonrpc" | "action";
  /** What tells this operation apart from others on the same path. */
  match?: {
    graphql?: { operationName?: string; hash?: string };
    rpcMethod?: string;
    field?: { in: "query" | "body"; name: string; value: string };
  };
  graphql?: { query?: string; hash?: string; operationName?: string; variablesPath: string };
  params: Param[];
  requestBody?: { mime: string; schema: JsonSchema; form?: boolean };
  responses: Record<string, { mime: string; schema?: JsonSchema }>;
  role: "read" | "action" | "auth";
  security: string[];
  pagination?: Pagination;
  dependencies: Dependency[];
  signing?: Signing;
  confidence: number;
  bucket: "high" | "medium" | "low";
  flags: string[];
  sampleCount: number;
  sources: string[];
  /** Pages the operation was called from: re-recording starts there. */
  pageUrls: string[];
  samples: Sample[];
}

export interface PageField {
  name: string;
  selector: string;
  type?: "text" | "html" | "attr" | "number" | "list";
  attr?: string;
}

/** A server-rendered page treated as an endpoint: its embedded data, or fields read with CSS. */
export interface PageEndpoint {
  id: string;
  origin: string;
  path: string;
  params: Param[];
  /** Which embedded data sources the page carries. */
  embedded: ("next" | "nuxt" | "apollo" | "redux" | "jsonld" | "json-script")[];
  schema?: JsonSchema;
  extractor?: { baseSelector?: string; fields: PageField[] };
  sampleCount: number;
  samples: string[];
}

export interface ChannelMessage {
  name: string;
  direction: "send" | "receive";
  schema?: JsonSchema;
  count: number;
}

/** A WebSocket or server-sent events stream. */
export interface Channel {
  id: string;
  kind: "websocket" | "sse";
  url: string;
  messages: ChannelMessage[];
}

export interface SecurityScheme {
  name: string;
  type: "cookie" | "bearer" | "basic" | "apiKey" | "csrf";
  in?: "header" | "query" | "cookie";
  /** Header, query or cookie name. */
  key?: string;
  bearerFormat?: string;
  /** Where the runtime finds the value. */
  source?:
    | { kind: "cookie"; name: string }
    | { kind: "meta"; name: string }
    | { kind: "response"; operationId: string; pointer: string }
    | { kind: "storage"; storage: "localStorage" | "sessionStorage"; key: string; pointer?: string }
    | { kind: "constant"; value: string };
  /** The operation that renews the token, and where the new one is in its response. */
  refresh?: { operationId: string; pointer: string };
  origins: string[];
}

export interface NoiseReport {
  url: string;
  reason: string;
  count: number;
}

export interface SiteModel {
  version: 1;
  site: string;
  title: string;
  generatedAt: string;
  origins: string[];
  security: SecurityScheme[];
  operations: Operation[];
  pages: PageEndpoint[];
  channels: Channel[];
  components: Record<string, JsonSchema>;
  noise: NoiseReport[];
  stats: { exchanges: number; kept: number; captures: string[] };
}

/** Hand edits that survive rebuilds. */
export interface Overrides {
  /** Path templates to force, e.g. "/api/items/{itemId}" or "https://cdn.example.com/v2/{slug}". */
  templates?: string[];
  /** Rename operations: generated id → new id. */
  names?: Record<string, string>;
  descriptions?: Record<string, string>;
  /** URL regexes to drop as noise. */
  noise?: string[];
  include?: string[];
  exclude?: string[];
  origins?: string[];
  redact?: { headers?: string[]; keys?: string[]; patterns?: string[] };
  /** CSS extractors that turn HTML pages into typed endpoints. */
  pages?: { id: string; url: string; baseSelector?: string; fields: PageField[] }[];
  /** In-page code that makes a signed call: `async (request) => ({ status, json })`. */
  signers?: Record<string, string>;
  /** Operations to drop entirely. */
  drop?: string[];
  /** Multi-step actions: one named call that runs several operations in order (runtime/actions.ts). */
  actions?: Record<
    string,
    { description?: string; steps: { operation: string; params?: Record<string, unknown> }[] }
  >;
}
