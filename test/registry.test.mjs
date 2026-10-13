import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  saveFlow,
  rebuild,
  importCaptures,
  loadModel,
  versions,
  writeOverrides,
  siteDir,
  checkHealth,
  coverage,
  loadFlows,
  encodeTnetstring,
  siteName,
  listSites,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop, tempHome } from "./helpers.mjs";

async function mapped(t) {
  await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  const name = siteName(site.origin);
  const recorder = await browseShop(site.origin);
  await saveFlow(
    name,
    { name: "shop", recordedAt: new Date().toISOString(), startUrl: site.origin + "/" },
    recorder.har(),
  );
  const built = await rebuild(name);
  return { site, name, built };
}

test("the registry keeps the model, exports, flows and versions", async (t) => {
  const { name, built } = await mapped(t);
  assert.equal(built.version, 1);
  const dir = siteDir(name);
  for (const file of [
    "model.json",
    "openapi.json",
    "openapi.yaml",
    "asyncapi.yaml",
    "client.ts",
    "report.md",
    "report.html",
    "events.jsonl",
  ])
    assert.ok(await readFile(join(dir, file), "utf8"), file);
  assert.equal((await listSites())[0].site, name);
  const again = await rebuild(name);
  assert.equal(again.changed, false, "an unchanged rebuild is not a new version");
  await writeOverrides(name, { names: { getMe: "currentUser" } });
  const renamed = await rebuild(name);
  assert.equal(renamed.version, 2);
  assert.ok(
    renamed.diff.added.includes("currentUser") ||
      renamed.diff.changed.some((c) => c.id === "currentUser"),
  );
  assert.equal((await versions(name)).length, 2);
  const events = (await readFile(join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((e) => e.type),
    ["version", "version"],
  );
});

test("imports merge new captures into the same API", async (t) => {
  const { name, site } = await mapped(t);
  const flow = encodeTnetstring({
    type: "http",
    request: {
      method: Buffer.from("GET"),
      scheme: Buffer.from("http"),
      host: Buffer.from("127.0.0.1"),
      port: Number(new URL(site.origin).port),
      path: Buffer.from("/api/products/1007"),
      headers: [],
      content: Buffer.alloc(0),
      timestamp_start: 1800000000,
    },
    response: {
      status_code: 200,
      headers: [[Buffer.from("content-type"), Buffer.from("application/json")]],
      content: Buffer.from(JSON.stringify({ product: { id: 1007, name: "P", warranty: "2y" } })),
    },
  });
  const path = join(siteDir(name), "extra.flows");
  await writeFile(path, flow);
  await importCaptures(name, [path]);
  const { model } = await rebuild(name);
  const getProduct = model.operations.find((o) => o.id === "getProduct");
  assert.equal(getProduct.sampleCount, 3);
  assert.ok(getProduct.responses["200"].schema.properties.product);
});

test("health probes replay samples and catch drift", async (t) => {
  const { name } = await mapped(t);
  const healthy = await checkHealth(name, { transport: "direct", session: false });
  const status = Object.fromEntries(healthy.results.map((r) => [r.id, r.status]));
  assert.equal(status.listProducts, "ok");
  assert.equal(status.createCart, "skipped", "actions are not probed unless asked");
  assert.equal(status.getMe, "signed-out");
  const model = await loadModel(name);
  const schema = model.operations.find((o) => o.id === "getFeedNews").responses["200"].schema;
  schema.properties.author = { type: "string" };
  schema.required.push("author");
  await writeFile(join(siteDir(name), "model.json"), JSON.stringify(model));
  const drifted = await checkHealth(name, {
    transport: "direct",
    session: false,
    operations: ["getFeedNews"],
  });
  assert.equal(drifted.results[0].status, "drift");
  assert.match(drifted.results[0].changes.join("\n"), /\/author \(required\) missing/);
  const events = await readFile(join(siteDir(name), "events.jsonl"), "utf8");
  assert.match(events, /"type":"health"/);
});

test("coverage suggests flows that widen the API", async (t) => {
  const { name } = await mapped(t);
  const model = await loadModel(name);
  const { exchanges } = await loadFlows(name);
  const suggestions = coverage(model, exchanges);
  assert.ok(suggestions.some((s) => s.kind === "confirm" && s.operationId === "storeHours"));
  assert.ok(suggestions.some((s) => s.kind === "visit" && /categories/.test(s.url)));
  assert.ok(suggestions.some((s) => s.kind === "submit" && /newsletter/.test(s.message)));
});
