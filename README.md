# site-to-api

**Parse any site into a typed API.** Use a site once in your own browser; site-to-api records what it does and turns that into an OpenAPI 3.1 spec, a typed TypeScript client, a local REST API and an MCP server. Then you call it like any other API, with your logins, from code or from an agent.

```bash
npx site-to-api record https://shop.example     # use the site, then press Enter
npx site-to-api call shop.example searchProducts '{"q":"headphones"}'
```

```ts
import { siteApi } from "site-to-api/runtime";

const shop = await siteApi("shop.example");
const results = await shop.searchProducts({ q: "headphones" });
for await (const product of shop.paginate.listProducts({ category: "audio" }))
  console.log(product.name);
```

## Why it works where others don't

- **It records in your real browser.** Every site you are signed in to works, with no cookie copying and no setup per site. A real browser fingerprint means bot walls rarely notice.
- **Calls can run inside the site's own page.** Cookies, CORS, CSRF tokens and request signing all apply as if the site made the call itself. Sites that sign requests with their own JavaScript keep working.
- **Or without a browser.** Public endpoints, and anything you export a session for, are called straight from Node.
- **It keeps working.** Health checks replay recorded calls and compare the answers with the stored schemas. When a site changes, only the broken flow is recorded again and the API gets a new version, with a diff.

## Requirements

