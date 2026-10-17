import { documentShape } from "./html.js";
import type { Classified } from "../filter.js";
import type { Exchange, Operation, Param } from "../types.js";
import {
  ACTION_FIELDS,
  actionField,
  graphqlCall,
  parseRequestBody,
  responseJson,
  rpcMethod,
  type GraphqlCall,
  type ParsedBody,
} from "./bodies.js";
import { inferSchema, shapeKey, similarity } from "./schema.js";
import { camel, singular, templatePaths, type SegmentKind } from "./templates.js";

// Groups exchanges into operations: one per method and path template, split further by GraphQL
// operation, JSON-RPC method, action field, or a response shape that differs by a parameter.

export interface Member {
  exchange: Exchange;
  pathValues: Record<string, string>;
  body?: ParsedBody;
  graphql?: GraphqlCall;
  json?: unknown;
}

export interface Group {
  key: string;
  origin: string;
  method: string;
  template: string;
  pathParams: { name: string; kind: SegmentKind }[];
  kind: Operation["kind"];
  match?: Operation["match"];
  auth: boolean;
  members: Member[];
}

export interface Grouped {
  groups: Group[];
  documents: {
    template: string;
    origin: string;
    pathParams: { name: string; kind: SegmentKind }[];
    member: Member;
  }[];
  channels: Exchange[];
}

function discriminator(member: Member): {
  kind: Operation["kind"];
  key: string;
  match?: Operation["match"];
} {
  if (member.graphql) {
    const graphql: { operationName?: string; hash?: string } = {};
    if (member.graphql.operationName) graphql.operationName = member.graphql.operationName;
    else if (member.graphql.hash) graphql.hash = member.graphql.hash;
    return {
      kind: "graphql",
      key: `gql:${graphql.operationName ?? graphql.hash ?? "anonymous"}`,
      match: { graphql },
    };
  }
  const rpc = rpcMethod(member.body);
  if (rpc) return { kind: "jsonrpc", key: `rpc:${rpc}`, match: { rpcMethod: rpc } };
  const field = actionField(member.exchange, member.body);
  if (field)
    return {
      kind: "action",
      key: `field:${field.in}:${field.name}=${field.value}`,
      match: { field },
    };
  return { kind: "rest", key: "" };
}

export function groupExchanges(kept: Classified[], templates: string[] = []): Grouped {
  const api = kept.filter(
    (item) => item.category === "api" || item.category === "auth" || item.category === "document",
  );
  const templated = templatePaths(
    api.map(({ exchange, category }) => ({
      url: exchange.url,
      shape:
        category === "document"
          ? documentShape(exchange.responseBody ?? "")
          : shapeKey(responseJson(exchange)),
    })),
    templates,
  );
  const groups = new Map<string, Group>();
  const documents: Grouped["documents"] = [];
  api.forEach(({ exchange, category }, index) => {
    const path = templated[index] as (typeof templated)[number];
    const url = new URL(exchange.url);
    const member: Member = {
      exchange,
      pathValues: Object.fromEntries(path.params.map((param) => [param.name, param.value])),
    };
    const pathParams = path.params.map(({ name, kind }) => ({ name, kind }));
    if (category === "document") {
      documents.push({ template: path.template, origin: url.origin, pathParams, member });
      return;
    }
    const body = parseRequestBody(exchange);
    if (body) member.body = body;
    const graphql = graphqlCall(exchange, body);
    if (graphql) member.graphql = graphql;
    const json = responseJson(exchange);
    if (json !== undefined) member.json = json;
    const which = discriminator(member);
    const key = `${exchange.method} ${url.origin}${path.template} ${which.key}`;
    const group = groups.get(key) ?? {
      key,
      origin: url.origin,
      method: exchange.method,
      template: path.template,
      pathParams,
      kind: which.kind,
      ...(which.match ? { match: which.match } : {}),
      auth: category === "auth",
      members: [],
    };
    group.members.push(member);
    groups.set(key, group);
  });
  const channels = kept.filter((item) => item.category === "channel").map((item) => item.exchange);
  return { groups: [...groups.values()].flatMap(splitByShape), documents, channels };
}

/**
 * One endpoint answering in clearly different shapes (`/api?type=user` vs `?type=order`)
 * becomes one operation per shape when a query parameter tells them apart.
 */
export function splitByShape(group: Group): Group[] {
  if (group.kind !== "rest" || group.members.length < 4) return [group];
  const clusters: { shape: string; members: Member[] }[] = [];
  for (const member of group.members) {
    const shape = shapeKey(member.json);
    const cluster = clusters.find((item) => similarity(item.shape, shape) >= 0.3);
    if (cluster) cluster.members.push(member);
    else clusters.push({ shape, members: [member] });
  }
  if (clusters.length < 2 || clusters.some((cluster) => cluster.members.length < 2)) return [group];
  const separator = separatingParam(clusters.map((cluster) => cluster.members));
  if (!separator) return [group];
  return clusters.map((cluster) => {
    const value = new URL(cluster.members[0]?.exchange.url ?? "").searchParams.get(separator) ?? "";
    return {
      ...group,
      key: `${group.key} field:query:${separator}=${value}`,
      kind: "action",
      match: { field: { in: "query", name: separator, value } },
      members: cluster.members,
    };
  });
}

