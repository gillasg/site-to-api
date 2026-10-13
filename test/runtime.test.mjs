import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSiteModel,
  parseCapture,
  siteApi,
  PageTransport,
  DirectTransport,
  MissingParams,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop, NodeRecorder } from "./helpers.mjs";
import { FakeBrowser } from "./fake-browser.mjs";

async function shop(t, extra) {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  if (extra) await extra(recorder);
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(recorder.har()), "flow"), {
    site: new URL(site.origin).host,
  });
  return { site, model };
}

test("direct calls: typed operations, query and path parameters", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const page = await api.listProducts({ limit: 2 });
  assert.equal(page.items.length, 2);
  const product = await api.getProduct({ productId: 1005 });
  assert.equal(product.product.id, 1005);
  assert.equal((await api.getFeedNews()).headline, "Sale");
  assert.ok((await api.getFeedDeals()).deals);
});

test("missing inputs are resolved from the operations that produce them", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const product = await api.getProduct();
  assert.equal(product.product.id, 1000, "the first id from listProducts");
  const reviews = await api.listProductsReviews();
  assert.equal(reviews.reviews.length, 3, "chained: listProducts → getProduct → reviews");
  const bare = structuredClone(model);
  bare.operations.find((o) => o.id === "getProduct").dependencies = [];
  const unresolved = await siteApi(model.site, {
    model: bare,
    transport: "direct",
    session: false,
  });
  await assert.rejects(
    () => unresolved.getProduct(),
    (error) => error instanceof MissingParams && /path:productId/.test(error.message),
  );
});

test("async iterators walk cursor and page-number pagination", async (t) => {
  const { model, site } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const all = [];
  for await (const item of api.paginate.listProducts({ limit: 5 })) all.push(item.id);
  assert.equal(all.length, site.products.length);
  assert.equal(new Set(all).size, all.length);
  const reviews = [];
  for await (const review of api.paginate("listProductsReviews", { productId: 1000 }))
    reviews.push(review.id);
  assert.equal(reviews.length, 7);
  const capped = [];
  for await (const item of api.paginate.listProducts({ limit: 5 }, { maxItems: 7 }))
    capped.push(item);
  assert.equal(capped.length, 7);
});

test("GraphQL and JSON-RPC calls take variables and params", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const search = await api.searchProducts({ variables: { term: "Product 2" } });
  assert.ok(search.data.search.edges.every((edge) => edge.node.name.includes("Product 2")));
  const category = await api.graphqlabc123de({ variables: { slug: "bags" } });
  assert.equal(category.data.category.name, "Category bags");
  const stock = await api.inventoryCheck({ params: { sku: "zz" } });
  assert.equal(stock.result.sku, "zz");
});

test("429s are retried with back-off", async (t) => {
  const { model } = await shop(t, async (r) => {
    await r.request("GET", "/api/flaky");
    await r.request("GET", "/api/flaky");
  });
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const id = model.operations.find((o) => o.path === "/api/flaky").id;
  assert.deepEqual(await api.call(id), { ok: true });
});

test("in-page calls: the site's cookies and CSRF token apply, and its own fetch signs requests", async (t) => {
  const { model } = await shop(t);
  const browser = new FakeBrowser();
  const api = await siteApi(model.site, {
    model,
    transport: "page",
    bridge: async () => browser,
    session: false,
  });
  const cart = await api.createCart({ productId: 1004, quantity: 3 });
  assert.equal(cart.items[0].productId, 1004);
  assert.equal(cart.items[0].quantity, 3);
  assert.match(cart.requestId, /^[0-9a-f-]{36}$/, "a fresh request id is generated");
  const signed = await api.getSigned({ q: "hello" });
  assert.deepEqual(signed, { secret: "signed-ok", q: "hello" });
  const call = browser.calls.find((c) => c.url.includes("/api/signed"));
  assert.ok(call.headers["x-signature"], "signed by the page's wrapper, not by site-to-api");
});

test("auto transport: public calls go direct, signed calls go through the page", async (t) => {
  const { model } = await shop(t);
  const browser = new FakeBrowser();
  const api = await siteApi(model.site, { model, bridge: async () => browser, session: false });
  assert.equal((await api.getSigned({ q: "x" })).secret, "signed-ok");
  assert.ok(browser.calls.some((c) => c.url.includes("/api/signed")));
});

test("direct calls with an exported session send its cookies", async (t) => {
  const { model, site } = await shop(t);
  const recorder = new NodeRecorder(site.origin);
  await recorder.request("GET", "/", { type: "document" });
  const session = {
    site: model.site,
    savedAt: new Date().toISOString(),
    cookies: [...recorder.cookies].map(([name, value]) => ({
      name,
      value,
      domain: "127.0.0.1",
      path: "/",
    })),
  };
  const transport = new DirectTransport(session);
  const response = await transport.send(
    { operationId: "x", origin: site.origin, method: "GET", url: site.origin + "/", headers: {} },
    { auth: [], home: site.origin + "/" },
  );
  assert.equal(response.status, 200);
  assert.match(
    response.text,
    /csrf-[0-9a-f]{8}/,
    "the same session, so the page shows its CSRF token",
  );
});

test("the page transport reuses PageTransport's tab code", () => {
  assert.equal(typeof new PageTransport(async () => ({})).inPage, "function");
});
