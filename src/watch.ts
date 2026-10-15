import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName } from "./registry.js";
import { siteApi, type SiteApiOptions } from "./runtime/site-api.js";
import type { Params } from "./runtime/request.js";

// Watching an operation: call it again and report only the items that are new or changed since
// the last check (new listings, price drops, new messages). What was seen is kept per watch in
// the site's folder, so a schedule or a trigger can call watch() and act on the difference.

export interface WatchOptions extends SiteApiOptions {
  /** Field that identifies an item (default: id, url, link, href, or a hash of the item). */
  key?: string;
  /** Dot path to the list in the result (default: the result itself, or its largest list). */
  items?: string;
  /** Name of this watch (default: from the operation and its params). */
  name?: string;
}

export interface WatchResult {
  site: string;
  watch: string;
  /** True on the first check: everything is new and nothing is reported as new. */
  first: boolean;
  total: number;
  new: unknown[];
  changed: unknown[];
  removed: string[];
  checkedAt: string;
}

interface Seen {
  checkedAt: string;
  /** Every item seen recently, by key: a hash of its content. */
  items: Record<string, string>;
  /** The keys in the last check. */
  last?: string[];
}

const KEYS = ["id", "url", "link", "href", "uuid", "slug", "key", "permalink"];
const MAX_SEEN = 20_000;

const digest = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex")
    .slice(0, 16);

function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], value);
}

/** The result itself when it is a list, else its largest list (searched a few levels deep). */
function largestList(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 4) return [];
  let best: unknown[] = [];
  for (const child of Object.values(value)) {
    const list = largestList(child, depth + 1);
    if (list.length > best.length) best = list;
  }
  return best;
}

function keyOf(item: unknown, key: string | undefined): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const field = key ?? KEYS.find((name) => record[name] !== undefined && record[name] !== null);
    const value = field ? record[field] : undefined;
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return digest(item);
}

const safe = (text: string): string => text.replace(/[^\w.-]+/g, "-").slice(0, 80);

interface Comparison {
  now: Record<string, string>;
  fresh: unknown[];
  changed: unknown[];
}

function compare(list: unknown[], previous: Seen | undefined, key: string | undefined): Comparison {
  const out: Comparison = { now: {}, fresh: [], changed: [] };
  for (const item of list) {
    const itemKey = keyOf(item, key);
    const hash = digest(item);
    out.now[itemKey] = hash;
    const before = previous?.items[itemKey];
    if (!previous) continue;
    if (before === undefined) out.fresh.push(item);
    else if (before !== hash) out.changed.push(item);
  }
  return out;
}

function listIn(result: unknown, path: string | undefined): unknown[] {
  const list = path ? at(result, path) : largestList(result);
  if (!Array.isArray(list)) throw new Error(`${path} is not a list in the result`);
  return list;
}

/** Calls the operation and returns what is new or changed since the last call of this watch. */
export async function watch(
  site: string,
  operation: string,
  params: Params = {},
  options: WatchOptions = {},
): Promise<WatchResult> {
  const name = siteName(site);
  const { key, items: itemsPath, name: watchName, ...apiOptions } = options;
  const id = watchName ?? `${safe(operation)}-${digest(params).slice(0, 8)}`;
  const file = join(siteDir(name), "watches", `${safe(id)}.json`);
  const previous = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as Seen)
    .catch(() => undefined);
  const list = listIn(await (await siteApi(name, apiOptions)).call(operation, params), itemsPath);
  const { now, fresh, changed } = compare(list, previous, key);
  const removed = (previous?.last ?? []).filter((k) => !(k in now));
  // Items seen before stay remembered for a while, so one that drops out and comes back is not new.
  const items = Object.fromEntries(
    [...Object.entries(previous?.items ?? {}), ...Object.entries(now)].slice(-MAX_SEEN),
  );
  const checkedAt = new Date().toISOString();
  await mkdir(join(siteDir(name), "watches"), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ checkedAt, items, last: Object.keys(now) } satisfies Seen),
  );
  return {
    site: name,
    watch: id,
    first: !previous,
    total: list.length,
    new: fresh,
    changed,
    removed: removed.slice(0, 200),
    checkedAt,
  };
}
