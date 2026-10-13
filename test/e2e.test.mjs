// End to end in real Chrome: the Browser Use Extension records a session on the fixture shop,
// site-to-api builds its API, then calls it inside the page (cookies, CSRF and the page's own
// request signing apply) and from Node with an exported session. Uses a private, headless
// Chrome for Testing profile and a private bridge.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import WebSocket from "ws";
import { startFixtureSite } from "./fixture-site.mjs";

const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const bue = resolve(process.env.BUE_DIR ?? "../browser-use-extension");
const extension = join(bue, "apps/extension/build");
const bueCli = join(bue, "apps/bridge/dist/cli.js");
// Chrome for Testing (branded Chrome ignores --load-extension).
const chromePath = process.env.CHROME_PATH ?? "";
const cli = resolve("dist/cli.js");
const ready = !!chromePath && existsSync(chromePath) && existsSync(extension) && existsSync(bueCli);

test(
  "record in real Chrome, build, call in the page and from Node",
  { skip: !process.env.REQUIRE_E2E && !ready, timeout: 300_000 },
  async (t) => {
    const { env, site } = await launch(t);

    const api = await import("../dist/index.js");
    const name = api.siteName(site.origin);

    await t.test("a recorded session becomes an API", () => recordAndBuild(api, name, site));

    await t.test("calls run inside the page with the site's own signing and CSRF", async () => {
      const shop = await api.siteApi(name, { transport: "page" });
      assert.deepEqual(await shop.getSigned({ q: "live" }), { secret: "signed-ok", q: "live" });
      const cart = await shop.createCart({ productId: 1009, quantity: 2 });
      assert.equal(cart.items[0].quantity, 2);
      const all = [];
      for await (const item of shop.paginate.listProducts({ limit: 10 })) all.push(item);
      assert.equal(all.length, site.products.length);
      const page = await shop.productPage({ productSlug: site.products[5].slug });
      assert.equal(page.jsonLd[0].name, site.products[5].name);
    });

    await t.test("an exported session makes calls from Node without the browser", async () => {
      const { stdout } = await run(process.execPath, [cli, "session", name], { env });
      assert.match(stdout, /Saved \d+ cookies/);
      const { stdout: out } = await run(
        process.execPath,
        [cli, "call", name, "getProduct", '{"productId":1004}', "--transport", "direct"],
        { env },
      );
      assert.equal(JSON.parse(out).product.id, 1004);
    });

    await t.test("health checks and repair re-record the flow", async () => {
      const report = await api.checkHealth(name, { transport: "page" });
      assert.equal(report.results.find((r) => r.id === "listProducts").status, "ok");
      const repaired = await api.repair(name, ["listProducts"], { settleMs: 500 });
      assert.equal(repaired.rerecorded.length, 1);
    });
  },
);

/** A private bridge and a headless Chrome for Testing with the extension, both cleaned up after. */
async function launch(t) {
  const bueHome = await mkdtemp(join(tmpdir(), "s2a-bue-"));
  const apiHome = await mkdtemp(join(tmpdir(), "s2a-home-"));
  const profile = await mkdtemp(join(tmpdir(), "s2a-chrome-"));
  const env = {
    ...process.env,
    BROWSER_USE_EXTENSION_HOME: bueHome,
    SITE_TO_API_HOME: apiHome,
    PI_CODING_AGENT_DIR: apiHome,
  };
  Object.assign(process.env, { BROWSER_USE_EXTENSION_HOME: bueHome, SITE_TO_API_HOME: apiHome });
  const site = await startFixtureSite();
  const bridge = spawn(process.execPath, [bueCli, "serve"], { env, stdio: "ignore" });
  let chrome;
  t.after(async () => {
    const { closeSharedBridge } = await import("../dist/index.js");
    await closeSharedBridge();
    chrome?.kill();
    bridge.kill();
    await site.close();
    await sleep(500);
    for (const dir of [bueHome, apiHome, profile])
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await waitFor(() => readFile(join(bueHome, "bridge.json"), "utf8"));
  chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await connectExtension(profile, env);
  return { env, site };
}

async function recordAndBuild(api, name, site) {
  const session = await api.RecordingSession.start({
    url: site.origin + "/",
    foreground: false,
  });
  await session.run(`await page.evaluate(async () => {
  const list = await (await fetch('/api/products?limit=5')).json();
  await fetch('/api/products?limit=5&cursor=' + list.nextCursor);
  for (const item of list.items.slice(0, 3)) await fetch('/api/products/' + item.id);
  for (const q of ['a', 'b', 'c']) await fetch('/api/signed?q=' + q);
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  for (const item of list.items.slice(0, 2))
    await fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ productId: item.id, quantity: 1, requestId: crypto.randomUUID() }) });
  return true;
    })`);
  await session.run(
    `await page.navigate(${JSON.stringify(site.origin + "/products/" + site.products[1].slug)})`,
  );
  await session.run(
    `await page.navigate(${JSON.stringify(site.origin + "/products/" + site.products[2].slug)})`,
  );
  await session.run(
    `await page.navigate(${JSON.stringify(site.origin + "/products/" + site.products[3].slug)})`,
  );
  const recording = await session.stop();
  assert.ok(recording.har.log.entries.length >= 12, `recorded ${recording.har.log.entries.length}`);
  await api.saveRecording(name, recording, { name: "e2e" });
  const { model } = await api.rebuild(name);
  const ids = model.operations.map((o) => o.id).sort();
  for (const id of ["createCart", "getProduct", "getSigned", "listProducts"])
    assert.ok(ids.includes(id), ids.join(", "));
  const signed = model.operations.find((o) => o.id === "getSigned");
  assert.deepEqual(signed.signing?.headers, ["x-signature"]);
  assert.ok(signed.signing.initiator?.url, "the recorder captured the script that made the call");
  assert.ok(model.security.some((s) => s.type === "csrf" && s.source?.kind === "meta"));
  assert.ok(model.pages.some((p) => p.path === "/products/{productSlug}"));
}

async function connectExtension(profile, env) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  });
  const reply = await nativeBootstrap(env);
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const value = await cdp("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (value.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [bueCli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30_000);
}

function nativeBootstrap(env) {
  return new Promise((done, fail) => {
    const host = spawn(
      process.execPath,
      [bueCli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      { env },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", fail);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      done(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      JSON.stringify({
        kind: "native.bootstrap",
        protocolVersion: { major: 1, minor: 6 },
        clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
        browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
      }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    host.stdin.end(Buffer.concat([header, body]));
  });
}

async function waitFor(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(200);
    }
  }
  throw last ?? new Error("timed out");
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return async (method, params = {}) => {
    await opened;
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}