- Node.js 22.19 or newer.
- Chrome or Edge with the [Browser Use Extension](https://github.com/gillasg/browser-use-extension), set up once with `npx browser-use-extension setup`. It is only needed to record and to make in-page calls. Building from HAR files, and calling public endpoints, work without it.

## Map a site

| Command                        | What it does                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record <url>`                 | Opens the site in a new tab and records everything while you use it. Press Enter when done.                                                                         |
| `record <url> --attach <tab>`  | Records a tab you already have open (a tab id, or text from its title or URL).                                                                                      |
| `record --passive a.com,b.com` | Records every tab on those domains, including ones opened later, until you press Enter.                                                                             |
| `describe <site> "<flow>"`     | An AI agent performs the flow in your browser while it is recorded (needs a model; see below).                                                                      |
| `explore <site> [site ...]`    | An AI agent uses each site (search, filters, pages, details) in a background tab while it is recorded, then builds it. Several at once; `--goal` adds things to do. |
| `import <site> <files>`        | Adds HAR files (from any tool) or mitmproxy flow files. Captures merge; nothing is overwritten.                                                                     |
| `build <site>`                 | Rebuilds the API from every flow. `--until filter\|normalize\|infer\|trace` stops early and writes each stage's output.                                             |

Each build writes a new version only when the API changed, and prints what changed.

## Use it

| Command                   | What it does                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ops <site>`              | Lists operations and their inputs.                                                                                |
| `call <site> <op> [json]` | Calls an operation. `--param k=v`, `--all` to walk every page, `--transport page\|direct`.                        |
| `serve`                   | A local REST API for every mapped site, with interactive docs. Calls need the printed token.                      |
| `mcp [site]`              | A stdio MCP server: one tool per operation for a site, or tools to list and call any site.                        |
| `session <site>`          | Exports your cookies and web storage for that site, so calls run from Node for 12 hours.                          |
| `export <site>`           | Writes OpenAPI (JSON and YAML), AsyncAPI, the TypeScript client, Markdown and HTML reports, and redacted samples. |

### From code

```ts
import { siteApi } from "site-to-api/runtime";

const api = await siteApi("shop.example", { transport: "auto" }); // or "page" / "direct"
await api.getProduct({ productId: 8812 });
await api.getProduct(); // missing ids are fetched from the operation that lists them
await api.searchProducts({ variables: { term: "lamp" } }); // GraphQL variables
await api.call("addToCart", { productId: 8812, quantity: 1 });
const page = await api.productPage({ productSlug: "red-lamp" }); // server-rendered page data
```

Each mapped site also gets a generated, fully typed client (`client.ts`), so editors autocomplete operations, parameters and responses.

Apps that already drive a browser can plug it in: anything with `run(code, { session, timeoutMs })` and `status()` works as the browser, either per call (`siteApi(site, { bridge: async () => myBrowser })`) or for the whole process (`useBrowser(myBrowser)`).

### MCP

```json
{ "mcpServers": { "shop": { "command": "npx", "args": ["site-to-api", "mcp", "shop.example"] } } }
```

Leave out the site to get `list_sites`, `list_operations`, `call_operation`, `watch_operation` and `explore_sites` across every mapped site.

## What it understands

**Requests**

- XHR, fetch and documents, paired with their responses. Preflights, redirects, failures, static files, analytics, ads, chat widgets and bot-defense traffic are dropped, each with a reason. Endpoints that only ever swallow event batches are learned as noise.
- Include and exclude patterns, and an origin allowlist.

**Paths and operations**

- Path templates from ids (UUIDs, numbers, hex, base62) and from slugs that vary between sibling pages. Parameters are named from their neighbours: `/users/{userId}/orders/{orderId}`.
- One endpoint carrying many operations is split by GraphQL operation name or persisted-query hash, JSON-RPC method, action field, or by a parameter that changes the response's shape.
- Readable operation ids: `listProducts`, `getProduct`, `searchProducts`, `addToCart`.

**Schemas**

- Request and response schemas from every sample: required only when always present, unions, nullables, arrays, maps keyed by id, enums for short repeated values, and formats (date-time, date, uri, email, uuid, ipv4).
- Identical object shapes become named components.

**Where values come from**

- Every value a request sends is traced to the earlier response, cookie, meta tag, hidden form input or web storage entry it came from. The runtime uses this to fill missing inputs by calling the producing operation first.
- Values the page makes up itself (UUIDs, timestamps, nonces) are generated fresh on every call.

**Auth**

- Session cookies, bearer tokens (and the call or storage entry they come from), API keys in headers or query strings, basic auth and CSRF tokens, emitted as real OpenAPI security schemes. Token endpoints are used to renew tokens.

**Signed requests**

- Headers and parameters that look like signatures are detected, with the script and function that built them (`signing <site> <op>` prints that code). Calls go through the page's own `fetch` or `XMLHttpRequest`, so the site's hooks sign them. A custom in-page signer can be set in the overrides.

**Pagination**

- Cursors (proven when a request carries the previous response's value), offsets, page numbers, next links and `Link` headers, with item lists, "has more" flags and totals. Every paginated operation is an async iterator.

**Pages without an API**

- Server-rendered pages become page endpoints that return their embedded data: Next.js, Nuxt, Apollo and Redux state, JSON-LD and JSON scripts.
- CSS extractors (in the overrides) turn any page into typed records.

**Streams**

- WebSocket frames and server-sent events become channels with typed messages, exported as AsyncAPI 3.0.

## Keep it working

| Command                   | What it does                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `heal <site>`             | Replays recorded read calls and compares the answers with the stored schemas: ok, drift, broken or signed out. `--include-actions` probes writes too.  |
| `heal <site> --repair`    | Records the flows behind failing operations again (repeating their saved steps), rebuilds, and checks again.                                           |
| `diff <site> [from] [to]` | What changed between two versions.                                                                                                                     |
| `coverage <site>`         | Flows that would widen the API: operations seen once, unconfirmed pagination, missing list or detail endpoints, unvisited pages and unsubmitted forms. |

Results go to `health.json` and `events.jsonl` in the site's folder, so other tools can react.

## Optional AI features

Recording, building and calling never need a model. These do:

- `describe <site> "<flow>"`: an agent performs the flow in your browser while it is recorded. Its steps are saved, so repairs repeat them without a model.
- `explore <site> [site ...]`: map sites by name; an agent uses each one (looking only, never buying or posting) while it is recorded.
- `edit <site> "<change>"`: change the API in plain English ("rename getMe to currentUser", "add a page extractor for product pages with name and price").
- `name <site>`: better operation names and descriptions.

They use the model you signed in to with `npx site-to-api login`: Claude, ChatGPT, GitHub Copilot, or an API key from many providers. The sign-in is shared with Pi and every app built on it.

## Files

Everything lives in `~/.site-to-api` (or `SITE_TO_API_HOME`):

```
sites/<site>/
  model.json              the full model (kept private: 0600)
  openapi.json, .yaml     the spec, redacted
  asyncapi.yaml           streams, if any
  client.ts               the typed client
  report.md, report.html  readable reports and docs
  overrides.json          your edits (survive rebuilds)
  flows/                  recorded captures and their steps
  versions/               every version, with diffs
  health.json, events.jsonl
  session.json            exported session, when you ask for one (0600)
noise.json                noise learned across sites
```

### Overrides

```json
{
  "templates": ["/api/items/{itemId}"],
  "names": { "getApiV2Cart": "getCart" },
  "descriptions": { "getCart": "The signed-in user's cart." },
  "drop": ["listExperiments"],
  "exclude": ["/api/telemetry"],
  "origins": ["shop.example"],
  "redact": { "headers": ["x-device-id"], "keys": ["voucher"], "patterns": ["ORD-\\d+"] },
  "pages": [
    {
      "id": "productPage",
      "url": "https://shop.example/p/{slug}",
      "fields": [{ "name": "price", "selector": ".price", "type": "number" }]
    }
  ],
  "signers": { "getFeed": "async (request) => window.siteClient.get(request.url)" }
}
```

## Privacy and safety

- Everything stays on your machine. Exported specs, reports, samples and curl examples are redacted: auth headers, cookies, tokens, JWTs, passwords, emails, phone and card numbers, plus your own patterns.
- Passwords are never stored, not even in the local model.
- The REST server listens on 127.0.0.1 only, checks the Host and Origin headers, and requires a token for calls.
- Calls are rate limited per site (5 per second, 4 at once by default) and back off on 429 and 5xx answers, honouring `Retry-After`.

## Development

```bash
node scripts/link-repos.mjs   # clones and builds the repos it links to, next to this one
pnpm install
pnpm check                    # format, types, lint, build, tests
```

Shared code comes from sibling folders through live links (`link:../pi-ai-login`), so a change there is used here on the next build, with nothing copied or committed. `node scripts/link-repos.mjs --revisions` prints the revision of each linked repo.

The end-to-end test records and calls a local test site in a private, headless Chrome for Testing with the Browser Use Extension. It runs when it finds the extension (`BUE_DIR`, default `../browser-use-extension`) and Chrome (`CHROME_PATH`), and always in CI.

## License

MIT
