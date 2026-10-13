import type {
  Channel,
  ChannelMessage,
  Exchange,
  Overrides,
  PageEndpoint,
  Param,
} from "../types.js";
import type { Grouped } from "./operations.js";
import { embeddedKinds, extractEmbedded } from "./html.js";
import { inferSchema, parseJson } from "./schema.js";
import { camel, singular } from "./templates.js";

// Server-rendered pages become typed "page endpoints" (their embedded data, or fields read with
// CSS selectors), and WebSocket and SSE streams become channels with typed messages.

function pageName(path: string): string {
  const literals = path.split("/").filter((part) => part && !part.startsWith("{"));
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const noun = literals
    .slice(-2)
    .map((word, i, list) => (i === list.length - 1 && last.startsWith("{") ? singular(word) : word))
    .join(" ");
  return camel(`${noun || "home"} page`);
}

export function buildPages(documents: Grouped["documents"], overrides: Overrides): PageEndpoint[] {
  const groups = new Map<string, Grouped["documents"]>();
  for (const document of documents) {
    const key = document.origin + document.template;
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  const pages: PageEndpoint[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    if (!first) continue;
    const embedded = list.map((doc) => extractEmbedded(doc.member.exchange.responseBody ?? ""));
    const kinds = [...new Set(embedded.flatMap(embeddedKinds))];
    if (!kinds.length) continue;
    const params: Param[] = first.pathParams.map(({ name }) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
      examples: [...new Set(list.map((doc) => doc.member.pathValues[name] ?? ""))].slice(0, 3),
    }));
    pages.push({
      id: pageName(first.template),
      origin: first.origin,
      path: first.template,
      params,
      embedded: kinds,
      schema: inferSchema(embedded),
      sampleCount: list.length,
      samples: list.slice(0, 3).map((doc) => doc.member.exchange.url),
    });
  }
  for (const extractor of overrides.pages ?? []) pages.push(extractorPage(extractor));
  return pages;
}

function extractorPage(extractor: NonNullable<Overrides["pages"]>[number]): PageEndpoint {
  const url = new URL(extractor.url.replace(/\{/g, "%7B").replace(/\}/g, "%7D"));
  const path = decodeURIComponent(url.pathname);
  const params: Param[] = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1] as string,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const fields: Record<string, unknown> = {};
  for (const field of extractor.fields)
    fields[field.name] =
      field.type === "number"
        ? { type: ["number", "null"] }
        : field.type === "list"
          ? { type: "array", items: { type: "string" } }
          : { type: ["string", "null"] };
  const item = { type: "object", properties: fields };
  const page: PageEndpoint = {
    id: extractor.id,
    origin: url.origin,
    path,
    params,
    embedded: [],
    schema: extractor.baseSelector ? { type: "array", items: item } : item,
    extractor: {
      fields: extractor.fields,
      ...(extractor.baseSelector ? { baseSelector: extractor.baseSelector } : {}),
    },
    sampleCount: 0,
    samples: [],
  };
  return page;
}

const NAME_FIELDS = ["type", "event", "op", "action", "kind", "method", "channel", "t", "cmd"];

function messageName(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const field of NAME_FIELDS) {
      const name = record[field];
      if ((typeof name === "string" && name.length <= 60) || typeof name === "number")
        return `${field}:${String(name)}`;
    }
  }
  return fallback;
}

function channelUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
}

export function buildChannels(exchanges: Exchange[]): Channel[] {
  const channels = new Map<
    string,
    {
      kind: Channel["kind"];
      url: string;
      samples: Map<string, { direction: "send" | "receive"; values: unknown[]; count: number }>;
    }
  >();
  for (const exchange of exchanges) {
    const kind: Channel["kind"] = exchange.frames ? "websocket" : "sse";
    const url = channelUrl(exchange.url);
    const channel = channels.get(url) ?? { kind, url, samples: new Map() };
    const add = (direction: "send" | "receive", data: string, fallback: string) => {
      const value = parseJson(data);
      const name = messageName(value, fallback);
      const key = `${direction}|${name}`;
      const sample = channel.samples.get(key) ?? { direction, values: [], count: 0 };
      sample.count++;
      if (value !== undefined && sample.values.length < 200) sample.values.push(value);
      channel.samples.set(key, sample);
    };
    for (const frame of exchange.frames ?? [])
      add(frame.direction === "sent" ? "send" : "receive", frame.data, "message");
    for (const message of exchange.messages ?? [])
      add("receive", message.data, message.event || "message");
    channels.set(url, channel);
  }
  return [...channels.values()].map(({ kind, url, samples }) => {
    const path = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "stream";
    const messages: ChannelMessage[] = [...samples.entries()].map(([key, sample]) => {
      const message: ChannelMessage = {
        name: key.split("|")[1] as string,
        direction: sample.direction,
        count: sample.count,
      };
      if (sample.values.length) message.schema = inferSchema(sample.values);
      return message;
    });
    return { id: camel(`${path} ${kind === "sse" ? "events" : "socket"}`), kind, url, messages };
  });
}
