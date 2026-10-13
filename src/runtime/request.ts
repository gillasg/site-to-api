import { randomUUID, randomBytes } from "node:crypto";
import { parseJson } from "../infer/schema.js";
import type { Dependency, Operation, Param } from "../types.js";

// Builds a concrete request from an operation and the caller's parameters. The last recorded
// request is the template (so defaults the site expects are kept); caller values, fresh
// generated values and resolved dependencies replace what changes.

export interface RuntimeRequest {
  operationId: string;
  origin: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RuntimeResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  text?: string;
  url?: string;
}

export type Params = Record<string, unknown>;

/** Values for targets like `query:cursor` or `body:/variables/after`, set by pagination and dependency resolution. */
export const SET = "$set";

export function generate(kind: NonNullable<Param["generated"]>): string {
  if (kind === "uuid") return randomUUID();
  if (kind === "timestamp-ms") return String(Date.now());
  if (kind === "timestamp-s") return String(Math.floor(Date.now() / 1000));
  return randomBytes(12).toString("base64url");
}

export class MissingParams extends Error {
  constructor(
    operation: Operation,
    public readonly missing: string[],
  ) {
    super(`${operation.id} needs: ${missing.join(", ")}`);
    this.name = "MissingParams";
  }
}

function setPointer(target: unknown, pointer: string, value: unknown): unknown {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => (part === "*" ? "0" : part.replace(/~1/g, "/").replace(/~0/g, "~")));
  if (!parts.length) return value;
  const root = (
    target && typeof target === "object" ? target : /^\d+$/.test(parts[0] ?? "") ? [] : {}
  ) as Record<string, unknown>;
  let current = root;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) current[part] = value;
    else {
      const next = current[part];
      current[part] =
        next && typeof next === "object" ? next : /^\d+$/.test(parts[index + 1] ?? "") ? [] : {};
      current = current[part] as Record<string, unknown>;
    }
  });
  return root;
}

function lastSampleBody(operation: Operation): unknown {
  const raw = operation.samples[operation.samples.length - 1]?.requestBody;
  if (raw === undefined) return undefined;
  if (operation.requestBody?.form) return Object.fromEntries(new URLSearchParams(raw));
  return parseJson(raw);
}

function generatedTargets(operation: Operation): Map<string, NonNullable<Param["generated"]>> {
  const map = new Map<string, NonNullable<Param["generated"]>>();
  const signed = new Set([
    ...(operation.signing?.headers ?? []).map((h) => `header:${h}`),
    ...(operation.signing?.query ?? []).map((q) => `query:${q}`),
  ]);
  for (const dep of operation.dependencies)
    if (dep.source.kind === "generated" && !signed.has(dep.target))
      map.set(dep.target, dep.source.generator);
  return map;
}

