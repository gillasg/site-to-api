import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { Exchange } from "../types.js";

// mitmproxy's flow files: a stream of tnetstrings, one dictionary per flow.

type TValue = null | boolean | number | Buffer | TValue[] | Map<string, TValue>;

function parseOne(data: Buffer, start: number): { value: TValue; next: number } {
  const colon = data.indexOf(0x3a, start);
  if (colon < 0) throw new Error("Not a mitmproxy flow file");
  const length = Number(data.subarray(start, colon).toString("latin1"));
  if (!Number.isInteger(length)) throw new Error("Not a mitmproxy flow file");
  const body = data.subarray(colon + 1, colon + 1 + length);
  const type = String.fromCharCode(data[colon + 1 + length] ?? 0);
  return { value: decode(type, body), next: colon + 2 + length };
}

function decode(type: string, body: Buffer): TValue {
  if (type === "," || type === ";") return body;
  if (type === "#") return Number(body.toString("latin1"));
  if (type === "^") return Number(body.toString("latin1"));
  if (type === "!") return body.toString("latin1") === "true";
  if (type === "~") return null;
  const items: TValue[] = [];
  for (let at = 0; at < body.length;) {
    const { value, next } = parseOne(body, at);
    items.push(value);
    at = next;
  }
  if (type === "]") return items;
  if (type === "}") {
    const map = new Map<string, TValue>();
    for (let i = 0; i + 1 < items.length; i += 2) map.set(text(items[i]), items[i + 1] ?? null);
    return map;
  }
  throw new Error(`Unknown tnetstring type ${type}`);
}

function text(value: TValue | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value == null ? "" : String(value);
}

function field(map: TValue | undefined, key: string): TValue | undefined {
  return map instanceof Map ? map.get(key) : undefined;
}

function headers(value: TValue | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(value)) return result;
  for (const pair of value) {
    if (!Array.isArray(pair)) continue;
    const name = text(pair[0]).toLowerCase();
    result[name] = result[name] ? `${result[name]}, ${text(pair[1])}` : text(pair[1]);
  }
  return result;
}

function decompress(content: Buffer, encoding: string | undefined): Buffer {
  try {
    if (encoding === "gzip") return gunzipSync(content);
    if (encoding === "br") return brotliDecompressSync(content);
    if (encoding === "deflate") return inflateSync(content);
  } catch {
    return content;
  }
  return content;
}

function url(request: TValue): string {
  const scheme = text(field(request, "scheme")) || "https";
  const host = text(field(request, "host"));
  const port = Number(field(request, "port") ?? 0);
  const standard = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  return `${scheme}://${host}${port && !standard ? `:${port}` : ""}${text(field(request, "path"))}`;
}

function toExchange(flow: TValue, index: number, source: string): Exchange | undefined {
  const request = field(flow, "request");
  const response = field(flow, "response");
  if (!request || !response) return undefined;
  const requestHeaders = headers(field(request, "headers"));
  const responseHeaders = headers(field(response, "headers"));
  const content = field(response, "content");
  const body = Buffer.isBuffer(content)
    ? decompress(content, responseHeaders["content-encoding"])
    : undefined;
  const requestContent = field(request, "content");
  const exchange: Exchange = {
    id: `${source}#${index}`,
    source,
    startedAt: Number(field(request, "timestamp_start") ?? index) * 1000,
    method: text(field(request, "method")).toUpperCase(),
    url: url(request),
    requestHeaders,
    status: Number(field(response, "status_code") ?? 0),
    responseHeaders,
  };
  if (responseHeaders["content-type"]) exchange.responseMime = responseHeaders["content-type"];
  if (body) exchange.responseBody = body.toString("utf8");
  if (Buffer.isBuffer(requestContent) && requestContent.length)
    exchange.requestBody = requestContent.toString("utf8");
  if (requestHeaders.referer) exchange.pageUrl = requestHeaders.referer;
  return exchange;
}

export function fromMitmproxy(data: Buffer, source: string): Exchange[] {
  const exchanges: Exchange[] = [];
  for (let at = 0, index = 0; at < data.length; index++) {
    while (at < data.length && (data[at] === 0x0a || data[at] === 0x0d)) at++;
    if (at >= data.length) break;
    const { value, next } = parseOne(data, at);
    at = next;
    if (text(field(value, "type")) !== "http") continue;
    const exchange = toExchange(value, index, source);
    if (exchange) exchanges.push(exchange);
  }
  return exchanges;
}

/** Writes flows in the same format, for tests and for handing captures to mitmproxy tools. */
export function encodeTnetstring(value: unknown): Buffer {
  const wrap = (body: Buffer, type: string) =>
    Buffer.concat([Buffer.from(`${body.length}:`), body, Buffer.from(type)]);
  if (value === null || value === undefined) return wrap(Buffer.alloc(0), "~");
  if (typeof value === "boolean") return wrap(Buffer.from(String(value)), "!");
  if (typeof value === "number")
    return wrap(Buffer.from(String(value)), Number.isInteger(value) ? "#" : "^");
  if (typeof value === "string") return wrap(Buffer.from(value), ";");
  if (Buffer.isBuffer(value)) return wrap(value, ",");
  if (Array.isArray(value)) return wrap(Buffer.concat(value.map(encodeTnetstring)), "]");
  const parts = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    encodeTnetstring(key),
    encodeTnetstring(item),
  ]);
  return wrap(Buffer.concat(parts), "}");
}
