import { getPointer } from "../infer/schema.js";
import { itemsPointer } from "../infer/pagination.js";
import type { Operation, Pagination } from "../types.js";
import { SET, type Params, type RuntimeResponse } from "./request.js";

// Every paginated operation as an async iterator: cursors, offsets, page numbers and next links.

export interface PaginateOptions {
  /** Stop after this many pages. Default 50. */
  maxPages?: number;
  maxItems?: number;
}

interface Caller {
  request(id: string, params: Params): Promise<RuntimeResponse>;
}

function read(json: unknown, pointer: string | undefined): unknown {
  return pointer === undefined ? undefined : getPointer(json, pointer.replace(/\*/g, "0"));
}

function startValue(
  operation: Operation,
  target: string,
  params: Params,
  fallback: number,
): number {
  const name = target.split(":").slice(1).join(":");
  const given = params[name] ?? ((params[SET] as Params | undefined) ?? {})[target];
  if (given !== undefined) return Number(given);
  const sample = operation.params.find((p) => `${p.in}:${p.name}` === target)?.examples?.[0];
  const recorded = Number(sample);
  return sample !== undefined && Number.isFinite(recorded) && recorded <= fallback + 1
    ? recorded
    : fallback;
}

/** Works out the next page's request from the current page's response, or says there is none. */
class Pager {
  private offset: number;
  private page: number;

  constructor(
    private readonly operation: Operation,
    private readonly pagination: Pagination,
    params: Params,
  ) {
    const param = pagination.param ?? "";
    this.offset = pagination.style === "offset" ? startValue(operation, param, params, 0) : 0;
    this.page = pagination.style === "page" ? startValue(operation, param, params, 1) : 1;
  }

  private finished(response: RuntimeResponse): boolean {
    const { hasMorePointer } = this.pagination;
    return !!hasMorePointer && read(response.json, hasMorePointer) === false;
  }

  private total(response: RuntimeResponse): number {
    const total = Number(read(response.json, this.pagination.totalPointer));
    return Number.isFinite(total) && total > 0 ? total : Infinity;
  }

  /** The `$set` values for the next request, or undefined at the end. */
  next(response: RuntimeResponse, count: number): Params | undefined {
    if (!count || this.finished(response)) return undefined;
    const { style, param } = this.pagination;
    if (style === "link") return this.link(response);
    if (!param) return undefined;
    if (style === "cursor") return this.cursor(response, param);
    if (style === "offset") return this.nextOffset(response, param, count);
    return this.nextPage(response, param);
  }

  private cursor(response: RuntimeResponse, param: string): Params | undefined {
    const cursor = read(response.json, this.pagination.nextPointer);
    return cursor === undefined || cursor === null || cursor === ""
      ? undefined
      : { [param]: cursor };
  }

  private nextOffset(response: RuntimeResponse, param: string, count: number): Params | undefined {
    this.offset += count;
    return this.offset >= this.total(response) ? undefined : { [param]: this.offset };
  }

  private nextPage(response: RuntimeResponse, param: string): Params | undefined {
    this.page += 1;
    const counted = /page/i.test(this.pagination.totalPointer ?? "");
    return counted && this.page > this.total(response) ? undefined : { [param]: this.page };
  }

  private link(response: RuntimeResponse): Params | undefined {
    const value = this.pagination.nextHeader
      ? /<([^>]+)>;\s*rel="?next"?/i.exec(response.headers.link ?? "")?.[1]
      : read(response.json, this.pagination.nextPointer);
    if (typeof value !== "string" || !value) return undefined;
    return { $url: new URL(value, response.url ?? this.operation.origin).href };
  }
}

function pageItems(response: RuntimeResponse, operation: Operation): unknown[] {
  const pointer = operation.pagination?.itemsPointer ?? itemsPointer(response.json) ?? "";
  const items = read(response.json, pointer);
  return Array.isArray(items) ? items : [];
}

const NO_PAGES: Pagination = { style: "page" };

export async function* paginate(
  caller: Caller,
  operation: Operation,
  params: Params,
  options: PaginateOptions = {},
): AsyncGenerator<unknown> {
  const pager = new Pager(operation, operation.pagination ?? NO_PAGES, params);
  const maxItems = options.maxItems ?? Infinity;
  let sets: Params = { ...((params[SET] as Params | undefined) ?? {}) };
  let yielded = 0;
  for (let index = 0; index < (options.maxPages ?? 50); index++) {
    const response = await caller.request(operation.id, { ...params, [SET]: sets });
    if (response.status >= 400)
      throw new Error(`${operation.id} page ${index + 1} answered HTTP ${response.status}`);
    const list = pageItems(response, operation);
    for (const item of list) {
      yield item;
      if (++yielded >= maxItems) return;
    }
    const next = pager.next(response, list.length);
    if (!next) return;
    sets = { ...sets, ...next };
  }
}