function separatingParam(clusters: Member[][]): string | undefined {
  const first = clusters[0]?.[0];
  if (!first) return undefined;
  for (const name of new URL(first.exchange.url).searchParams.keys()) {
    const values = clusters.map(
      (members) => new Set(members.map((m) => new URL(m.exchange.url).searchParams.get(name))),
    );
    const single = values.every((set) => set.size === 1 && !set.has(null));
    const distinct = new Set(values.map((set) => [...set][0])).size === clusters.length;
    if (single && distinct) return name;
  }
  return undefined;
}

const STANDARD_HEADERS =
  /^(accept|accept-language|accept-encoding|content-type|content-length|user-agent|referer|origin|cookie|host|connection|cache-control|pragma|priority|dnt|te|upgrade-insecure-requests|if-none-match|if-modified-since|sec-.*|authorization|x-forwarded-.*)$/;

function stringSchema(values: string[]): Param["schema"] {
  if (values.every((value) => /^-?\d+$/.test(value))) return { type: "integer" };
  if (values.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return { type: "number" };
  if (values.every((value) => value === "true" || value === "false")) return { type: "boolean" };
  return inferSchema(values);
}

function collectParams(
  location: "query" | "header",
  lists: [string, string][][],
  total: number,
): Param[] {
  const values = new Map<string, string[]>();
  for (const list of lists)
    for (const [name, value] of list) values.set(name, [...(values.get(name) ?? []), value]);
  return [...values.entries()].map(([name, list]) => {
    const presence = lists.filter((pairs) => pairs.some(([key]) => key === name)).length;
    const param: Param = {
      name,
      in: location,
      required: presence === total,
      schema: stringSchema(list),
      examples: [...new Set(list)].slice(0, 3),
    };
    if (total >= 2 && new Set(list).size === 1 && presence === total)
      param.constant = list[0] as string;
    return param;
  });
}

function params(group: Group, skipQuery: Set<string>): Param[] {
  const total = group.members.length;
  const path: Param[] = group.pathParams.map(({ name, kind }) => {
    const values = group.members.map((member) => member.pathValues[name] ?? "");
    return {
      name,
      in: "path",
      required: true,
      schema:
        kind === "integer"
          ? { type: "integer" }
          : kind === "uuid"
            ? { type: "string", format: "uuid" }
            : stringSchema(values),
      examples: [...new Set(values)].slice(0, 3),
    };
  });
  const query = collectParams(
    "query",
    group.members.map((m) =>
      [...new URL(m.exchange.url).searchParams].filter(([key]) => !skipQuery.has(key)),
    ),
    total,
  );
  const headers = collectParams(
    "header",
    group.members.map((m) =>
      Object.entries(m.exchange.requestHeaders).filter(([key]) => !STANDARD_HEADERS.test(key)),
    ),
    total,
  );
  return [...path, ...query, ...headers];
}

const READ_WORDS = /(search|query|list|find|filter|lookup|get|fetch|browse|suggest|autocomplete)/i;

function describedBy(group: Group): string {
  return group.match?.rpcMethod ?? group.match?.field?.value ?? group.template;
}

function role(group: Group): Operation["role"] {
  if (group.auth) return "auth";
  if (group.method === "GET" || group.method === "HEAD") return "read";
  const graphql = group.members[0]?.graphql;
  if (graphql) return graphql.type === "mutation" ? "action" : "read";
  return READ_WORDS.test(describedBy(group)) ? "read" : "action";
}

function responses(group: Group): Operation["responses"] {
  const byStatus = new Map<number, Member[]>();
  for (const member of group.members)
    byStatus.set(member.exchange.status, [...(byStatus.get(member.exchange.status) ?? []), member]);
  const result: Operation["responses"] = {};
  for (const [status, members] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const mime =
      (
        members[0]?.exchange.responseMime ??
        members[0]?.exchange.responseHeaders["content-type"] ??
        ""
      ).split(";")[0] || "application/json";
    const json = members.map((member) => member.json).filter((value) => value !== undefined);
    result[String(status)] = json.length ? { mime, schema: inferSchema(json) } : { mime };
  }
  return result;
}

function requestBody(group: Group): Operation["requestBody"] {
  const bodies = group.members
    .map((member) => member.body)
    .filter((body): body is ParsedBody => !!body);
  if (!bodies.length) return undefined;
  const first = bodies[0] as ParsedBody;
  const values = bodies.map((body) => body.value).filter((value) => value !== undefined);
  const body: NonNullable<Operation["requestBody"]> = {
    mime: first.mime,
    schema: values.length ? inferSchema(values) : {},
  };
  if (first.form) body.form = true;
  return body;
}

function graphqlTemplate(group: Group): Operation["graphql"] {
  const call = group.members.map((member) => member.graphql).find(Boolean);
  if (!call) return undefined;
  const template: NonNullable<Operation["graphql"]> = { variablesPath: call.variablesPath };
  if (call.query) template.query = call.query;
  if (call.hash) template.hash = call.hash;
  if (call.operationName) template.operationName = call.operationName;
  return template;
}

const PASSWORD_KEY =
  /^(password|passwd|pwd|pass|otp|pin|cvv|cvc|card_?number|new_?password|current_?password)$/i;

/** Samples double as request templates; passwords and card numbers are never kept in them. */
function withoutPasswords(body: string): string {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return body;
    const copy = { ...(value as Record<string, unknown>) };
    for (const key of Object.keys(copy)) if (PASSWORD_KEY.test(key)) copy[key] = "";
    return JSON.stringify(copy);
  } catch {
    if (!body.includes("=")) return body;
    const params = new URLSearchParams(body);
    for (const key of [...params.keys()]) if (PASSWORD_KEY.test(key)) params.set(key, "");
    return params.toString();
  }
}

