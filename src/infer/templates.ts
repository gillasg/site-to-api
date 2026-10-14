// Turns concrete paths into templates: /products/8812/reviews → /products/{productId}/reviews.
// Ids are recognised by shape (UUIDs, numbers, hex, base62); slugs by variation across siblings.
// Parameter names come from the segment before them.

export type SegmentKind = "uuid" | "integer" | "hex" | "id" | "date" | "slug";

export interface TemplatedPath {
  template: string;
  params: { name: string; value: string; kind: SegmentKind }[];
}

const KINDS: [SegmentKind, RegExp][] = [
  ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["integer", /^\d+$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["hex", /^(?=.*\d)(?=.*[a-f])[0-9a-f]{10,}$/i],
];

function shapeKind(segment: string): SegmentKind | undefined {
  for (const [kind, pattern] of KINDS) if (pattern.test(segment)) return kind;
  if (looksLikeId(segment)) return "id";
  return undefined;
}

/** base62-style ids: long, mixed letters and digits, no vowel-heavy words. */
function looksLikeId(segment: string): boolean {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(segment)) return false;
  const digits = segment.replace(/\D/g, "").length;
  const letters = segment.replace(/[^A-Za-z]/g, "").length;
  if (digits < 2 || letters < 1) return false;
  if (
    /[-_]/.test(segment) &&
    segment.split(/[-_]/).every((part) => /^[a-z]+$/i.test(part) || /^\d{1,4}$/.test(part))
  )
    return false;
  return /[A-Z]/.test(segment) && /[a-z]/.test(segment) ? true : digits >= 4;
}

export function singular(word: string): string {
  const lower = word.toLowerCase();
  if (lower === "people") return "person";
  if (lower === "children") return "child";
  if (/(ss|us|is|data|news|status)$/.test(lower)) return word;
  if (/ies$/.test(lower)) return word.slice(0, -3) + "y";
  if (/(sses|xes|ches|shes|zes)$/.test(lower)) return word.slice(0, -2);
  if (/s$/.test(lower)) return word.slice(0, -1);
  return word;
}

export function camel(words: string): string {
  const parts = words
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = parts
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part[0]?.toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");
  return /^\d/.test(joined) ? "n" + joined : joined || "value";
}

function paramName(previous: string | undefined, kind: SegmentKind): string {
  if (kind === "date") return previous ? camel(singular(previous) + " date") : "date";
  if (!previous || /^v\d+$/i.test(previous) || previous === "api")
    return kind === "slug" ? "slug" : "id";
  const base = singular(previous);
  return camel(base + (kind === "slug" ? " slug" : " id"));
}

interface ParsedTemplate {
  origin?: string;
  segments: string[];
}

function parseTemplate(template: string): ParsedTemplate {
  if (template.includes("://")) {
    const url = new URL(template.replace(/\{/g, "%7B").replace(/\}/g, "%7D"));
    return { origin: url.origin, segments: decodeURIComponent(url.pathname).split("/").slice(1) };
  }
  return { segments: template.split("/").slice(1) };
}

function matchOverride(
  url: URL,
  segments: string[],
  overrides: ParsedTemplate[],
): TemplatedPath | undefined {
  for (const override of overrides) {
    if (override.origin && override.origin !== url.origin) continue;
    if (override.segments.length !== segments.length) continue;
    const params: TemplatedPath["params"] = [];
    const fits = override.segments.every((part, index) => {
      const value = segments[index] ?? "";
      const name = /^\{(.+)\}$/.exec(part)?.[1];
      if (name) params.push({ name, value, kind: shapeKind(value) ?? "slug" });
      return name !== undefined || part === value;
    });
    if (fits) return { template: "/" + override.segments.join("/"), params };
  }
  return undefined;
}

export interface TemplateInput {
  url: string;
  /** Shape of the JSON response, so different resources at one position are never merged. */
  shape?: string;
}

/**
 * Templates every path together, so a segment that varies across otherwise-identical sibling
 * paths (slugs) is recognised, not just segments shaped like ids.
 */
export function templatePaths(inputs: TemplateInput[], overrides: string[] = []): TemplatedPath[] {
  const parsedOverrides = overrides.map(parseTemplate);
  const split = inputs.map((input) => {
    const url = new URL(input.url);
    const segments = url.pathname.split("/").slice(1).map(safeDecode);
    const kinds = segments.map((segment, index) =>
      isVersion(segments, index) ? undefined : shapeKind(segment),
    );
    return { url, segments, kinds, shape: input.shape ?? "" };
  });
  const slugPositions = findSlugPositions(split);
  return split.map(({ url, segments, kinds }) => {
    const forced = matchOverride(url, segments, parsedOverrides);
    if (forced) return forced;
    const params: TemplatedPath["params"] = [];
    const used = new Map<string, number>();
    const parts = segments.map((segment, index) => {
      const kind =
        kinds[index] ??
        (slugPositions.has(siblingKey(url.origin, segments, kinds, index)) ? "slug" : undefined);
      if (!kind || segment === "") return segment;
      const previous = [...segments.slice(0, index)]
        .reverse()
        .find((part, back) => !kinds[index - 1 - back] && part);
      let name = paramName(previous, kind);
      const seen = used.get(name) ?? 0;
      used.set(name, seen + 1);
      if (seen) name += seen + 1;
      params.push({ name, value: segment, kind });
      return `{${name}}`;
    });
    return { template: "/" + parts.join("/"), params };
  });
}

/** An API version (/1/indexes/…, /api/2/…) is part of the path, not an id. */
function isVersion(segments: string[], index: number): boolean {
  const segment = segments[index] ?? "";
  if (!/^\d{1,2}(\.\d+)?$/.test(segment) || index >= segments.length - 1) return false;
  return index === 0 || /^(api|rest|services?)$/i.test(segments[index - 1] ?? "");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function siblingKey(
  origin: string,
  segments: string[],
  kinds: (SegmentKind | undefined)[],
  index: number,
): string {
  const parts = segments.map((segment, i) => (i === index ? "*" : kinds[i] ? "{}" : segment));
  return `${origin}|${index}|${parts.join("/")}`;
}

const SLUG = /^(?=.*[a-z])[a-z0-9]+([-_.][a-z0-9]+)+$/i;

function findSlugPositions(
  split: { url: URL; segments: string[]; kinds: (SegmentKind | undefined)[]; shape: string }[],
): Set<string> {
  const groups = new Map<string, { values: Set<string>; shapes: Set<string> }>();
  for (const { url, segments, kinds, shape } of split) {
    segments.forEach((segment, index) => {
      if (kinds[index] || !segment || index === 0) return;
      const key = siblingKey(url.origin, segments, kinds, index);
      const group = groups.get(key) ?? { values: new Set(), shapes: new Set() };
      group.values.add(segment);
      group.shapes.add(shape);
      groups.set(key, group);
    });
  }
  const positions = new Set<string>();
  for (const [key, { values, shapes }] of groups) {
    const list = [...values];
    const slugs = list.filter((value) => SLUG.test(value)).length;
    const sameShape = shapes.size === 1 && !shapes.has("");
    if ((list.length >= 3 && slugs / list.length >= 0.6) || (list.length >= 5 && sameShape))
      positions.add(key);
  }
  return positions;
}
