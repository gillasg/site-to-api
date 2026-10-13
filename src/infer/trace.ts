import type { Dependency, Exchange, Operation } from "../types.js";
import type { Member } from "./operations.js";
import { generalize, leaves } from "./schema.js";
import { extractEmbedded, hiddenInputs, metaTags } from "./html.js";

// Deterministic value tracing: for every value a request sends, find the earlier response,
// cookie, page tag or storage entry it came from. What can't be traced but changes every call
// (UUIDs, timestamps, nonces) is marked as made up by the client.

type Source = Dependency["source"];

interface Producer {
  at: number;
  source: Source;
}

export interface StorageSnapshot {
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface TraceInput {
  members: { operation: Operation; members: Member[] }[];
  documents: { pageId: string; exchange: Exchange }[];
  storage?: StorageSnapshot;
}

function distinctive(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) >= 1000)
    return String(value);
  if (typeof value !== "string") return undefined;
  if (value.length < 4 || value.length > 4000) return undefined;
  if (
    /^(true|false|null|undefined|none|asc|desc|json|html|en|en-us|default|application\/json)$/i.test(
      value,
    )
  )
    return undefined;
  if (/^[a-z]{4,8}$/.test(value) && !/\d/.test(value)) return undefined;
  return value;
}

class ValueIndex {
  private readonly producers = new Map<string, Producer[]>();

  add(value: unknown, at: number, source: Source): void {
    const key = distinctive(value);
    if (!key) return;
    const list = this.producers.get(key) ?? [];
    if (list.length < 20) list.push({ at, source });
    this.producers.set(key, list);
    // Bearer tokens and similar arrive with a prefix the response did not have.
    if (key.length > 24 && key.includes(" ")) this.add(key.split(" ").pop(), at, source);
  }

  find(value: string, before: number): Source | undefined {
    const candidates = (this.producers.get(value) ?? []).filter(
      (producer) => producer.at <= before,
    );
    return candidates.sort((a, b) => b.at - a.at)[0]?.source;
  }
}

