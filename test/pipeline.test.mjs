import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSiteModel,
  parseCapture,
  encodeTnetstring,
  fromMitmproxy,
  templatePaths,
  inferSchema,
  extractEmbedded,
  filterExchanges,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop } from "./helpers.mjs";

async function shopModel(t) {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const exchanges = parseCapture(JSON.stringify(recorder.har()), "shop-flow");
  const result = await buildSiteModel(exchanges, { site: new URL(site.origin).host });
  return { site, model: result.model, exchanges, recorder };
}

const op = (model, id) => {
  const found = model.operations.find((item) => item.id === id);
  assert.ok(found, `missing operation ${id}; have ${model.operations.map((o) => o.id).join(", ")}`);
  return found;
};

test("a recorded session becomes named operations with templated paths", async (t) => {
  const { model } = await shopModel(t);
  assert.deepEqual(model.operations.map((o) => `${o.method} ${o.path} ${o.id}`).sort(), [
    "GET /api/feed getFeedDeals",
    "GET /api/feed getFeedNews",
    "GET /api/me getMe",
    "GET /api/products listProducts",
    "GET /api/products/{productId} getProduct",
    "GET /api/products/{productId}/reviews listProductsReviews",
    "GET /api/signed getSigned",
    "POST /api/cart createCart",
    "POST /api/login login",
    "POST /graphql graphqlabc123de",
    "POST /graphql searchProducts",
    "POST /rpc inventoryCheck",
    "POST /rpc storeHours",
  ]);
});

test("noise is dropped with a reason, and streams are kept", async (t) => {
  const { model } = await shopModel(t);
  const reasons = Object.fromEntries(model.noise.map((n) => [new URL(n.url).pathname, n.reason]));
  assert.equal(reasons["/collect"], "telemetry");
  assert.match(reasons["/static/app.js"], /static/);
  assert.deepEqual(model.channels.map((c) => c.kind).sort(), ["sse", "websocket"]);
  const ws = model.channels.find((c) => c.kind === "websocket");
  assert.deepEqual(ws.messages.map((m) => `${m.direction} ${m.name}`).sort(), [
    "receive type:price",
    "send type:subscribe",
  ]);
});

test("schemas: required only when always present, formats, enums", async (t) => {
  const { model } = await shopModel(t);
  const list = op(model, "listProducts");
  const schema = list.responses["200"].schema;
  assert.deepEqual(schema.required.sort(), ["items", "nextCursor", "total"]);
  const item = schema.properties.items.items;
  assert.equal(item.properties.createdAt.format, "date-time");
  assert.deepEqual(item.properties.category.enum, ["bags", "hats", "shoes"]);
  assert.equal(item.properties.price.type, "integer");
  const query = Object.fromEntries(
    list.params.filter((p) => p.in === "query").map((p) => [p.name, p]),
  );
  assert.equal(query.limit.required, true);
  assert.equal(query.cursor.required, false);
});

test("pagination: cursor traced to the previous page, page numbers, totals", async (t) => {
  const { model } = await shopModel(t);
  assert.deepEqual(op(model, "listProducts").pagination, {
    style: "cursor",
    param: "query:cursor",
    nextPointer: "/nextCursor",
    limitParam: "query:limit",
    totalPointer: "/total",
    itemsPointer: "/items",
  });
  const reviews = op(model, "listProductsReviews").pagination;
  assert.equal(reviews.style, "page");
  assert.equal(reviews.param, "query:page");
  assert.equal(reviews.itemsPointer, "/reviews");
});

test("dependencies: ids, tokens and CSRF are traced to where they came from", async (t) => {
  const { model } = await shopModel(t);
  const dep = (id, target) => op(model, id).dependencies.find((d) => d.target === target)?.source;
  assert.deepEqual(dep("getProduct", "path:productId"), {
    kind: "response",
    operationId: "listProducts",
    pointer: "/items/*/id",
  });
  assert.deepEqual(dep("getMe", "header:authorization"), {
    kind: "response",
    operationId: "login",
    pointer: "/accessToken",
  });
  assert.equal(dep("createCart", "header:x-csrf-token").kind, "meta");
  assert.deepEqual(dep("createCart", "body:/requestId"), { kind: "generated", generator: "uuid" });
  assert.equal(
    dep("searchProducts", "body:/variables/term"),
    undefined,
    "typed search text is not a dependency",
  );
});

test("auth becomes real security schemes", async (t) => {
  const { model } = await shopModel(t);
  const schemes = Object.fromEntries(model.security.map((s) => [s.name, s]));
  assert.equal(schemes.cookieAuth.key, "sid");
  assert.equal(schemes.bearerAuth.bearerFormat, "JWT");
  assert.deepEqual(schemes.bearerAuth.source, {
    kind: "response",
    operationId: "login",
    pointer: "/accessToken",
  });
  assert.equal(schemes.bearerAuth.refresh, undefined, "a sign-in is not replayed as a refresh");
  assert.deepEqual(schemes.csrfToken.source, { kind: "meta", name: "csrf-token" });
  assert.deepEqual(op(model, "createCart").security.sort(), ["cookieAuth", "csrfToken"]);
});

test("signed requests are detected with the script that signs them", async (t) => {
  const { model } = await shopModel(t);
  const signing = op(model, "getSigned").signing;
  assert.deepEqual(signing.headers, ["x-signature"]);
  assert.equal(signing.initiator.functionName, "signedFetch");
  assert.equal(op(model, "listProducts").signing, undefined);
});

