import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { saveFlow, rebuild, serve, siteName } from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop, tempHome } from "./helpers.mjs";

async function mapped(t) {
  const home = await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  const name = siteName(site.origin);
  await saveFlow(
    name,
    { name: "shop", recordedAt: new Date().toISOString() },
    (await browseShop(site.origin)).har(),
  );
  await rebuild(name);
  return { home, site, name };
}

test("the REST server: docs, spec, operation calls, the site's own paths, and a token", async (t) => {
  const { name } = await mapped(t);
  const server = await serve({ transport: "direct", session: false });
  t.after(() => server.close());
  const base = `${server.url}/sites/${encodeURIComponent(name)}`;
  assert.match(
    await (await fetch(server.url + "/")).text(),
    new RegExp(name.replace(/\./g, "\\.")),
  );
  assert.match(await (await fetch(`${base}/docs`)).text(), /<title>/);
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  assert.equal(spec.servers[0].url, `${base}/api`);
  const denied = await fetch(`${base}/ops/listProducts`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 401);
  const headers = { "x-site-to-api-token": server.token, "content-type": "application/json" };
  const list = await (
    await fetch(`${base}/ops/listProducts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: 3 }),
    })
  ).json();
  assert.equal(list.items.length, 3);
  const product = await (await fetch(`${base}/api/api/products/1002`, { headers })).json();
  assert.equal(product.product.id, 1002);
  const foreign = await fetch(`${base}/ops/listProducts`, {
    method: "POST",
    headers: { ...headers, origin: "https://evil.example" },
    body: "{}",
  });
  assert.equal(foreign.status, 403);
  const fromExtension = await fetch(`${base}/ops/listProducts`, {
    method: "POST",
    headers: { ...headers, origin: "chrome-extension://kcfodpkdfapojnbhkgdlpkikipneejpf" },
    body: JSON.stringify({ limit: 1 }),
  });
  assert.equal(fromExtension.status, 200, "browser extensions may call, with the token");
});

function mcp(env, args) {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp", ...args], {
    env: { ...process.env, ...env },
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  return {
    request: (method, params = {}) =>
      new Promise((done) => {
        waiting.set(++id, done);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    close: () => child.kill(),
  };
}

test("MCP: one tool per operation for a site, and general tools across sites", async (t) => {
  const { home, name } = await mapped(t);
  const site = mcp({ SITE_TO_API_HOME: home, BROWSER_USE_EXTENSION_HOME: home }, [name]);
  t.after(() => site.close());
  await site.request("initialize", { protocolVersion: "2025-06-18" });
  const { result } = await site.request("tools/list");
  const tools = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
  assert.ok(
    tools.listProducts.inputSchema.properties.maxItems,
    "paginated operations can fetch every page",
  );
  assert.deepEqual(tools.getProduct.inputSchema.required, ["productId"]);
  assert.equal(tools.createCart.annotations.readOnlyHint, false);
  const call = await site.request("tools/call", {
    name: "listProducts",
    arguments: { limit: 5, maxItems: 12 },
  });
  assert.equal(JSON.parse(call.result.content[0].text).length, 12);

  const general = mcp({ SITE_TO_API_HOME: home, BROWSER_USE_EXTENSION_HOME: home }, []);
  t.after(() => general.close());
  const listed = await general.request("tools/call", { name: "list_sites", arguments: {} });
  assert.equal(JSON.parse(listed.result.content[0].text)[0].site, name);
  const called = await general.request("tools/call", {
    name: "call_operation",
    arguments: { site: name, operation: "getProduct", params: { productId: 1001 } },
  });
  assert.equal(JSON.parse(called.result.content[0].text).product.id, 1001);
});
