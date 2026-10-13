// A small shop that exercises everything site-to-api maps: REST with cursor and page-number
// pagination, GraphQL (named and persisted), JSON-RPC, a response that changes shape by a query
// parameter, CSRF from a meta tag, a bearer token from a login call, a request signed by the
// page's own fetch wrapper, server-rendered pages with embedded data, SSE, and analytics noise.
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

export const SIGNING_SECRET = "fixture-secret";

const products = Array.from({ length: 23 }, (_, i) => ({
  id: 1000 + i,
  slug: `product-${["red", "blue", "green", "black"][i % 4]}-${i}`,
  name: `Product ${i}`,
  price: 10 + i,
  currency: "USD",
  createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  category: ["shoes", "hats", "bags"][i % 3],
}));

const reviews = (id) =>
  Array.from({ length: 7 }, (_, i) => ({
    id: `${id}-r${i}`,
    rating: 1 + (i % 5),
    body: `Review ${i}`,
    author: { name: `User ${i}`, id: 50 + i },
  }));

export function sign(method, path, timestamp) {
  return createHmac("sha256", SIGNING_SECRET)
    .update(`${method} ${path} ${timestamp}`)
    .digest("hex");
}

function cookies(request) {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(/;\s*/)
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

const PAGE_SCRIPT = `
const realFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.pathname.startsWith('/api/signed')) {
    const ts = String(Date.now());
    const headers = new Headers(init.headers || {});
    headers.set('x-timestamp', ts);
    headers.set('x-signature', window.__sign((init.method || 'GET') + ' ' + url.pathname + url.search + ' ' + ts));
    init = { ...init, headers };
  }
  return realFetch(input, init);
};`;

function page(title, extra = "", session = "") {
  return `<!doctype html><html><head><title>${title}</title><meta name="csrf-token" content="${session ? csrfFor(session) : "anon"}">
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ buildId: "build-7f3a9c", page: "/", props: { pageProps: { featured: products.slice(0, 3) } } })}</script>
</head><body><h1>${title}</h1>${extra}
<a href="/products/${products[0].slug}">first</a> <a href="/categories/shoes">Shoes</a> <a href="/about">About</a>
<form action="/newsletter" method="post"><input type="hidden" name="authenticity_token" value="form-token-123"><input name="email"></form>
<script>window.__sign = ${signInPage.toString()};${PAGE_SCRIPT}</script></body></html>`;
}

// The page signs with the same HMAC through WebCrypto-free code: a tiny SHA-256 HMAC is too long
// to inline, so the fixture exposes its signer as an endpoint the page calls synchronously.
function signInPage(text) {
  // eslint-disable-next-line no-undef -- runs in the browser page
  const request = new XMLHttpRequest();
  request.open("GET", "/sign?text=" + encodeURIComponent(text), false);
  request.send();
  return request.responseText;
}

const sessions = new Map();
function csrfFor(session) {
  if (!sessions.has(session)) sessions.set(session, "csrf-" + randomUUID().slice(0, 8));
  return sessions.get(session);
}

let throttled = 0;

const routes = [
  [
    "GET",
    /^\/$/,
    (req, res, _m, ctx) => html(res, page("Shop", "<p>Welcome</p>", ctx.session), ctx),
  ],
  [
    "GET",
    /^\/products\/([\w-]+)$/,
    (req, res, m, ctx) => {
      const product = products.find((p) => p.slug === m[1]);
      if (!product) return json(res, 404, { error: "not found" });
      html(
        res,
        page(
          product.name,
          `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: product.name, offers: { price: product.price, priceCurrency: "USD" } })}</script><div class="product"><h2 class="name">${product.name}</h2><span class="price">$${product.price}.00</span></div>`,
          ctx.session,
        ),
        ctx,
      );
    },
  ],
  [
    "GET",
    /^\/sign$/,
    (req, res, _m, ctx) => {
      const text = ctx.url.searchParams.get("text") ?? "";
      const [method, path, ts] = text.split(" ");
      res.end(sign(method, path, ts));
    },
  ],
  [
    "GET",
    /^\/api\/products$/,
    (req, res, _m, ctx) => {
      const limit = Number(ctx.url.searchParams.get("limit") ?? 5);
      const start = ctx.url.searchParams.get("cursor")
        ? Number(Buffer.from(ctx.url.searchParams.get("cursor"), "base64url").toString())
        : 0;
      const items = products.slice(start, start + limit);
      const next =
        start + limit < products.length
          ? Buffer.from(String(start + limit)).toString("base64url")
          : null;
      json(res, 200, { items, nextCursor: next, total: products.length });
    },
  ],
  [
    "GET",
    /^\/api\/products\/(\d+)$/,
    (req, res, m) => {
      const product = products.find((p) => p.id === Number(m[1]));
      if (!product) return json(res, 404, { error: "not found" });
      json(res, 200, { product: { ...product, description: "A product", tags: ["a", "b"] } });
    },
  ],
  [
    "GET",
    /^\/api\/products\/(\d+)\/reviews$/,
    (req, res, m, ctx) => {
      const pageNo = Number(ctx.url.searchParams.get("page") ?? 1);
      const all = reviews(m[1]);
      json(res, 200, {
        reviews: all.slice((pageNo - 1) * 3, pageNo * 3),
        page: pageNo,
        totalPages: Math.ceil(all.length / 3),
      });
    },
  ],
  [
    "GET",
    /^\/api\/feed$/,
    (req, res, _m, ctx) => {
      const type = ctx.url.searchParams.get("type");
      if (type === "news")
        json(res, 200, { headline: "Sale", body: "Big sale", publishedAt: "2026-02-01T10:00:00Z" });
      else json(res, 200, { deals: [{ sku: "a", discount: 10 }], expires: "2026-03-01T00:00:00Z" });
    },
  ],
  [
    "POST",
    /^\/api\/login$/,
    async (req, res) => {
      const data = await body(req);
      if (data.username !== "demo" || data.password !== "secret-pass")
        return json(res, 401, { error: "bad credentials" });
      json(res, 200, {
        accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLXZhbHVl",
        expiresIn: 3600,
      });
    },
  ],
  [
    "GET",
    /^\/api\/me$/,
    (req, res) => {
      if (
        req.headers.authorization !==
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLXZhbHVl"
      )
        return json(res, 401, { error: "signed out" });
      json(res, 200, { user: { id: 7, name: "Demo User", email: "demo@example.com" } });
    },
  ],
  [
    "POST",
    /^\/api\/cart$/,
    async (req, res, _m, ctx) => {
      const data = await body(req);
      if (!ctx.session || req.headers["x-csrf-token"] !== csrfFor(ctx.session))
        return json(res, 403, { error: "csrf" });
      json(res, 200, {
        cartId: "cart-" + ctx.session.slice(0, 6),
        items: [{ productId: data.productId, quantity: data.quantity }],
        requestId: data.requestId,
      });
    },
  ],
  [
    "GET",
    /^\/api\/signed$/,
    (req, res, _m, ctx) => {
      const ts = req.headers["x-timestamp"];
      const expected = sign("GET", "/api/signed" + ctx.url.search, ts);
      if (req.headers["x-signature"] !== expected)
        return json(res, 403, { error: "bad signature" });
      json(res, 200, { secret: "signed-ok", q: ctx.url.searchParams.get("q") });
    },
  ],
  [
    "GET",
    /^\/api\/flaky$/,
    (req, res) => {
      if (throttled++ % 2 === 0)
        return json(res, 429, { error: "slow down" }, { "retry-after": "0" });
      json(res, 200, { ok: true });
    },
  ],
  [
    "POST",
    /^\/graphql$/,
    async (req, res) => {
      const data = await body(req);
      const name = data.operationName;
      if (name === "SearchProducts") {
        const hits = products.filter((p) =>
          p.name.toLowerCase().includes(String(data.variables?.term ?? "").toLowerCase()),
        );
        return json(res, 200, {
          data: {
            search: {
              edges: hits
                .slice(0, 3)
                .map((p) => ({ node: { id: p.id, name: p.name, price: p.price } })),
              pageInfo: { endCursor: "c3", hasNextPage: hits.length > 3 },
            },
          },
        });
      }
      if (
        data.extensions?.persistedQuery?.sha256Hash ===
        "abc123def4567890abc123def4567890abc123def4567890abc123def4567890"
      )
        return json(res, 200, {
          data: {
            category: {
              slug: data.variables?.slug,
              count: 4,
              name: "Category " + data.variables?.slug,
            },
          },
        });
      json(res, 400, { errors: [{ message: "unknown operation" }] });
    },
  ],
  [
    "POST",
    /^\/rpc$/,
    async (req, res) => {
      const data = await body(req);
      if (data.method === "inventory.check")
        return json(res, 200, {
          jsonrpc: "2.0",
          id: data.id,
          result: { sku: data.params?.sku, inStock: true, quantity: 12 },
        });
      if (data.method === "store.hours")
        return json(res, 200, {
          jsonrpc: "2.0",
          id: data.id,
          result: { open: "09:00", close: "21:00" },
        });
      json(res, 200, {
        jsonrpc: "2.0",
        id: data.id,
        error: { code: -32601, message: "no method" },
      });
    },
  ],
  [
    "POST",
    /^\/collect$/,
    (req, res) => {
      res.writeHead(204);
      res.end();
    },
  ],
  [
    "GET",
    /^\/events$/,
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: price\ndata: ${JSON.stringify({ sku: "a", price: 10 })}\n\n`);
    },
  ],
  [
    "GET",
    /^\/static\/app\.js$/,
    (req, res) => {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("console.log(1)");
    },
  ],
];

function html(res, text, ctx) {
  const headers = { "content-type": "text/html" };
  if (ctx.newSession) headers["set-cookie"] = `sid=${ctx.session}; Path=/; HttpOnly`;
  res.writeHead(200, headers);
  res.end(text);
}

export async function startFixtureSite() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const jar = cookies(req);
    const ctx = { url, session: jar.sid, newSession: false };
    if (!ctx.session && req.method === "GET" && !url.pathname.startsWith("/api")) {
      ctx.session = randomUUID();
      ctx.newSession = true;
    }
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (match && req.method === method) {
        try {
          await handler(req, res, match, ctx);
        } catch (error) {
          json(res, 500, { error: String(error) });
        }
        return;
      }
    }
    json(res, 404, { error: "no route" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)), products };
}
