import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSiteModel,
  channelStartExpression,
  errorKind,
  HttpError,
  MissingParams,
  parseCapture,
  SignedOut,
  siteApi,
  summarizeDocs,
  docsTargets,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop } from "./helpers.mjs";

async function shop(t) {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(recorder.har()), "flow"), {
    site: new URL(site.origin).host,
  });
  return { site, model };
}

test("a multi-step action runs its operations in order, each fed by the last", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, {
    model,
    transport: "direct",
    session: false,
    actions: {
      firstProductReviews: {
        description: "Reviews of a product from the list",
        steps: [
          { operation: "listProducts", params: { limit: 2 } },
          { operation: "getProduct", params: { productId: "{{steps.0.items.1.id}}" } },
          { operation: "listProductsReviews" },
        ],
      },
    },
  });
  assert.deepEqual(Object.keys(api.actions), ["firstProductReviews"]);
  const result = await api.firstProductReviews();
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[1].result.product.id, result.steps[0].result.items[1].id);
  assert.ok(Array.isArray(result.result.reviews));
  await assert.rejects(() => api.action("nope"), /has no action nope/);
});

test("a failing step names the step", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, {
    model,
    transport: "direct",
    session: false,
    actions: { broken: { steps: [{ operation: "listProducts" }, { operation: "missingOp" }] } },
  });
  await assert.rejects(() => api.action("broken"), /Step 2 \(missingOp\)/);
});

test("errors say what kind of failure they are", () => {
  assert.equal(errorKind(new SignedOut("x", { status: 401, headers: {}, text: "" })), "signed-out");
  assert.equal(errorKind(new MissingParams({ id: "op" }, ["path:id"])), "missing-input");
  assert.equal(errorKind(new HttpError("x", { status: 500, headers: {}, text: "" })), "broken");
  assert.equal(
    errorKind(
      new Error("x", { cause: new SignedOut("x", { status: 403, headers: {}, text: "" }) }),
    ),
    "signed-out",
  );
  assert.equal(errorKind(new Error("x")), "failed");
});

test("channels open from the page and collect what arrives", () => {
  const code = channelStartExpression(
    { id: "feed", kind: "websocket", url: "wss://example.com/live" },
    "k",
    { send: [{ type: "subscribe" }], match: "price" },
  );
  assert.match(code, /new WebSocket/);
  assert.match(code, /subscribe/);
  assert.match(code, /"match":"price"/);
});

test("published docs: usual paths on each origin, GraphQL endpoints from the model", () => {
  const targets = docsTargets({
    site: "example.com",
    origins: ["https://example.com"],
    operations: [{ kind: "graphql", path: "/graphql", origin: "https://api.example.com" }],
  });
  assert.ok(targets.docs.includes("https://example.com/openapi.json"));
  assert.deepEqual(targets.graphql, ["https://api.example.com/graphql"]);
  const summary = summarizeDocs({
    openapi: [
      {
        url: "https://example.com/openapi.json",
        title: "Shop",
        document: { openapi: "3.1.0", paths: { "/items": { get: { summary: "List items" } } } },
      },
    ],
    graphql: [
      {
        url: "https://api.example.com/graphql",
        schema: {
          queryType: { name: "Query" },
          mutationType: null,
          types: [{ name: "Query", fields: [{ name: "item", args: [{ name: "id" }] }] }],
        },
      },
    ],
  });
  assert.deepEqual(summary.openapi[0].operations, ["GET /items (List items)"]);
  assert.deepEqual(summary.graphql[0].queries, ["item(id)"]);
  assert.deepEqual(summary.graphql[0].mutations, []);
});