function graphqlBody(body: unknown, params: Params, consumed: Set<string>): unknown {
  const record = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
  const base = record && typeof record === "object" ? record : {};
  consumed.add("variables");
  const recorded = (base.variables as object | undefined) ?? {};
  return {
    ...base,
    variables: { ...recorded, ...((params.variables as object | undefined) ?? {}) },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function bodyFor(operation: Operation, params: Params, consumed: Set<string>): unknown {
  let body = structuredClone(lastSampleBody(operation));
  if (operation.kind === "graphql") return graphqlBody(body, params, consumed);
  if (params.body !== undefined) {
    consumed.add("body");
    body = isRecord(body) && isRecord(params.body) ? { ...body, ...params.body } : params.body;
  }
  if (!isRecord(body)) return body;
  // Top-level body fields can be passed directly: api.addToCart({ productId: 7 }).
  const top = Object.keys((operation.requestBody?.schema.properties as object | undefined) ?? {});
  for (const key of top)
    if (params[key] !== undefined && !consumed.has(key)) {
      body[key] = params[key];
      consumed.add(key);
    }
  return body;
}

function serializeBody(operation: Operation, body: unknown): string | undefined {
  if (body === undefined) return operation.samples[operation.samples.length - 1]?.requestBody;
  if (operation.requestBody?.form)
    return new URLSearchParams(
      Object.entries(body as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ]),
    ).toString();
  return typeof body === "string" ? body : JSON.stringify(body);
}

/** Values that belong to the user's session (CSRF tokens, auth headers): never replayed from a recording. */
const SESSION_HEADER =
  /^(authorization|x-csrf-token|x-xsrf-token|csrf-token|x-xsrftoken|x-csrftoken)$/i;

type Resolved = { value?: string; missing?: boolean };

interface Inputs {
  params: Params;
  sets: Params;
  generated: Map<string, NonNullable<Param["generated"]>>;
}

function givenValue(param: Param, inputs: Inputs): string | undefined {
  const target = `${param.in}:${param.name}`;
  const value = inputs.sets[target] ?? inputs.params[param.name];
  if (value !== undefined && value !== null) return String(value);
  const made = inputs.generated.get(target) ?? param.generated;
  return made ? generate(made) : undefined;
}

function paramValue(operation: Operation, param: Param, inputs: Inputs): Resolved {
  const given = givenValue(param, inputs);
  if (given !== undefined) return { value: given };
  const target = `${param.in}:${param.name}`;
  const source = operation.dependencies.find((dep) => dep.target === target)?.source;
  // Fresh values come from the producing operation (resolved by the caller) or the session.
  if (source && source.kind !== "generated") return { missing: source.kind === "response" };
  return fallbackValue(param);
}

/** What to send when nobody passed a value and nothing produces one. */
function fallbackValue(param: Param): Resolved {
  if (param.in === "header" && SESSION_HEADER.test(param.name)) return {};
  if (param.constant !== undefined) return { value: param.constant };
  // A required query parameter nobody passed keeps its recorded value (page size, sort).
  const recorded = param.in === "query" && param.required ? param.examples?.at(-1) : undefined;
  if (recorded !== undefined) return { value: recorded };
  return { missing: param.required && param.in === "path" };
}

function isSigned(operation: Operation, param: Param): boolean {
  const signing = operation.signing;
  if (!signing) return false;
  if (param.in === "header") return signing.headers.includes(param.name);
  return param.in === "query" && signing.query.includes(param.name);
}

interface Parts {
  path: string;
  url: URL;
  headers: Record<string, string>;
  missing: string[];
}

function applyParams(operation: Operation, inputs: Inputs, consumed: Set<string>): Parts {
  const parts: Parts = {
    path: operation.path,
    url: new URL(operation.origin),
    headers: {},
    missing: [],
  };
  for (const param of operation.params) {
    consumed.add(param.name);
    if (isSigned(operation, param)) continue;
    const { value, missing } = paramValue(operation, param, inputs);
    if (value === undefined) {
      if (missing) parts.missing.push(`${param.in}:${param.name}`);
    } else if (param.in === "path")
      parts.path = parts.path.replace(`{${param.name}}`, encodeURIComponent(value));
    else if (param.in === "query") parts.url.searchParams.set(param.name, value);
    else if (param.in === "header") parts.headers[param.name] = value;
  }
  const field = operation.match?.field;
  if (field?.in === "query") parts.url.searchParams.set(field.name, field.value);
  return parts;
}

function buildBody(operation: Operation, inputs: Inputs, consumed: Set<string>): unknown {
  const hasBody =
    operation.requestBody || operation.samples.some((s) => s.requestBody !== undefined);
  let body = hasBody ? bodyFor(operation, inputs.params, consumed) : undefined;
  for (const [target, value] of Object.entries(inputs.sets))
    if (target.startsWith("body:")) body = setPointer(body, target.slice(5), value);
  for (const [target, kind] of inputs.generated)
    if (target.startsWith("body:") && !(target in inputs.sets))
      body = setPointer(body, target.slice(5), generate(kind));
  return body;
}

/** Leftover caller values become query parameters on GETs; `$set` query targets always do. */
function extraQuery(operation: Operation, url: URL, inputs: Inputs, consumed: Set<string>): void {
  if (operation.method === "GET")
    for (const [key, value] of Object.entries(inputs.params))
      if (!consumed.has(key) && value !== undefined) url.searchParams.set(key, String(value));
  for (const [target, value] of Object.entries(inputs.sets))
    if (target.startsWith("query:") && !url.searchParams.has(target.slice(6)))
      url.searchParams.set(target.slice(6), String(value));
}

/** Builds the request; `missing` lists required inputs nobody supplied, for dependency resolution. */
export function buildRequest(
  operation: Operation,
  params: Params = {},
): { request: RuntimeRequest; missing: string[] } {
  const sets = (params[SET] ?? {}) as Params;
  const inputs: Inputs = { params, sets, generated: generatedTargets(operation) };
  const consumed = new Set<string>([SET]);
  const { path, url, headers, missing } = applyParams(operation, inputs, consumed);
  const body = buildBody(operation, inputs, consumed);
  extraQuery(operation, url, inputs, consumed);
  url.pathname = path;
  const mime = operation.requestBody?.mime;
  if (mime) headers["content-type"] = mime + (operation.requestBody?.form ? ";charset=UTF-8" : "");
  // Next links from link-style pagination replace the whole URL.
  const href = typeof sets.$url === "string" ? sets.$url : url.href;
  const request: RuntimeRequest = {
    operationId: operation.id,
    origin: operation.origin,
    method: operation.method,
    url: href,
    headers,
  };
  const serialized = serializeBody(operation, body);
  if (serialized !== undefined && operation.method !== "GET") request.body = serialized;
  return { request, missing: missing.filter((target) => !(target in sets)) };
}

/** The dependency that can supply a missing input, if it comes from another operation's response. */
export function dependencyFor(
  operation: Operation,
  target: string,
):
  | (Dependency & { source: { kind: "response"; operationId: string; pointer: string } })
  | undefined {
  const dep = operation.dependencies.find(
    (d) =>
      d.target === target && d.source.kind === "response" && d.source.operationId !== operation.id,
  );
  return dep as never;
}
