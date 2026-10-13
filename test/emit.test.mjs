import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
  buildSiteModel,
  parseCapture,
  toOpenApi,
  toAsyncApi,
  toYaml,
  generateClient,
  markdownReport,
  htmlReport,
  redactedSamples,
  createRedactor,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop } from "./helpers.mjs";

async function shopModel(t) {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(recorder.har()), "flow"), {
    site: new URL(site.origin).host,
  });
  return model;
}

const SECRETS = [/secret-pass/, /eyJhbGciOiJIUzI1NiJ9\.eyJ/, /demo@example\.com/];

test("OpenAPI 3.1: paths, security schemes, extensions, variants", async (t) => {
  const model = await shopModel(t);
  const doc = toOpenApi(model);
  assert.equal(doc.openapi, "3.1.0");
  const list = doc.paths["/api/products"].get;
  assert.equal(list.operationId, "listProducts");
  assert.equal(list["x-pagination"].style, "cursor");
  assert.ok(list["x-confidence"] > 0);
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.equal(doc.components.securitySchemes.csrfToken.in, "header");
  const graphql = doc.paths["/graphql"].post;
  assert.equal(graphql["x-variants"].length, 2);
  assert.equal(graphql.requestBody.content["application/json"].schema.oneOf.length, 2);
  assert.deepEqual(
    doc.paths["/api/products/{productId}"].get.parameters.map((p) => p.name),
    ["productId"],
  );
  assert.ok(doc.paths["/products/{productSlug}"].get["x-page-endpoint"]);
  const cart = doc.paths["/api/cart"].post;
  assert.ok(
    !cart.parameters.some((p) => p.name === "x-csrf-token"),
    "auth headers live in securitySchemes",
  );
});

test("exports never contain passwords, tokens or emails", async (t) => {
  const model = await shopModel(t);
  const outputs = [
    JSON.stringify(toOpenApi(model)),
    toYaml(toOpenApi(model)),
    markdownReport(model),
    htmlReport(model),
    JSON.stringify(redactedSamples(model)),
  ];
  for (const output of outputs) for (const secret of SECRETS) assert.doesNotMatch(output, secret);
});

test("YAML output is plain and stable", async (t) => {
  const yaml = toYaml(toOpenApi(await shopModel(t)));
  assert.match(yaml, /^openapi: "?3\.1\.0"?$/m);
  assert.match(yaml, /^ {4}get:$/m);
  assert.match(yaml, /operationId: listProducts/);
});

test("AsyncAPI describes the streams", async (t) => {
  const doc = toAsyncApi(await shopModel(t));
  assert.equal(doc.asyncapi, "3.0.0");
  assert.ok(Object.keys(doc.operations).some((name) => /send/i.test(name)));
});

test("the generated TypeScript client is valid and typed", async (t) => {
  const client = generateClient(await shopModel(t));
  assert.match(
    client,
    /listProducts\(params\?: ListProductsParams\): Promise<ListProductsResponse>;/,
  );
  assert.match(client, /getProduct\(params: GetProductParams\)/);
  assert.match(client, /paginate: \{\n\s+listProducts/);
  assert.match(client, /productPage\(params: \{ productSlug: string \}\)/);
  const output = ts.transpileModule(client, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(
    output.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
  );
});

test("the HTML report is self-contained docs", async (t) => {
  const html = htmlReport(await shopModel(t));
  assert.match(html, /<title>.+ API<\/title>/);
  assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/);
  assert.match(html, /prefers-color-scheme:dark/);
  const data = JSON.parse(
    /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1],
  );
  assert.equal(data.openapi.openapi, "3.1.0");
});

test("redaction: headers, JWTs, emails, phone and card numbers, custom keys", () => {
  const redactor = createRedactor({ keys: ["voucher"] });
  assert.equal(redactor.header("Authorization", "Bearer x"), "<redacted>");
  assert.equal(
    redactor.text("mail a@b.co or call +1 415 555 0100"),
    "mail <email> or call <phone>",
  );
  assert.equal(redactor.text("card 4111 1111 1111 1111"), "card <card>");
  assert.deepEqual(
    JSON.parse(redactor.body(JSON.stringify({ password: "x", voucher: "v", id: 1700000000000 }))),
    { password: "<redacted>", voucher: "<redacted>", id: 1700000000000 },
  );
});