test("GraphQL, JSON-RPC and shape-split operations keep what tells them apart", async (t) => {
  const { model } = await shopModel(t);
  assert.equal(op(model, "searchProducts").graphql.operationName, "SearchProducts");
  assert.match(op(model, "graphqlabc123de").graphql.hash, /^abc123/);
  assert.equal(op(model, "inventoryCheck").match.rpcMethod, "inventory.check");
  assert.deepEqual(op(model, "getFeedNews").match.field, {
    in: "query",
    name: "type",
    value: "news",
  });
  assert.ok(op(model, "getFeedNews").responses["200"].schema.properties.headline);
  assert.ok(op(model, "getFeedDeals").responses["200"].schema.properties.deals);
});

test("server-rendered pages become page endpoints with their embedded data", async (t) => {
  const { model } = await shopModel(t);
  const product = model.pages.find((p) => p.path === "/products/{productSlug}");
  assert.ok(product, JSON.stringify(model.pages.map((p) => p.path)));
  assert.deepEqual(product.embedded.sort(), ["jsonld", "next"]);
  assert.ok(product.schema.properties.jsonLd);
});

test("passwords never reach the stored samples", async (t) => {
  const { model } = await shopModel(t);
  assert.doesNotMatch(JSON.stringify(op(model, "login").samples), /secret-pass/);
});

test("confidence: more samples, more confidence; each with reasons", async (t) => {
  const { model } = await shopModel(t);
  assert.equal(op(model, "getSigned").bucket, "high");
  assert.ok(op(model, "storeHours").flags.some((f) => /seen once/.test(f)));
  assert.ok(op(model, "getSigned").flags.some((f) => /signed/.test(f)));
});

test("stages can stop early", async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const exchanges = parseCapture(JSON.stringify(recorder.har()), "flow");
  const filtered = await buildSiteModel(exchanges, {
    site: new URL(site.origin).host,
    until: "filter",
  });
  assert.equal(filtered.stage, "filter");
  assert.equal(filtered.model.operations.length, 0);
  assert.ok(filtered.model.stats.kept > 20);
});

test("overrides: forced templates, renames, drops", async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const exchanges = parseCapture(JSON.stringify((await browseShop(site.origin)).har()), "flow");
  const { model } = await buildSiteModel(exchanges, {
    site: new URL(site.origin).host,
    overrides: {
      names: { getMe: "currentUser" },
      drop: ["storeHours"],
      templates: ["/api/feed"],
      exclude: ["/rpc"],
    },
  });
  assert.ok(model.operations.some((o) => o.id === "currentUser"));
  assert.ok(!model.operations.some((o) => o.id === "storeHours" || o.id === "inventoryCheck"));
});

test("path templates: ids by shape, slugs by variation, names from neighbours", () => {
  const paths = templatePaths([
    { url: "https://x.test/users/42/orders/9f86d081-884c-4d63-a9a1-5f1c6d2e8f00" },
    { url: "https://x.test/shop/red-running-shoes" },
    { url: "https://x.test/shop/blue-hat" },
    { url: "https://x.test/shop/green-bag-2" },
    { url: "https://x.test/api/v2/categories" },
    { url: "https://x.test/files/a1b2c3d4e5f60718" },
    { url: "https://search.test/1/indexes/items/query" },
    { url: "https://x.test/api/3/products/77" },
  ]);
  assert.equal(paths[6].template, "/1/indexes/items/query", "an API version stays in the path");
  assert.equal(paths[7].template, "/api/3/products/{productId}");
  assert.equal(paths[0].template, "/users/{userId}/orders/{orderId}");
  assert.equal(paths[1].template, "/shop/{shopSlug}");
  assert.equal(paths[4].template, "/api/v2/categories");
  assert.equal(paths[5].template, "/files/{fileId}");
});

test("schema inference: unions, nullables, maps keyed by id", () => {
  const schema = inferSchema([
    { a: 1, b: null, m: { 101: { x: 1 }, 102: { x: 2 }, 103: { x: 3 }, 104: { x: 4 } } },
    { a: "x", b: 2 },
  ]);
  assert.deepEqual(schema.properties.a.type, ["integer", "string"]);
  assert.deepEqual([...schema.properties.b.type].sort(), ["integer", "null"]);
  assert.equal(schema.properties.m.additionalProperties.type, "object");
  assert.deepEqual(schema.required, ["a", "b"]);
});

test("embedded data: Next.js, JSON-LD and window state", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">{"buildId":"b1"}</script>
<script type="application/ld+json">{"@type":"Product","name":"X"}</script>
<script>window.__APOLLO_STATE__ = {"Product:1":{"name":"X","note":"a } brace"}};</script>`;
  const data = extractEmbedded(html);
  assert.equal(data.next.buildId, "b1");
  assert.equal(data.jsonLd[0].name, "X");
  assert.equal(data.apollo["Product:1"].note, "a } brace");
});

test("mitmproxy flow files load like HAR", () => {
  const flow = (path, body) =>
    encodeTnetstring({
      type: "http",
      request: {
        method: Buffer.from("GET"),
        scheme: Buffer.from("https"),
        host: Buffer.from("api.shop.test"),
        port: 443,
        path: Buffer.from(path),
        headers: [[Buffer.from("Accept"), Buffer.from("application/json")]],
        content: Buffer.alloc(0),
        timestamp_start: 1700000000.5,
      },
      response: {
        status_code: 200,
        headers: [[Buffer.from("Content-Type"), Buffer.from("application/json")]],
        content: Buffer.from(JSON.stringify(body)),
      },
    });
  const exchanges = fromMitmproxy(
    Buffer.concat([flow("/v1/items/1", { id: 1 }), flow("/v1/items/2", { id: 2 })]),
    "mitm",
  );
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[1].url, "https://api.shop.test/v1/items/2");
  assert.equal(JSON.parse(exchanges[0].responseBody).id, 1);
  assert.equal(filterExchanges(exchanges).kept.length, 2);
});