export function buildOperation(group: Group): Operation {
  const skipQuery = new Set<string>();
  if (group.kind === "graphql")
    ["query", "operationName", "extensions"].forEach((key) => skipQuery.add(key));
  if (group.match?.field?.in === "query") skipQuery.add(group.match.field.name);
  const operation: Operation = {
    id: "",
    method: group.method,
    origin: group.origin,
    path: group.template,
    kind: group.kind,
    params: params(group, skipQuery),
    responses: responses(group),
    role: role(group),
    security: [],
    dependencies: [],
    confidence: 0,
    bucket: "low",
    flags: [],
    sampleCount: group.members.length,
    sources: [...new Set(group.members.map((m) => m.exchange.source))],
    pageUrls: [
      ...new Set(
        group.members.map((m) => m.exchange.pageUrl).filter((url): url is string => !!url),
      ),
    ].slice(0, 5),
    samples: group.members.slice(0, 5).map(({ exchange }) => ({
      url: exchange.url,
      method: exchange.method,
      status: exchange.status,
      requestHeaders: exchange.requestHeaders,
      ...(exchange.requestBody !== undefined
        ? { requestBody: withoutPasswords(exchange.requestBody) }
        : {}),
      ...(exchange.responseBody !== undefined && !exchange.responseBase64
        ? { responseBody: exchange.responseBody.slice(0, 200_000) }
        : {}),
      ...(exchange.pageUrl ? { pageUrl: exchange.pageUrl } : {}),
    })),
  };
  if (group.match) operation.match = group.match;
  const body = requestBody(group);
  if (body) operation.requestBody = body;
  const graphql = graphqlTemplate(group);
  if (graphql) operation.graphql = graphql;
  operation.id = operationName(operation);
  return operation;
}

const VERBS: Record<string, string> = {
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

/** Names from what tells an operation apart: its GraphQL name, RPC method or action field. */
function matchedName(operation: Operation): string | undefined {
  if (operation.graphql?.operationName) return camel(operation.graphql.operationName);
  if (operation.match?.rpcMethod) return camel(operation.match.rpcMethod);
  const field = operation.match?.field;
  if (field) {
    if (ACTION_FIELDS.includes(field.name.toLowerCase())) return camel(field.value);
    const noun = operation.path
      .split("/")
      .filter((part) => part && !part.startsWith("{"))
      .pop();
    return camel(`get ${noun ?? ""} ${field.value}`);
  }
  if (operation.graphql?.hash) return "graphql" + operation.graphql.hash.slice(0, 8);
  return undefined;
}

const PATH_NOISE = /^(api|v\d+(\.\d+)?|rest|public|internal|graphql|json)$/i;

function restVerb(operation: Operation, item: boolean, lastLiteral: string): string {
  if (operation.role === "auth") return "";
  const explicit = VERBS[operation.method];
  if (explicit) return explicit;
  if (item) return "get";
  const ok = Object.entries(operation.responses).find(([status]) => status.startsWith("2"))?.[1];
  return ok?.schema?.type === "array" || /s$/i.test(lastLiteral) ? "list" : "get";
}

/** A readable operationId from what the operation does: listProducts, getProduct, searchItems. */
export function operationName(operation: Operation): string {
  const matched = matchedName(operation);
  if (matched) return matched;
  const segments = operation.path.split("/").filter(Boolean);
  const literals = segments.filter((part) => !part.startsWith("{") && !PATH_NOISE.test(part));
  const item = (segments[segments.length - 1] ?? "").startsWith("{");
  const nouns = literals
    .slice(-2)
    .map((word, index, list) => (index === list.length - 1 && item ? singular(word) : word));
  const noun = nouns.join(" ") || "root";
  if (/search|query|find|suggest|autocomplete/i.test(noun)) return camel(noun);
  return camel(`${restVerb(operation, item, literals[literals.length - 1] ?? "")} ${noun}`);
}

/** Makes ids unique and applies renames from the overrides file. */
export function finalizeNames(operations: Operation[], renames: Record<string, string> = {}): void {
  const used = new Map<string, number>();
  for (const operation of operations) {
    let id = operation.id;
    const count = used.get(id) ?? 0;
    if (count) id = camel(`${id} ${operation.method.toLowerCase()}`) + (count > 1 ? count : "");
    used.set(operation.id, count + 1);
    operation.id = renames[id] ?? id;
  }
}
