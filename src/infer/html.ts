// Reading server-rendered pages without a DOM: embedded app state, JSON-LD, meta tags and
// hidden form inputs. Used when building and by the runtime's direct calls to page endpoints.

export interface Embedded {
  next?: unknown;
  nuxt?: unknown;
  apollo?: unknown;
  redux?: unknown;
  jsonLd?: unknown[];
  json?: unknown[];
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function attr(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    attributes,
  );
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&amp;/g, "&");
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

/** The object literal starting at `start` (a `{`), respecting strings: `{...}` up to its match. */
export function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

const ASSIGNMENTS: [keyof Embedded, RegExp][] = [
  ["apollo", /window\.__APOLLO_STATE__\s*=\s*/],
  [
    "redux",
    /window\.(__PRELOADED_STATE__|__INITIAL_STATE__|__REDUX_STATE__|__STATE__|__DATA__)\s*=\s*/,
  ],
];

function assignment(body: string, pattern: RegExp): unknown {
  const match = pattern.exec(body);
  if (!match) return undefined;
  const start = body.indexOf("{", match.index + match[0].length - 1);
  const literal = start >= 0 ? balancedObject(body, start) : undefined;
  return literal ? tryJson(literal) : undefined;
}

function pushJson(
  list: unknown[] | undefined,
  body: string,
  objectsOnly: boolean,
): unknown[] | undefined {
  const value = tryJson(body);
  if (value === undefined || (objectsOnly && (!value || typeof value !== "object"))) return list;
  return [...(list ?? []), value];
}

function scriptData(embedded: Embedded, attributes: string, body: string): void {
  const id = attr(attributes, "id");
  const type = attr(attributes, "type")?.toLowerCase();
  if (id === "__NEXT_DATA__") embedded.next = tryJson(body);
  else if (id === "__NUXT_DATA__") embedded.nuxt = tryJson(body);
  else if (type === "application/ld+json") embedded.jsonLd = pushJson(embedded.jsonLd, body, false);
  else if (type === "application/json") embedded.json = pushJson(embedded.json, body, true);
  else
    for (const [key, pattern] of ASSIGNMENTS) {
      const value = assignment(body, pattern);
      if (value !== undefined) (embedded as Record<string, unknown>)[key] = value;
    }
}

export function extractEmbedded(html: string): Embedded {
  const embedded: Embedded = {};
  for (const match of html.matchAll(SCRIPT)) scriptData(embedded, match[1] ?? "", match[2] ?? "");
  return embedded;
}

export function embeddedKinds(
  embedded: Embedded,
): ("next" | "nuxt" | "apollo" | "redux" | "jsonld" | "json-script")[] {
  const kinds: ("next" | "nuxt" | "apollo" | "redux" | "jsonld" | "json-script")[] = [];
  if (embedded.next !== undefined) kinds.push("next");
  if (embedded.nuxt !== undefined) kinds.push("nuxt");
  if (embedded.apollo !== undefined) kinds.push("apollo");
  if (embedded.redux !== undefined) kinds.push("redux");
  if (embedded.jsonLd?.length) kinds.push("jsonld");
  if (embedded.json?.length) kinds.push("json-script");
  return kinds;
}

/** `<meta name="csrf-token" content="…">` and friends. */
export function metaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    const name = attr(attributes, "name") ?? attr(attributes, "property");
    const content = attr(attributes, "content");
    if (name && content !== undefined) tags[name] = decodeEntities(content);
  }
  return tags;
}

/** Hidden form inputs, which often carry CSRF tokens. */
export function hiddenInputs(html: string): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    if (attr(attributes, "type")?.toLowerCase() !== "hidden") continue;
    const name = attr(attributes, "name");
    const value = attr(attributes, "value");
    if (name && value) inputs[name] = decodeEntities(value);
  }
  return inputs;
}

/** Same-origin links on a page: used to suggest flows that would widen the API. */
export function links(html: string, base: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const href = decodeEntities(match[2] ?? match[3] ?? "");
    try {
      const url = new URL(href, base);
      if (url.origin === new URL(base).origin && /^https?:$/.test(url.protocol)) {
        url.hash = "";
        found.add(url.href);
      }
    } catch {
      continue;
    }
  }
  return [...found];
}