function cookies(header: string | undefined): [string, string][] {
  return (header ?? "")
    .split(/;\s*/)
    .filter((pair) => pair.includes("="))
    .map((pair) => [
      pair.slice(0, pair.indexOf("=")),
      decodeURIComponentSafe(pair.slice(pair.indexOf("=") + 1)),
    ]);
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const VALUE_HEADER = /^x-|token|csrf/i;
const PLUMBING_HEADER = /^x-(cache|served|powered|frame|content|xss|request-id|amz-cf|timer)/i;

function indexMember(index: ValueIndex, operationId: string, member: Member): void {
  const at = member.exchange.startedAt;
  if (member.json !== undefined)
    for (const [pointer, value] of leaves(member.json))
      index.add(value, at, { kind: "response", operationId, pointer: generalize(pointer) });
  for (const [header, value] of Object.entries(member.exchange.responseHeaders))
    if (VALUE_HEADER.test(header) && !PLUMBING_HEADER.test(header))
      index.add(value, at, { kind: "response-header", operationId, header });
  for (const line of (member.exchange.responseHeaders["set-cookie"] ?? "").split(
    /\n|, (?=[^;]+=)/,
  )) {
    const [name, value] = cookies(line.split(";")[0])[0] ?? [];
    if (name && value) index.add(value, at, { kind: "cookie", name });
  }
}

function indexResponses(index: ValueIndex, input: TraceInput): void {
  for (const { operation, members } of input.members)
    for (const member of members) indexMember(index, operation.id, member);
}

function indexDocuments(index: ValueIndex, input: TraceInput): void {
  for (const { pageId, exchange } of input.documents) {
    const html = exchange.responseBody ?? "";
    const at = exchange.startedAt;
    for (const [name, value] of Object.entries(metaTags(html)))
      index.add(value, at, { kind: "meta", name, page: pageId });
    for (const [name, value] of Object.entries(hiddenInputs(html)))
      index.add(value, at, { kind: "input", name, page: pageId });
    const embedded = extractEmbedded(html);
    for (const [pointer, value] of leaves(embedded))
      index.add(value, at, { kind: "response", operationId: pageId, pointer: generalize(pointer) });
  }
}

function indexStorage(index: ValueIndex, storage: StorageSnapshot | undefined): void {
  for (const area of ["localStorage", "sessionStorage"] as const)
    for (const [key, raw] of Object.entries(storage?.[area] ?? {})) {
      index.add(raw, -1e15, { kind: "storage", storage: area, key });
      try {
        for (const [pointer, value] of leaves(JSON.parse(raw)))
          index.add(value, -1e15, { kind: "storage", storage: area, key, pointer });
      } catch {
        continue;
      }
    }
}

/** What people type: matching it to a response is coincidence, not a dependency. */
const FREE_TEXT =
  /^(q|query|term|search|keywords?|text|s|name|email|password|username|message|comment|body|title|description|address|phone)$/i;

const lastKey = (pointer: string) => pointer.split("/").pop() ?? "";

function bodyInputs(member: Member): [string, string][] {
  const body = member.graphql ? member.graphql.variables : member.body?.value;
  if (body === undefined) return [];
  const prefix = member.graphql ? "body:/variables" : "body:";
  const inputs: [string, string][] = [];
  for (const [pointer, value] of leaves(body))
    if (
      (typeof value === "string" || typeof value === "number") &&
      !FREE_TEXT.test(lastKey(pointer))
    )
      inputs.push([`${prefix}${generalize(pointer)}`, String(value)]);
  return inputs;
}

/** Everything a request sends, as target → value. */
export function inputsOf(member: Member, operation: Operation): [string, string][] {
  const inputs: [string, string][] = Object.entries(member.pathValues).map(([name, value]) => [
    `path:${name}`,
    value,
  ]);
  for (const [name, value] of new URL(member.exchange.url).searchParams)
    if (!FREE_TEXT.test(name)) inputs.push([`query:${name}`, value]);
  inputs.push(...bodyInputs(member));
  for (const [name, value] of Object.entries(member.exchange.requestHeaders))
    if (/^(authorization|x-.*)$/.test(name))
      inputs.push([`header:${name}`, value.replace(/^(Bearer|Token|Basic)\s+/i, "")]);
  for (const [name, value] of cookies(member.exchange.requestHeaders.cookie))
    if (/csrf|xsrf/i.test(name)) inputs.push([`cookie:${name}`, value]);
  if (operation.graphql?.hash) inputs.push(["graphql:hash", operation.graphql.hash]);
  return inputs;
}

function generator(
  values: string[],
  times: number[],
): "uuid" | "timestamp-ms" | "timestamp-s" | "nonce" | undefined {
  const varies = new Set(values).size === values.length;
  if (!varies) return undefined;
  if (
    values.every((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
  )
    return "uuid";
  const near = (value: number, at: number) => Math.abs(value - at) < 86_400_000;
  if (values.every((v, i) => /^\d{13}$/.test(v) && near(Number(v), times[i] ?? 0)))
    return "timestamp-ms";
  if (values.every((v, i) => /^\d{10}$/.test(v) && near(Number(v) * 1000, times[i] ?? 0)))
    return "timestamp-s";
  if (
    values.every(
      (v) => v.length >= 12 && /^[A-Za-z0-9+/=_-]+$/.test(v) && /\d/.test(v) && /[a-z]/i.test(v),
    )
  )
    return "nonce";
  return undefined;
}

interface TargetStats {
  total: number;
  sources: Map<string, { source: Source; count: number }>;
  values: string[];
  times: number[];
}

function sourceKey(source: Source): string {
  return JSON.stringify(source);
}

/** An operation's own response feeding its path is a list → item link, not a dependency. */
function selfPath(source: Source, operation: Operation, target: string): boolean {
  return (
    source.kind === "response" && source.operationId === operation.id && target.startsWith("path:")
  );
}

function collect(
  index: ValueIndex,
  operation: Operation,
  members: Member[],
): Map<string, TargetStats> {
  const counts = new Map<string, TargetStats>();
  for (const member of members)
    for (const [target, value] of inputsOf(member, operation)) {
      const entry: TargetStats = counts.get(target) ?? {
        total: 0,
        sources: new Map(),
        values: [],
        times: [],
      };
      entry.total++;
      entry.values.push(value);
      entry.times.push(member.exchange.startedAt);
      const source = index.find(value, member.exchange.startedAt - 0.001);
      if (source && !selfPath(source, operation, target)) {
        const hit = entry.sources.get(sourceKey(source)) ?? { source, count: 0 };
        hit.count++;
        entry.sources.set(sourceKey(source), hit);
      }
      counts.set(target, entry);
    }
  return counts;
}

function dependencyOf(
  operation: Operation,
  target: string,
  entry: TargetStats,
): Dependency | undefined {
  const best = [...entry.sources.values()].sort((a, b) => b.count - a.count)[0];
  if (best && best.count / entry.total >= 0.5)
    return { target, source: best.source, confidence: round(best.count / entry.total) };
  const made = generator(entry.values, entry.times);
  if (!made || (entry.total < 2 && made === "nonce")) return undefined;
  const param = operation.params.find((p) => `${p.in}:${p.name}` === target);
  if (param) param.generated = made;
  return { target, source: { kind: "generated", generator: made }, confidence: 1 };
}

export function traceDependencies(input: TraceInput): void {
  const index = new ValueIndex();
  indexResponses(index, input);
  indexDocuments(index, input);
  indexStorage(index, input.storage);
  for (const { operation, members } of input.members) {
    operation.dependencies = [];
    for (const [target, entry] of collect(index, operation, members)) {
      const dependency = dependencyOf(operation, target, entry);
      if (dependency) operation.dependencies.push(dependency);
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
