import { originMatches } from "./filter.js";
import { links } from "./infer/html.js";
import { templatePaths } from "./infer/templates.js";
import type { Exchange, Operation, SiteModel } from "./types.js";

// Coverage guidance: which flows would widen or firm up the API. Suggestions come from the model
// (operations seen once, first pages only, untraced values, missing list/detail pairs) and from
// the recorded pages (same-site links and forms nobody has used yet).

export interface Suggestion {
  kind: "confirm" | "paginate" | "visit" | "submit" | "detail" | "list" | "trace";
  message: string;
  url?: string;
  operationId?: string;
}

function documents(exchanges: Exchange[], site: string): Exchange[] {
  return exchanges.filter((e) => {
    try {
      return (
        /html/i.test(e.responseMime ?? e.responseHeaders["content-type"] ?? "") &&
        originMatches(new URL(e.url), site) &&
        !!e.responseBody
      );
    } catch {
      return false;
    }
  });
}

const at = (op: Operation) => (op.pageUrls[0] ? { url: op.pageUrls[0] } : {});

function operationSuggestions(op: Operation): Suggestion[] {
  const out: Suggestion[] = [];
  if (op.sampleCount === 1)
    out.push({
      kind: "confirm",
      operationId: op.id,
      message: `Use ${op.id} again with different inputs (seen once).`,
      ...at(op),
    });
  const provenCursor = op.dependencies.some(
    (d) => d.source.kind === "response" && d.source.operationId === op.id,
  );
  if (op.pagination && !provenCursor)
    out.push({
      kind: "paginate",
      operationId: op.id,
      message: `Open the next page of results for ${op.id} to confirm its ${op.pagination.style} pagination.`,
      ...at(op),
    });
  const untraced = op.flags.find((flag) => flag.startsWith("untraced values"));
  if (untraced)
    out.push({
      kind: "trace",
      operationId: op.id,
      message: `${op.id}: ${untraced}. Record the steps before it (sign-in, the page that loads it).`,
    });
  return out;
}

/** List and detail endpoints come in pairs; point out the missing half. */
function pairSuggestions(op: Operation, paths: Set<string>): Suggestion[] {
  if (op.method !== "GET") return [];
  const parts = op.path.split("/");
  const parent = parts.slice(0, -1).join("/");
  const isItem = (parts[parts.length - 1] ?? "").startsWith("{");
  if (isItem && !paths.has(op.origin + parent))
    return [
      {
        kind: "list",
        operationId: op.id,
        message: `Open the list that leads to ${op.id} (${parent}).`,
      },
    ];
  const hasDetail = [...paths].some((path) => path.startsWith(`${op.origin}${op.path}/{`));
  if (!isItem && op.pagination && !hasDetail)
    return [
      {
        kind: "detail",
        operationId: op.id,
        message: `Open one item from ${op.id} to map its detail endpoint.`,
      },
    ];
  return [];
}

function modelSuggestions(model: SiteModel): Suggestion[] {
  const paths = new Set(model.operations.map((op) => `${op.origin}${op.path}`));
  return [
    ...model.operations.flatMap(operationSuggestions),
    ...model.operations.flatMap((op) => pairSuggestions(op, paths)),
  ];
}

function pageSuggestions(model: SiteModel, docs: Exchange[]): Suggestion[] {
  const covered = new Set<string>();
  const seenPages = new Set(docs.map((doc) => doc.url));
  for (const op of model.operations) for (const url of op.pageUrls) covered.add(url);
  const found = docs
    .flatMap((doc) => links(doc.responseBody ?? "", doc.url))
    .filter((url) => !seenPages.has(url) && !covered.has(url));
  const unique = [...new Set(found)];
  if (!unique.length) return [];
  const templated = templatePaths(unique.map((url) => ({ url })));
  const known = new Set(docs.map((doc) => new URL(doc.url).pathname));
  const byTemplate = new Map<string, string>();
  templated.forEach((path, index) => {
    if (!known.has(path.template) && !byTemplate.has(path.template))
      byTemplate.set(path.template, unique[index] as string);
  });
  const out: Suggestion[] = [...byTemplate.entries()].slice(0, 15).map(([template, url]) => ({
    kind: "visit",
    url,
    message: `Visit a ${template} page (e.g. ${url}).`,
  }));
  const forms = new Set<string>();
  for (const doc of docs)
    for (const match of (doc.responseBody ?? "").matchAll(
      /<form\b[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*>/gi,
    )) {
      const action = new URL(match[1] as string, doc.url);
      if (forms.has(action.pathname)) continue;
      forms.add(action.pathname);
      if (!model.operations.some((op) => action.pathname.startsWith(op.path.split("{")[0] ?? "")))
        out.push({
          kind: "submit",
          url: doc.url,
          message: `Submit the form that posts to ${action.pathname} on ${doc.url}.`,
        });
    }
  return out;
}

export function coverage(model: SiteModel, exchanges: Exchange[]): Suggestion[] {
  const all = [
    ...modelSuggestions(model),
    ...pageSuggestions(model, documents(exchanges, model.site)),
  ];
  const seen = new Set<string>();
  return all.filter((item) => (seen.has(item.message) ? false : (seen.add(item.message), true)));
}
