import type { Dependency, Operation, SecurityScheme } from "../types.js";
import type { Member } from "./operations.js";

// Infers how the site authenticates: session cookies, bearer tokens (and where they come
// from, and what refreshes them), API keys, basic auth and CSRF tokens. Emitted as real
// OpenAPI security schemes and used by the runtime to make calls.

const API_KEY_HEADER =
  /^(x-)?(api[-_]?key|apikey|x-.*-key|api[-_]?token|auth[-_]?token|access[-_]?token|client[-_]?id|app[-_]?id|subscription-key|x-algolia-api-key|x-algolia-application-id)$/i;
const API_KEY_QUERY =
  /^(key|api[-_]?key|apikey|access[-_]?token|client[-_]?id|app[-_]?id|x-algolia-api-key|x-algolia-application-id)$/i;
const CSRF = /csrf|xsrf/i;
const SESSION_COOKIE = /sess|sid|auth|token|login|jwt|user|remember|connect\.sid|_identity/i;

interface Draft extends SecurityScheme {
  operations: Set<string>;
}

function schemeName(base: string, origin: string, multiOrigin: boolean): string {
  if (!multiOrigin) return base;
  return base + "_" + new URL(origin).hostname.replace(/[^a-z0-9]+/gi, "_");
}

function constantSource(values: string[]): SecurityScheme["source"] | undefined {
  return new Set(values).size === 1 ? { kind: "constant", value: values[0] as string } : undefined;
}

function dependencySource(operation: Operation, target: string): Dependency["source"] | undefined {
  return operation.dependencies.find((dep) => dep.target === target)?.source;
}

function toSchemeSource(
  source: Dependency["source"] | undefined,
): SecurityScheme["source"] | undefined {
  if (!source) return undefined;
  if (source.kind === "cookie") return { kind: "cookie", name: source.name };
  if (source.kind === "meta") return { kind: "meta", name: source.name };
  if (source.kind === "response")
    return { kind: "response", operationId: source.operationId, pointer: source.pointer };
  if (source.kind === "storage")
    return {
      kind: "storage",
      storage: source.storage,
      key: source.key,
      ...(source.pointer ? { pointer: source.pointer } : {}),
    };
  return undefined;
}

export function inferSecurity(
  entries: { operation: Operation; members: Member[] }[],
): SecurityScheme[] {
  const origins = new Set(entries.map((entry) => entry.operation.origin));
  const multi = origins.size > 1;
  const drafts = new Map<string, Draft>();
  const add = (scheme: SecurityScheme, operation: Operation) => {
    const draft = drafts.get(scheme.name) ?? { ...scheme, operations: new Set<string>() };
    draft.operations.add(operation.id);
    if (!draft.origins.includes(operation.origin)) draft.origins.push(operation.origin);
    if (!draft.source && scheme.source) draft.source = scheme.source;
    drafts.set(scheme.name, draft);
    if (!operation.security.includes(scheme.name)) operation.security.push(scheme.name);
  };
  for (const { operation, members } of entries) {
    const name = (base: string) => schemeName(base, operation.origin, multi);
    authorization(operation, members, name, add);
    apiKeys(operation, members, name, add);
    csrf(operation, members, name, add);
    sessionCookie(operation, members, name, add);
  }
  const schemes = [...drafts.values()].map(({ operations, ...scheme }) => {
    void operations;
    return scheme;
  });
  linkRefresh(
    schemes,
    entries.map((entry) => entry.operation),
  );
  return schemes;
}

type Add = (scheme: SecurityScheme, operation: Operation) => void;

function authorization(
  operation: Operation,
  members: Member[],
  name: (base: string) => string,
  add: Add,
): void {
  const values = members
    .map((m) => m.exchange.requestHeaders.authorization)
    .filter((v): v is string => !!v);
  if (!values.length) return;
  const first = values[0] as string;
  if (/^basic\s/i.test(first)) {
    add(
      { name: name("basicAuth"), type: "basic", in: "header", key: "authorization", origins: [] },
      operation,
    );
    return;
  }
  const token = first.replace(/^(bearer|token)\s+/i, "");
  const scheme: SecurityScheme = {
    name: name("bearerAuth"),
    type: "bearer",
    in: "header",
    key: "authorization",
    origins: [],
  };
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) scheme.bearerFormat = "JWT";
  const source =
    toSchemeSource(dependencySource(operation, "header:authorization")) ?? constantSource(values);
  if (source) scheme.source = source;
  add(scheme, operation);
}

