import type { Operation, Pagination } from "../types.js";
import type { Member } from "./operations.js";
import { generalize, leaves } from "./schema.js";

// Detects how an operation pages through results: cursors, offsets, page numbers or next links.
// The runtime turns detected pagination into async iterators.

const CURSOR_PARAM =
  /^(cursor|after|next|nextcursor|next_cursor|page_?token|continuation(token)?|starting_?after|start_?cursor|max_id|offset_?token|scroll_?id|marker|start_?key|nexttoken|next_token|from_?token)$/i;
const OFFSET_PARAM = /^(offset|skip|start|from|startindex|start_index)$/i;
const PAGE_PARAM = /^(page|p|pagenumber|page_?no|page_?num|pageindex|page_index|pg|pagenum)$/i;
const LIMIT_PARAM =
  /^(limit|count|size|per_?page|page_?size|first|rows|max|max_?results|num|hits_?per_?page|take)$/i;
const NEXT_KEY =
  /^(next_?cursor|end_?cursor|cursor|next_?page_?token|next_?token|continuation(_?token)?|next_?max_?id|scroll_?id|next_?marker|after|next_?key)$/i;
const NEXT_LINK = /^(next|next_?url|next_?page_?url|next_?link|href)$/i;
const HAS_MORE = /^(has_?next_?page|has_?more|more|has_?next|more_?results|is_?last_?page|last)$/i;
const TOTAL =
  /^(total|total_?count|total_?results|total_?hits|nb_?hits|count|total_?pages|nb_?pages|num_?found)$/i;

interface Candidate {
  target: string;
  name: string;
}

function requestParams(operation: Operation, members: Member[]): Candidate[] {
  const found = new Map<string, Candidate>();
  for (const param of operation.params)
    if (param.in === "query")
      found.set(`query:${param.name}`, { target: `query:${param.name}`, name: param.name });
  for (const member of members) {
    const body = member.graphql ? { variables: member.graphql.variables } : member.body?.value;
    if (body && typeof body === "object")
      for (const [pointer] of leaves(body)) {
        const name = pointer.split("/").pop() ?? "";
        found.set(`body:${generalize(pointer)}`, { target: `body:${generalize(pointer)}`, name });
      }
  }
  return [...found.values()];
}

function lastKey(pointer: string): string {
  return pointer.split("/").pop() ?? "";
}

function responsePointers(members: Member[]): { pointer: string; value: unknown }[] {
  const seen = new Map<string, unknown>();
  for (const member of members) {
    if (member.json === undefined) continue;
    for (const [pointer, value] of leaves(member.json)) {
      if (
        /\/\d+\//.test(pointer + "/") &&
        !/^\/(data|meta|pageInfo|paging|pagination)/.test(pointer)
      )
        continue;
      if (!seen.has(pointer)) seen.set(pointer, value);
    }
  }
  return [...seen.entries()].map(([pointer, value]) => ({ pointer, value }));
}

/** The longest array of objects in the response: what a page of results is. */
export function itemsPointer(json: unknown): string | undefined {
  let best: { pointer: string; length: number } | undefined;
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (depth > 5 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length && typeof value[0] === "object" && (!best || value.length > best.length))
        best = { pointer, length: value.length };
      return;
    }
    for (const [key, item] of Object.entries(value)) visit(item, `${pointer}/${key}`, depth + 1);
  };
  visit(json, "", 0);
  return best?.pointer;
}

function nextFromResponse(pointers: { pointer: string; value: unknown }[]) {
  const cursor = pointers.find(
    (p) => NEXT_KEY.test(lastKey(p.pointer)) && (typeof p.value === "string" || p.value === null),
  );
  const link = pointers.find(
    (p) =>
      NEXT_LINK.test(lastKey(p.pointer)) &&
      typeof p.value === "string" &&
      /^(https?:\/\/|\/|\?)/.test(p.value) &&
      /next/i.test(p.pointer),
  );
  const hasMore = pointers.find(
    (p) => HAS_MORE.test(lastKey(p.pointer)) && typeof p.value === "boolean",
  );
  const total = pointers.find((p) => TOTAL.test(lastKey(p.pointer)) && typeof p.value === "number");
  return { cursor, link, hasMore, total };
}

interface Evidence {
  params: Candidate[];
  next: ReturnType<typeof nextFromResponse>;
  items?: string;
  linkHeader: boolean;
  /** A request value traced to this same operation's previous response: a proven cursor. */
  traced?: { target: string; pointer: string };
}

function gather(operation: Operation, members: Member[]): Evidence {
  const params = requestParams(operation, members);
  const dep = operation.dependencies.find(
    (d) =>
      d.source.kind === "response" &&
      d.source.operationId === operation.id &&
      !d.target.startsWith("path:"),
  );
  const evidence: Evidence = {
    params,
    next: nextFromResponse(responsePointers(members)),
    linkHeader: members.some((m) => /rel="?next"?/i.test(m.exchange.responseHeaders.link ?? "")),
  };
  const items = members.map((m) => itemsPointer(m.json)).find(Boolean);
  if (items) evidence.items = items;
  if (dep?.source.kind === "response")
    evidence.traced = { target: dep.target, pointer: dep.source.pointer };
  return evidence;
}

function cursorParam(e: Evidence): Candidate | undefined {
  if (e.traced) return e.params.find((p) => p.target === e.traced?.target);
  return e.params.find((p) => CURSOR_PARAM.test(p.name));
}

function cursorStyle(e: Evidence): Pagination | undefined {
  const param = cursorParam(e);
  if (!param || !(e.next.cursor || e.traced)) return undefined;
  const nextPointer = e.traced?.pointer ?? generalize(e.next.cursor?.pointer ?? "");
  return { style: "cursor", param: param.target, nextPointer };
}

function linkStyle(e: Evidence): Pagination | undefined {
  if (e.linkHeader) return { style: "link", nextHeader: "header:link" };
  if (e.next.link) return { style: "link", nextPointer: generalize(e.next.link.pointer) };
  return undefined;
}

function countedStyle(e: Evidence): Pagination | undefined {
  const listed = !!(e.items || e.next.total);
  const offset = e.params.find((p) => OFFSET_PARAM.test(p.name));
  if (offset && listed) return { style: "offset", param: offset.target };
  const page = e.params.find((p) => PAGE_PARAM.test(p.name));
  if (page && (listed || e.next.hasMore)) return { style: "page", param: page.target };
  const cursor = cursorParam(e);
  return cursor && e.items ? { style: "cursor", param: cursor.target } : undefined;
}

/** The pagination style the evidence supports best, before the shared extras. */
function style(e: Evidence): Pagination | undefined {
  return cursorStyle(e) ?? linkStyle(e) ?? countedStyle(e);
}

export function detectPagination(operation: Operation, members: Member[]): Pagination | undefined {
  const evidence = gather(operation, members);
  const pagination = style(evidence);
  if (!pagination) return undefined;
  const limit = evidence.params.find((p) => LIMIT_PARAM.test(p.name));
  if (limit) pagination.limitParam = limit.target;
  if (evidence.next.hasMore) pagination.hasMorePointer = generalize(evidence.next.hasMore.pointer);
  if (evidence.next.total) pagination.totalPointer = generalize(evidence.next.total.pointer);
  if (evidence.items) pagination.itemsPointer = evidence.items;
  return pagination;
}
