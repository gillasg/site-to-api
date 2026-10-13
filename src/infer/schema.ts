import type { JsonSchema } from "../types.js";

// JSON Schema inference over many samples: a property is required only when every sample has
// it, mixed types become unions, short repeated strings become enums, and known string shapes
// become formats. Objects keyed by ids become maps.

export interface Accumulator {
  count: number;
  types: Map<string, number>;
  objects: number;
  props: Map<string, Accumulator>;
  presence: Map<string, number>;
  items?: Accumulator;
  strings: Map<string, number>;
  stringCount: number;
  formats: Map<string, number>;
  min?: number;
  max?: number;
}

const FORMATS: [string, RegExp][] = [
  ["date-time", /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["email", /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i],
  ["uri", /^(https?|wss?):\/\/[^\s]+$/i],
  ["ipv4", /^(\d{1,3}\.){3}\d{1,3}$/],
];

const MAX_DISTINCT = 64;

export function accumulator(): Accumulator {
  return {
    count: 0,
    types: new Map(),
    objects: 0,
    props: new Map(),
    presence: new Map(),
    strings: new Map(),
    stringCount: 0,
    formats: new Map(),
  };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function observe(acc: Accumulator, value: unknown): void {
  acc.count++;
  const type = typeOf(value);
  bump(acc.types, type);
  if (type === "object") observeObject(acc, value as Record<string, unknown>);
  else if (type === "array") {
    acc.items ??= accumulator();
    for (const item of (value as unknown[]).slice(0, 200)) observe(acc.items, item);
  } else if (type === "string") observeString(acc, value as string);
  else if (type === "integer" || type === "number") {
    const number = value as number;
    acc.min = acc.min === undefined ? number : Math.min(acc.min, number);
    acc.max = acc.max === undefined ? number : Math.max(acc.max, number);
  }
}

function observeObject(acc: Accumulator, value: Record<string, unknown>): void {
  acc.objects++;
  for (const [key, item] of Object.entries(value)) {
    if (!acc.props.has(key)) {
      if (acc.props.size >= 400) continue;
      acc.props.set(key, accumulator());
    }
    bump(acc.presence, key);
    observe(acc.props.get(key) as Accumulator, item);
  }
}

function observeString(acc: Accumulator, value: string): void {
  acc.stringCount++;
  if (acc.strings.size < MAX_DISTINCT || acc.strings.has(value)) bump(acc.strings, value);
  const format = FORMATS.find(([, pattern]) => pattern.test(value))?.[0];
  if (format) bump(acc.formats, format);
}

export function inferSchema(values: unknown[]): JsonSchema {
  const acc = accumulator();
  for (const value of values) observe(acc, value);
  return toSchema(acc);
}

const ID_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,})$/i;

/** Objects whose keys are ids (`{"1042": {...}, "1043": {...}}`) are maps, not fixed records. */
function isMap(acc: Accumulator): boolean {
  const keys = [...acc.props.keys()];
  if (keys.length < 4) return false;
  return keys.filter((key) => ID_KEY.test(key)).length / keys.length >= 0.8;
}

export function toSchema(acc: Accumulator): JsonSchema {
  const types = [...acc.types.keys()];
  if (types.includes("integer") && types.includes("number"))
    types.splice(types.indexOf("integer"), 1);
  const nullable = types.includes("null");
  const concrete = types.filter((type) => type !== "null");
  if (concrete.length === 0) return nullable ? { type: "null" } : {};
  const schemas = concrete.map((type) => schemaFor(type, acc));
  if (schemas.length === 1) {
    const only = schemas[0] as JsonSchema;
    if (nullable) only.type = [only.type, "null"];
    return only;
  }
  const primitive = schemas.every((schema) => Object.keys(schema).length === 1);
  if (primitive) return { type: [...concrete, ...(nullable ? ["null"] : [])] };
  return { anyOf: [...schemas, ...(nullable ? [{ type: "null" }] : [])] };
}

function schemaFor(type: string, acc: Accumulator): JsonSchema {
  if (type === "object") return objectSchema(acc);
  if (type === "array") return { type: "array", items: acc.items ? toSchema(acc.items) : {} };
  if (type === "string") return stringSchema(acc);
  return { type };
}

function objectSchema(acc: Accumulator): JsonSchema {
  if (isMap(acc)) {
    const merged = accumulator();
    for (const child of acc.props.values()) mergeInto(merged, child);
    return { type: "object", additionalProperties: toSchema(merged) };
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of acc.props) {
    properties[key] = toSchema(child);
    if ((acc.presence.get(key) ?? 0) === acc.objects) required.push(key);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function stringSchema(acc: Accumulator): JsonSchema {
  const schema: JsonSchema = { type: "string" };
  const [format, hits] = [...acc.formats.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (format && hits === acc.stringCount) schema.format = format;
  const distinct = [...acc.strings.keys()];
  const enumLike =
    !schema.format &&
    acc.stringCount >= 5 &&
    distinct.length <= 8 &&
    distinct.length < acc.stringCount &&
    distinct.every((value) => value.length > 0 && value.length <= 40 && !/\s{2,}/.test(value));
  if (enumLike) schema.enum = distinct.sort();
  return schema;
}

function addCounts<K>(target: Map<K, number>, source: Map<K, number>, limit = Infinity): void {
  for (const [key, value] of source)
    if (target.size < limit || target.has(key)) target.set(key, (target.get(key) ?? 0) + value);
}

function mergeRange(target: Accumulator, source: Accumulator): void {
  if (source.min !== undefined) target.min = Math.min(target.min ?? source.min, source.min);
  if (source.max !== undefined) target.max = Math.max(target.max ?? source.max, source.max);
}

/** Folds one accumulator into another (used to merge map values). */
export function mergeInto(target: Accumulator, source: Accumulator): void {
  target.count += source.count;
  target.objects += source.objects;
  target.stringCount += source.stringCount;
  addCounts(target.types, source.types);
  addCounts(target.strings, source.strings, MAX_DISTINCT);
  addCounts(target.formats, source.formats);
  addCounts(target.presence, source.presence);
  for (const [key, child] of source.props) {
    if (!target.props.has(key)) target.props.set(key, accumulator());
    mergeInto(target.props.get(key) as Accumulator, child);
  }
  if (source.items) mergeInto((target.items ??= accumulator()), source.items);
  mergeRange(target, source);
}

/** The top-level key set of a JSON value: how responses are told apart by shape. */
export function shapeKey(value: unknown): string {
  if (Array.isArray(value)) return "[" + shapeKey(value[0]) + "]";
  if (value && typeof value === "object") return Object.keys(value).sort().join(",");
  return typeOf(value);
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = new Set(a.split(","));
  const right = new Set(b.split(","));
  const shared = [...left].filter((key) => right.has(key)).length;
  return shared / (left.size + right.size - shared || 1);
}

export function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text
    .trim()
    .replace(/^\)\]\}',?\s*/, "")
    .replace(/^for\s*\(;;\);/, "");
  if (!trimmed || !/^[[{"\d-]|^(true|false|null)$/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Every leaf value in a JSON document with its JSON pointer. */
export function* leaves(value: unknown, pointer = ""): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 200); i++)
      yield* leaves(value[i], `${pointer}/${i}`);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      yield* leaves(item, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  } else yield [pointer, value];
}

export function getPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Replaces array indexes with `*` so pointers from different samples line up. */
export function generalize(pointer: string): string {
  return pointer.replace(/\/\d+(?=\/|$)/g, "/*");
}
