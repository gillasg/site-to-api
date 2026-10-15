import assert from "node:assert/strict";
import test from "node:test";
import {
  performFlow,
  explore,
  editApi,
  nameOperations,
  saveFlow,
  rebuild,
  readOverrides,
  loadModel,
  siteName,
  listFlows,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop, tempHome } from "./helpers.mjs";
import { FakeBrowser } from "./fake-browser.mjs";

/** A model that answers with a fixed script of tool calls, and records what it was shown. */
function scriptedModel(turns) {
  const seen = [];
  let index = 0;
  return {
    seen,
    complete: async (context) => {
      seen.push(context);
      const turn = turns[index++] ?? { text: "done" };
      if (turn.text) return { role: "assistant", content: [{ type: "text", text: turn.text }] };
      return {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${index}`, name: turn.tool, arguments: turn.args }],
      };
    },
  };
}

test("describe a flow: the agent drives the browser while it is recorded, and the steps are kept", async (t) => {
  await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  const name = siteName(site.origin);
  const code = `await page.inspect("fetch('/api/products?limit=2').then((r) => r.json()).then((j) => j.items.length)")`;
  const model = scriptedModel([
    { tool: "browser_code", args: { code } },
    { tool: "browser_code", args: { code: "throw new Error('no such button')" } },
    { tool: "done", args: { summary: "Listed two products." } },
  ]);
  const browser = new FakeBrowser();
  const result = await performFlow(name, "list two products", {
    startUrl: site.origin + "/",
    model,
    bridge: async () => browser,
  });
  assert.equal(result.summary, "Listed two products.");
  assert.deepEqual(result.steps, [code], "only steps that worked are kept for replay");
  const results = model.seen[2].messages.filter((m) => m.role === "toolResult");
  assert.equal(results[0].content[0].text, "2");
  assert.equal(results[1].isError, true);
  const [flow] = await listFlows(name);
  assert.equal(flow.meta.description, "list two products");
  assert.deepEqual(flow.meta.steps, [code]);
  const { model: api } = await rebuild(name);
  assert.ok(api.operations.some((op) => op.id === "listProducts"));
});

test("edit in plain English: the model rewrites the overrides and the API is rebuilt", async (t) => {
  await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  const name = siteName(site.origin);
  await saveFlow(
    name,
    { name: "shop", recordedAt: new Date().toISOString() },
    (await browseShop(site.origin)).har(),
  );
  await rebuild(name);
  const model = scriptedModel([
    { tool: "page_html", args: { url: site.origin + "/" } },
    {
      tool: "set_overrides",
      args: {
        overrides: { names: { getMe: "currentUser" }, drop: ["storeHours"] },
        note: "Renamed getMe and dropped storeHours.",
      },
    },
  ]);
  const result = await editApi(name, "call getMe currentUser and drop store hours", {
    model,
    pageHtml: async () => "<html>home</html>",
  });
  assert.equal(result.note, "Renamed getMe and dropped storeHours.");
  assert.match(model.seen[0].messages[0].content, /getMe: GET/);
  assert.equal(
    model.seen[1].messages.find((m) => m.role === "toolResult").content[0].text,
    "<html>home</html>",
  );
  assert.deepEqual((await readOverrides(name)).drop, ["storeHours"]);
  const ids = (await loadModel(name)).operations.map((op) => op.id);
  assert.ok(ids.includes("currentUser") && !ids.includes("storeHours"));
});

test("AI names: new ids and descriptions land in the overrides", async (t) => {
  await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  const name = siteName(site.origin);
  await saveFlow(
    name,
    { name: "shop", recordedAt: new Date().toISOString() },
    (await browseShop(site.origin)).har(),
  );
  await rebuild(name);
  const model = scriptedModel([
    {
      tool: "set_names",
      args: {
        names: { getFeedNews: "latestNews" },
        descriptions: { getFeedNews: "The news banner." },
      },
    },
  ]);
  await nameOperations(name, { model });
  const operation = (await loadModel(name)).operations.find((op) => op.id === "latestNews");
  assert.equal(operation.description, "The news banner.");
});

test("explore maps sites by name or URL: the agent uses each one while it is recorded", async (t) => {
  await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  const code = `await page.inspect("fetch('/api/products?limit=2').then((r) => r.json()).then((j) => j.items.length)")`;
  const model = scriptedModel([
    { tool: "browser_code", args: { code } },
    { tool: "done", args: { summary: "Searched and opened products." } },
  ]);
  const browser = new FakeBrowser();
  const seen = [];
  const results = await explore([site.origin + "/", site.origin + "/again"], {
    model,
    bridge: async () => browser,
    onSite: (result) => seen.push(result.site),
  });
  assert.equal(results.length, 1, "the same site twice is explored once");
  assert.equal(results[0].summary, "Searched and opened products.");
  assert.ok(results[0].operations >= 1, JSON.stringify(results[0]));
  assert.deepEqual(seen, [siteName(site.origin)]);
  assert.match(model.seen[0].messages[0].content, /never buy/);
  assert.ok(
    (await loadModel(siteName(site.origin))).operations.some((op) => op.id === "listProducts"),
  );
});
