import { createRedactor, type Redactor } from "../redact.js";
import type {
  JsonSchema,
  Operation,
  Overrides,
  PageEndpoint,
  SecurityScheme,
  SiteModel,
} from "../types.js";
import { camel } from "../infer/templates.js";

// OpenAPI 3.1 from a site model: real security schemes, confidence and provenance extensions,
// pagination, dependencies and signing hints. Operations sharing a method and path (GraphQL,
// JSON-RPC, action fields) become one operation with x-variants. Secrets are redacted.

type Doc = Record<string, unknown>;

function securityScheme(scheme: SecurityScheme, redactor: Redactor): Doc {
  const base: Doc =
    scheme.type === "bearer"
      ? {
          type: "http",
          scheme: "bearer",
          ...(scheme.bearerFormat ? { bearerFormat: scheme.bearerFormat } : {}),
        }
      : scheme.type === "basic"
        ? { type: "http", scheme: "basic" }
        : { type: "apiKey", in: scheme.in ?? "header", name: scheme.key ?? scheme.name };
  if (scheme.type === "csrf") base["x-csrf"] = true;
  if (scheme.source)
    base["x-source"] =
      scheme.source.kind === "constant"
        ? { kind: "constant", value: redactor.header("x-api-key", scheme.source.value) }
        : scheme.source;
  if (scheme.refresh) base["x-refresh"] = scheme.refresh;
  base["x-origins"] = scheme.origins;
  return base;
}

function authParams(model: SiteModel): Set<string> {
  return new Set(
    model.security
      .filter((s) => s.key && s.in !== "cookie")
      .map((s) => `${s.in}:${(s.key as string).toLowerCase()}`),
  );
}

function parameters(operation: Operation, skip: Set<string>, redactor: Redactor): Doc[] {
  return operation.params
    .filter(
      (param) =>
        !skip.has(`${param.in}:${param.name.toLowerCase()}`) &&
        !(param.in === "header" && param.name === "authorization"),
    )
    .map((param) => {
      const doc: Doc = {
        name: param.name,
        in: param.in,
        required: param.required,
        schema: param.schema,
      };
      const example = param.examples?.[0];
      if (example !== undefined)
        doc.example =
          param.in === "header" ? redactor.header(param.name, example) : redactor.text(example);
      if (param.constant !== undefined)
        doc["x-constant"] =
          param.in === "header"
            ? redactor.header(param.name, param.constant)
            : redactor.text(param.constant);
      if (param.generated) doc["x-generated"] = param.generated;
      return doc;
    });
}

function responses(operation: Operation): Doc {
  const doc: Doc = {};
  for (const [status, response] of Object.entries(operation.responses))
    doc[status] = {
      description: Number(status) < 400 ? "OK" : "Error",
      ...(response.schema || response.mime
        ? { content: { [response.mime || "application/json"]: { schema: response.schema ?? {} } } }
        : {}),
    };
  if (!Object.keys(doc).length) doc.default = { description: "Response" };
  return doc;
}

function tag(operation: { path: string }): string {
  const literal = operation.path
    .split("/")
    .find(
      (part) =>
        part && !part.startsWith("{") && !/^(api|v\d+(\.\d+)?|rest|public|internal)$/i.test(part),
    );
  return literal ?? "root";
}

function extensions(operation: Operation, redactor: Redactor): Doc {
  const doc: Doc = {
    "x-confidence": operation.confidence,
    "x-confidence-bucket": operation.bucket,
    "x-sample-count": operation.sampleCount,
    "x-origin": operation.origin,
    "x-role": operation.role,
    "x-kind": operation.kind,
  };
  if (operation.flags.length) doc["x-flags"] = operation.flags;
  if (operation.match) doc["x-match"] = operation.match;
  if (operation.graphql) doc["x-graphql"] = operation.graphql;
  if (operation.pagination) doc["x-pagination"] = operation.pagination;
  if (operation.dependencies.length) doc["x-dependencies"] = operation.dependencies;
  if (operation.signing) doc["x-signing"] = operation.signing;
  if (operation.pageUrls.length)
    doc["x-pages"] = operation.pageUrls.map((url) => redactor.text(url));
  return doc;
}

function operationDoc(
  operation: Operation,
  skip: Set<string>,
  redactor: Redactor,
  multiOrigin: boolean,
): Doc {
  const doc: Doc = {
    operationId: operation.id,
    summary: operation.summary ?? sentence(operation.id),
    ...(operation.description ? { description: operation.description } : {}),
    tags: [tag(operation)],
    parameters: parameters(operation, skip, redactor),
    responses: responses(operation),
    ...extensions(operation, redactor),
  };
  if (operation.requestBody)
    doc.requestBody = {
      required: true,
      content: { [operation.requestBody.mime]: { schema: operation.requestBody.schema } },
    };
  doc.security = operation.security.length
    ? [Object.fromEntries(operation.security.map((name) => [name, []]))]
    : [];
  if (multiOrigin) doc.servers = [{ url: operation.origin }];
  return doc;
}

