import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Exchange } from "../types.js";
import { decodeBodies, fromHar } from "./har.js";
import { fromMitmproxy } from "./mitmproxy.js";

export { fromHar, headerMap } from "./har.js";
export { encodeTnetstring, fromMitmproxy } from "./mitmproxy.js";

/** Reads one capture: HAR (from any tool), a raw entry list, or a mitmproxy flow file. */
export async function loadCapture(path: string, source = basename(path)): Promise<Exchange[]> {
  const data = await readFile(path);
  return parseCapture(data, source);
}

export function parseCapture(data: Buffer | string, source: string): Exchange[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const head = buffer.subarray(0, 64).toString("utf8").trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    const har = Array.isArray(parsed) ? { log: { entries: parsed } } : parsed;
    return decodeBodies(fromHar(har, source));
  }
  return fromMitmproxy(buffer, source);
}

/** Several captures merged in time order; identical requests recorded twice count once. */
export function mergeCaptures(captures: Exchange[][]): Exchange[] {
  const seen = new Set<string>();
  const merged: Exchange[] = [];
  for (const exchange of captures.flat().sort((a, b) => a.startedAt - b.startedAt)) {
    const key = `${exchange.startedAt}|${exchange.method}|${exchange.url}|${exchange.requestBody ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(exchange);
  }
  return merged;
}
