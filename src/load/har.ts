import type { Exchange, Frame, Initiator, SseMessage } from "../types.js";

// HAR 1.2 from any tool (DevTools, proxies, browser-use-extension), plus the private
// fields the recorders add: _resourceType, _initiator, _webSocketMessages, _eventSourceMessages.

type HarHeader = { name: string; value: string };
interface HarEntry {
  startedDateTime?: string;
  _resourceType?: string;
  _initiator?: Initiator;
  _webSocketMessages?: {
    type?: string;
    direction?: string;
    time?: number;
    at?: number;
    opcode?: number;
    data: string;
  }[];
  _eventSourceMessages?: SseMessage[];
  request: {
    method: string;
    url: string;
    headers?: HarHeader[];
    postData?: { text?: string; params?: { name: string; value?: string }[]; mimeType?: string };
  };
  response: {
    status: number;
    headers?: HarHeader[];
    content?: { mimeType?: string; text?: string; encoding?: string };
  };
  pageref?: string;
}

export function headerMap(headers: HarHeader[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { name, value } of headers ?? []) {
    if (name.startsWith(":")) continue;
    const key = name.toLowerCase();
    map[key] = map[key] !== undefined && key !== "cookie" ? `${map[key]}, ${value}` : value;
  }
  return map;
}

function requestBody(entry: HarEntry): string | undefined {
  const post = entry.request.postData;
  if (!post) return undefined;
  if (post.text !== undefined) return post.text;
  if (post.params)
    return new URLSearchParams(post.params.map((p) => [p.name, p.value ?? ""])).toString();
  return undefined;
}

function frames(entry: HarEntry): Frame[] | undefined {
  const raw = entry._webSocketMessages;
  if (!raw) return undefined;
  return raw.map((frame) => ({
    direction: frame.direction === "sent" || frame.type === "send" ? "sent" : "received",
    at: frame.at ?? (frame.time ?? 0) * 1000,
    opcode: frame.opcode ?? 1,
    data: frame.data,
  }));
}

function resourceType(entry: HarEntry): string | undefined {
  const type = entry._resourceType?.toLowerCase();
  if (type) return type;
  if (entry._webSocketMessages) return "websocket";
  return undefined;
}

export function fromHar(har: unknown, source: string): Exchange[] {
  const entries = ((har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? []) as HarEntry[];
  return entries.map((entry, index) => {
    const content = entry.response.content ?? {};
    const exchange: Exchange = {
      id: `${source}#${index}`,
      source,
      startedAt: entry.startedDateTime ? Date.parse(entry.startedDateTime) : index,
      method: entry.request.method.toUpperCase(),
      url: entry.request.url,
      requestHeaders: headerMap(entry.request.headers),
      status: entry.response.status,
      responseHeaders: headerMap(entry.response.headers),
    };
    const type = resourceType(entry);
    if (type) exchange.resourceType = type;
    const body = requestBody(entry);
    if (body !== undefined) exchange.requestBody = body;
    if (content.mimeType) exchange.responseMime = content.mimeType;
    if (content.text !== undefined) {
      exchange.responseBody = content.text;
      if (content.encoding === "base64") exchange.responseBase64 = true;
    }
    if (entry._initiator) exchange.initiator = entry._initiator;
    const wsFrames = frames(entry);
    if (wsFrames) exchange.frames = wsFrames;
    if (entry._eventSourceMessages) exchange.messages = entry._eventSourceMessages;
    const referer = exchange.requestHeaders.referer;
    if (referer) exchange.pageUrl = referer;
    return exchange;
  });
}

/** Decodes a base64 body that is really text (JSON or HTML), leaving binary bodies alone. */
export function decodeBodies(exchanges: Exchange[]): Exchange[] {
  for (const exchange of exchanges) {
    if (!exchange.responseBase64 || exchange.responseBody === undefined) continue;
    if (!/json|text|html|xml|javascript|graphql/i.test(exchange.responseMime ?? "")) continue;
    exchange.responseBody = Buffer.from(exchange.responseBody, "base64").toString("utf8");
    delete exchange.responseBase64;
  }
  return exchanges;
}
