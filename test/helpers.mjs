// Test helpers: a recorder that browses the fixture site from Node and writes what a browser
// recorder would (HAR with resource types, initiators, cookies, referers), and a scripted session.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "./fixture-site.mjs";

function encodeBody(options, headers) {
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    return JSON.stringify(options.json);
  }
  if (!options.form) return undefined;
  headers["content-type"] = "application/x-www-form-urlencoded";
  return new URLSearchParams(options.form).toString();
}

export class NodeRecorder {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
    this.entries = [];
    this.clock = Date.parse("2026-10-01T10:00:00Z");
    this.page = origin + "/";
  }

  async request(method, path, options = {}) {
    const url = new URL(path, this.origin).href;
    const headers = {
      accept: "*/*",
      "user-agent": "Mozilla/5.0 Test",
      referer: this.page,
      ...(options.headers ?? {}),
    };
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const body = encodeBody(options, headers);
    const startedAt = (this.clock += 1000);
    const response = await fetch(url, { method, headers, body, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      this.cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    const text = await response.text();
    const type = options.type ?? "fetch";
    if (type === "document") this.page = url;
    this.entries.push({
      startedDateTime: new Date(startedAt).toISOString(),
      time: 20,
      _resourceType: type,
      ...(options.initiator ? { _initiator: options.initiator } : {}),
      request: {
        method,
        url,
        headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
        ...(body !== undefined
          ? { postData: { mimeType: headers["content-type"], text: body } }
          : {}),
      },
      response: {
        status: response.status,
        headers: [...response.headers].map(([name, value]) => ({ name, value })),
        content: { mimeType: response.headers.get("content-type") ?? "", text },
      },
    });
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  add(entry) {
    this.entries.push({ startedDateTime: new Date((this.clock += 1000)).toISOString(), ...entry });
  }

  har() {
    return { log: { version: "1.2", entries: this.entries } };
  }
}

/** A realistic session on the fixture shop. */
export async function browseShop(origin) {
  const r = new NodeRecorder(origin);
  const home = await r.request("GET", "/", { type: "document" });
  const csrf = /name="csrf-token" content="([^"]+)"/.exec(home)[1];
  await r.request("GET", "/static/app.js", { type: "script" });
  for (let i = 0; i < 3; i++)
    await r.request("POST", "/collect", {
      json: { events: [{ name: "view", ts: Date.now() }], sid: "abc" },
    });
  const first = await r.request("GET", "/api/products?limit=5");
  await r.request("GET", `/api/products?limit=5&cursor=${first.nextCursor}`);
  for (const item of [first.items[0], first.items[3]])
    await r.request("GET", `/api/products/${item.id}`);
  for (const page of [1, 2])
    await r.request("GET", `/api/products/${first.items[0].id}/reviews?page=${page}`);
  for (const item of first.items.slice(0, 3))
    await r.request("GET", `/products/${item.slug}`, { type: "document" });
  for (const type of ["news", "deals", "news", "deals"])
    await r.request("GET", `/api/feed?type=${type}`);
  const login = await r.request("POST", "/api/login", {
    json: { username: "demo", password: "secret-pass" },
  });
  for (let i = 0; i < 2; i++)
    await r.request("GET", "/api/me", {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
  for (const item of first.items.slice(0, 2))
    await r.request("POST", "/api/cart", {
      json: { productId: item.id, quantity: 1, requestId: randomUUID() },
      headers: { "x-csrf-token": csrf },
    });
  for (const q of ["a", "b", "c"]) {
    const ts = String(r.clock + 1000);
    await r.request("GET", `/api/signed?q=${q}`, {
      headers: { "x-timestamp": ts, "x-signature": sign("GET", `/api/signed?q=${q}`, ts) },
      initiator: {
        type: "script",
        url: `${origin}/`,
        stack: [{ url: `${origin}/static/app.js`, functionName: "signedFetch", line: 12 }],
      },
    });
  }
  for (const term of ["Product 1", "Product 2"])
    await r.request("POST", "/graphql", {
      json: {
        operationName: "SearchProducts",
        query:
          "query SearchProducts($term: String!) { search(term: $term) { edges { node { id name price } } pageInfo { endCursor hasNextPage } } }",
        variables: { term },
      },
    });
  for (const slug of ["shoes", "hats"])
    await r.request("POST", "/graphql", {
      json: {
        variables: { slug },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "abc123def4567890abc123def4567890abc123def4567890abc123def4567890",
          },
        },
      },
    });
  for (const sku of ["a", "b"])
    await r.request("POST", "/rpc", {
      json: { jsonrpc: "2.0", id: 1, method: "inventory.check", params: { sku } },
    });
  await r.request("POST", "/rpc", { json: { jsonrpc: "2.0", id: 2, method: "store.hours" } });
  r.add({
    _resourceType: "eventsource",
    request: { method: "GET", url: `${origin}/events`, headers: [] },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "text/event-stream" }],
      content: { mimeType: "text/event-stream" },
    },
    _eventSourceMessages: [
      { at: 1, event: "price", data: '{"sku":"a","price":10}' },
      { at: 2, event: "price", data: '{"sku":"b","price":12}' },
    ],
  });
  r.add({
    _resourceType: "websocket",
    request: { method: "GET", url: `${origin.replace("http", "ws")}/ws`, headers: [] },
    response: { status: 101, headers: [], content: {} },
    _webSocketMessages: [
      { direction: "sent", at: 1, opcode: 1, data: '{"type":"subscribe","channel":"prices"}' },
      { direction: "received", at: 2, opcode: 1, data: '{"type":"price","sku":"a","price":10}' },
      { direction: "received", at: 3, opcode: 1, data: '{"type":"price","sku":"b","price":11}' },
    ],
  });
  return r;
}

export async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), "site-to-api-"));
  // Tests never reach a real browser bridge: its home is the same empty folder.
  const previous = {
    home: process.env.SITE_TO_API_HOME,
    bridge: process.env.BROWSER_USE_EXTENSION_HOME,
  };
  process.env.SITE_TO_API_HOME = dir;
  process.env.BROWSER_USE_EXTENSION_HOME = dir;
  t.after(async () => {
    for (const [key, value] of [
      ["SITE_TO_API_HOME", previous.home],
      ["BROWSER_USE_EXTENSION_HOME", previous.bridge],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