function apiKeys(
  operation: Operation,
  members: Member[],
  name: (base: string) => string,
  add: Add,
): void {
  for (const param of operation.params) {
    const header =
      param.in === "header" && API_KEY_HEADER.test(param.name) && !CSRF.test(param.name);
    const query = param.in === "query" && API_KEY_QUERY.test(param.name);
    if (!header && !query) continue;
    const values = members
      .map((m) =>
        header
          ? m.exchange.requestHeaders[param.name]
          : new URL(m.exchange.url).searchParams.get(param.name),
      )
      .filter((v): v is string => !!v);
    const scheme: SecurityScheme = {
      name: name(param.name.replace(/[^a-z0-9]+/gi, "_")),
      type: "apiKey",
      in: param.in === "header" ? "header" : "query",
      key: param.name,
      origins: [],
    };
    const source =
      toSchemeSource(dependencySource(operation, `${param.in}:${param.name}`)) ??
      constantSource(values);
    if (source) scheme.source = source;
    add(scheme, operation);
  }
}

/** Where a request carries its CSRF token: a header, or a field of a form body. */
function csrfCarrier(member: Member | undefined): { header?: string; field?: string } | undefined {
  const header = Object.keys(member?.exchange.requestHeaders ?? {}).find((key) => CSRF.test(key));
  if (header) return { header };
  if (!member?.body?.form) return undefined;
  const fields = Object.keys((member.body.value ?? {}) as object);
  const field = fields.find((key) => CSRF.test(key) || key === "authenticity_token");
  return field ? { field } : undefined;
}

function csrf(
  operation: Operation,
  members: Member[],
  name: (base: string) => string,
  add: Add,
): void {
  const carrier = csrfCarrier(members[0]);
  if (!carrier) return;
  const key = (carrier.header ?? carrier.field) as string;
  const scheme: SecurityScheme = { name: name("csrfToken"), type: "csrf", key, origins: [] };
  if (carrier.header) scheme.in = "header";
  const target = carrier.header ? `header:${key}` : `body:/${key}`;
  const cookie = /(csrf|xsrf)[^=;]*/i.exec(members[0]?.exchange.requestHeaders.cookie ?? "")?.[0];
  const source =
    toSchemeSource(dependencySource(operation, target)) ??
    (cookie ? ({ kind: "cookie", name: cookie } as const) : undefined);
  if (source) scheme.source = source;
  add(scheme, operation);
}

function sessionCookie(
  operation: Operation,
  members: Member[],
  name: (base: string) => string,
  add: Add,
): void {
  const header = members.find((m) => m.exchange.requestHeaders.cookie)?.exchange.requestHeaders
    .cookie;
  if (!header) return;
  const names = header
    .split(/;\s*/)
    .map((pair) => pair.split("=")[0] ?? "")
    .filter(Boolean);
  const session =
    names.find((cookie) => SESSION_COOKIE.test(cookie) && !CSRF.test(cookie)) ?? names[0];
  if (!session) return;
  add(
    { name: name("cookieAuth"), type: "cookie", in: "cookie", key: session, origins: [] },
    operation,
  );
}

/** A token that came from an auth operation's response can be renewed by calling it again. */
function linkRefresh(schemes: SecurityScheme[], operations: Operation[]): void {
  for (const scheme of schemes) {
    if (scheme.source?.kind !== "response") continue;
    const producer = operations.find(
      (op) => op.id === (scheme.source as { operationId: string }).operationId,
    );
    // A token endpoint can be called again; a sign-in needs the user's password, so it is not.
    if (
      producer &&
      /refresh|token/i.test(producer.path) &&
      !/log-?in|sign-?in/i.test(producer.path)
    )
      scheme.refresh = { operationId: producer.id, pointer: scheme.source.pointer };
  }
}
