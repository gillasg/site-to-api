import type { SiteModel } from "../types.js";

// Published API descriptions: OpenAPI/Swagger documents at their usual paths, and the schema of
// each GraphQL endpoint the site uses (introspection). Read from the site's own page, so the
// user's session applies. They list operations nobody has clicked yet; call them with
// browser.fetch, or explore with a goal that uses them so they get mapped.

const DOC_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
  "/api/swagger.json",
  "/v3/api-docs",
  "/v2/api-docs",
  "/api-docs",
  "/api/docs/openapi.json",
  "/.well-known/openapi.json",
  "/swagger/v1/swagger.json",
];

const INTROSPECTION =
  "query{__schema{queryType{name}mutationType{name}subscriptionType{name}types{kind name description fields{name description args{name type{kind name ofType{kind name ofType{kind name}}}}type{kind name ofType{kind name ofType{kind name}}}}inputFields{name type{kind name ofType{kind name}}}enumValues{name}}}}";

export interface SiteDocs {
  openapi: { url: string; title?: string; document: Record<string, unknown> }[];
  graphql: { url: string; schema: Record<string, unknown> }[];
}

export interface DocsSummary {
  openapi: { url: string; title?: string; operations: string[] }[];
  graphql: {
    url: string;
    queries: string[];
    mutations: string[];
    subscriptions: string[];
    types: number;
  }[];
}

/** Where to look: the usual doc paths on each origin, and every GraphQL endpoint in the model. */
export function docsTargets(model: SiteModel): { docs: string[]; graphql: string[] } {
  const origins = model.origins.length ? model.origins : [`https://${model.site}`];
  const graphql = new Set<string>();
  for (const op of model.operations)
    if (op.kind === "graphql") graphql.add(new URL(op.path, op.origin).href);
  return {
    docs: origins.flatMap((origin) => DOC_PATHS.map((path) => new URL(path, origin).href)),
    graphql: [...graphql],
  };
}

/** Page code that fetches the candidates and returns what answered. */
export function docsExpression(targets: { docs: string[]; graphql: string[] }): string {
  return `(async () => {
  const t = ${JSON.stringify(targets)};
  const json = async (url, init) => {
    try {
      const response = await fetch(url, { credentials: 'include', ...init });
      if (!response.ok) return undefined;
      return await response.json();
    } catch { return undefined; }
  };
  const openapi = [];
  for (const url of t.docs) {
    const doc = await json(url);
    if (doc && (doc.openapi || doc.swagger) && doc.paths) openapi.push({ url, title: doc.info?.title, document: doc });
  }
  const graphql = [];
  for (const url of t.graphql) {
    const body = await json(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ${JSON.stringify(INTROSPECTION)} }),
    });
    if (body?.data?.__schema) graphql.push({ url, schema: body.data.__schema });
  }
  return { openapi, graphql };
})()`;
}

type Field = { name: string; args?: { name: string }[] };
type GqlType = { name: string; fields?: Field[] | null };

function rootFields(schema: Record<string, unknown>, root: string): string[] {
  const name = (schema[root] as { name?: string } | null)?.name;
  const types = (schema.types ?? []) as GqlType[];
  const type = types.find((item) => item.name === name);
  return (type?.fields ?? []).map(
    (field) => `${field.name}(${(field.args ?? []).map((arg) => arg.name).join(", ")})`,
  );
}

/** Short listing of what the documents describe. */
export function summarizeDocs(docs: SiteDocs): DocsSummary {
  return {
    openapi: docs.openapi.map(({ url, title, document }) => ({
      url,
      ...(title ? { title } : {}),
      operations: Object.entries((document.paths ?? {}) as Record<string, Record<string, unknown>>)
        .flatMap(([path, item]) =>
          Object.entries(item)
            .filter(([method]) => /^(get|post|put|patch|delete)$/.test(method))
            .map(([method, op]) => {
              const summary = (op as { summary?: string; operationId?: string }) ?? {};
              return `${method.toUpperCase()} ${path}${summary.summary ? ` (${summary.summary})` : summary.operationId ? ` (${summary.operationId})` : ""}`;
            }),
        )
        .slice(0, 500),
    })),
    graphql: docs.graphql.map(({ url, schema }) => ({
      url,
      queries: rootFields(schema, "queryType"),
      mutations: rootFields(schema, "mutationType"),
      subscriptions: rootFields(schema, "subscriptionType"),
      types: ((schema.types ?? []) as unknown[]).length,
    })),
  };
}