/** Several operations on one method and path: one OpenAPI operation, told apart by x-variants. */
function variantsDoc(
  operations: Operation[],
  skip: Set<string>,
  redactor: Redactor,
  multiOrigin: boolean,
): Doc {
  const first = operations[0] as Operation;
  const docs = operations.map((op) => operationDoc(op, skip, redactor, multiOrigin));
  const bodies = operations
    .map((op) => op.requestBody?.schema)
    .filter((schema): schema is JsonSchema => !!schema);
  const doc: Doc = {
    ...(docs[0] as Doc),
    operationId: camel(`${first.method.toLowerCase()} ${first.path}`),
    summary: `${operations.length} operations: ${operations.map((op) => op.id).join(", ")}`,
    "x-variants": docs.map((variant, i) => ({ ...variant, "x-match": operations[i]?.match })),
  };
  if (bodies.length)
    doc.requestBody = {
      required: true,
      content: { [first.requestBody?.mime ?? "application/json"]: { schema: { oneOf: bodies } } },
    };
  return doc;
}

function pageDoc(page: PageEndpoint, multiOrigin: boolean): Doc {
  return {
    operationId: page.id,
    summary: sentence(page.id),
    tags: ["pages"],
    parameters: page.params.map((param) => ({
      name: param.name,
      in: "path",
      required: true,
      schema: param.schema,
    })),
    responses: {
      "200": {
        description: "The page's data",
        content: { "application/json": { schema: page.schema ?? {} } },
      },
    },
    "x-page-endpoint": {
      embedded: page.embedded,
      ...(page.extractor ? { extractor: page.extractor } : {}),
    },
    "x-sample-count": page.sampleCount,
    ...(multiOrigin ? { servers: [{ url: page.origin }] } : {}),
  };
}

export function sentence(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function buildPaths(model: SiteModel, redactor: Redactor): Record<string, Doc> {
  const multiOrigin = model.origins.length > 1;
  const skip = authParams(model);
  const buckets = new Map<string, Operation[]>();
  for (const operation of model.operations) {
    const key = `${operation.path}|${operation.method.toLowerCase()}|${operation.origin}`;
    buckets.set(key, [...(buckets.get(key) ?? []), operation]);
  }
  const paths: Record<string, Doc> = {};
  for (const [key, operations] of buckets) {
    const [path, method, origin] = key.split("|") as [string, string, string];
    const pathKey = paths[path]?.[method] ? `${path}#${new URL(origin).host}` : path;
    const item = (paths[pathKey] ??= {});
    item[method] =
      operations.length === 1
        ? operationDoc(operations[0] as Operation, skip, redactor, multiOrigin)
        : variantsDoc(operations, skip, redactor, multiOrigin);
  }
  for (const page of model.pages) {
    const pathKey = paths[page.path]?.get ? `${page.path}#page` : page.path;
    paths[pathKey] = { ...(paths[pathKey] ?? {}), get: pageDoc(page, multiOrigin) };
  }
  return paths;
}

export function toOpenApi(model: SiteModel, rules: Overrides["redact"] = {}): Doc {
  const redactor = createRedactor(rules);
  const tags = new Set([...model.operations.map(tag), ...(model.pages.length ? ["pages"] : [])]);
  return {
    openapi: "3.1.0",
    info: {
      title: model.title,
      version: model.generatedAt.slice(0, 10),
      description: `API of ${model.site}, inferred from ${model.stats.kept} recorded requests.`,
      "x-generator": "site-to-api",
    },
    servers: model.origins.map((url) => ({ url })),
    tags: [...tags].map((name) => ({ name })),
    paths: buildPaths(model, redactor),
    components: {
      schemas: model.components,
      securitySchemes: Object.fromEntries(
        model.security.map((scheme) => [scheme.name, securityScheme(scheme, redactor)]),
      ),
    },
  };
}

export function toAsyncApi(model: SiteModel): Doc | undefined {
  if (!model.channels.length) return undefined;
  const servers: Doc = {};
  const channels: Doc = {};
  const operations: Doc = {};
  for (const channel of model.channels) {
    const url = new URL(channel.url);
    const server = url.host.replace(/[^a-z0-9]+/gi, "_");
    servers[server] = { host: url.host, protocol: url.protocol.replace(":", "") };
    const messages: Doc = {};
    for (const message of channel.messages) {
      const name = camel(message.name.replace(":", " "));
      messages[name] = {
        name: message.name,
        payload: message.schema ?? {},
        "x-count": message.count,
      };
      operations[camel(`${channel.id} ${message.direction} ${name}`)] = {
        action: message.direction,
        channel: { $ref: `#/channels/${channel.id}` },
        messages: [{ $ref: `#/channels/${channel.id}/messages/${name}` }],
      };
    }
    channels[channel.id] = {
      address: url.pathname,
      servers: [{ $ref: `#/servers/${server}` }],
      messages,
      "x-kind": channel.kind,
    };
  }
  return {
    asyncapi: "3.0.0",
    info: { title: `${model.title} streams`, version: model.generatedAt.slice(0, 10) },
    servers,
    channels,
    operations,
  };
}
