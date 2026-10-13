import type { JsonSchema, Operation, SiteModel } from "./types.js";

// What changed between two versions of a site's API, and between a stored schema and a live
// response (drift).

export interface ModelDiff {
  added: string[];
  removed: string[];
  changed: { id: string; changes: string[] }[];
}

export function operationKey(operation: Operation): string {
  const match = operation.match ? JSON.stringify(operation.match) : "";
  return `${operation.method} ${operation.origin}${operation.path} ${match}`;
}

function paramChanges(before: Operation, after: Operation): string[] {
  const changes: string[] = [];
  const old = new Map(before.params.map((p) => [`${p.in}:${p.name}`, p]));
  const now = new Map(after.params.map((p) => [`${p.in}:${p.name}`, p]));
  for (const [key, param] of now) {
    const previous = old.get(key);
    if (!previous) changes.push(`new ${param.required ? "required " : ""}parameter ${key}`);
    else if (previous.required !== param.required)
      changes.push(`${key} is now ${param.required ? "required" : "optional"}`);
  }
  for (const key of old.keys()) if (!now.has(key)) changes.push(`parameter ${key} removed`);
  return changes;
}

function schemaType(schema: JsonSchema): string {
  if (schema.type) return JSON.stringify(schema.type);
  if (schema.$ref) return '"ref"';
  return schema.anyOf ? '"anyOf"' : '"any"';
}

function propertyChanges(before: JsonSchema, after: JsonSchema, path: string, out: string[]): void {
  const oldProps = (before.properties ?? {}) as Record<string, JsonSchema>;
  const newProps = (after.properties ?? {}) as Record<string, JsonSchema>;
  const oldRequired = new Set((before.required as string[] | undefined) ?? []);
  for (const key of Object.keys(oldProps)) {
    if (key in newProps) schemaChanges(oldProps[key], newProps[key], `${path}/${key}`, out);
    else out.push(`${path}/${key} ${oldRequired.has(key) ? "(required) " : ""}missing`);
  }
  for (const key of Object.keys(newProps)) if (!(key in oldProps)) out.push(`${path}/${key} added`);
}

/** Breaking and notable differences between two JSON schemas, as readable lines. */
export function schemaChanges(
  before: JsonSchema | undefined,
  after: JsonSchema | undefined,
  path = "",
  out: string[] = [],
): string[] {
  if (!before || !after || out.length > 40) return out;
  if (schemaType(before) !== schemaType(after)) {
    out.push(`${path || "/"} changed type ${schemaType(before)} → ${schemaType(after)}`);
    return out;
  }
  propertyChanges(before, after, path, out);
  if (before.items && after.items)
    schemaChanges(before.items as JsonSchema, after.items as JsonSchema, `${path}/*`, out);
  return out;
}

function okSchema(operation: Operation): JsonSchema | undefined {
  return Object.entries(operation.responses).find(([status]) => status.startsWith("2"))?.[1].schema;
}

export function diffModels(before: SiteModel | undefined, after: SiteModel): ModelDiff {
  const old = new Map((before?.operations ?? []).map((op) => [operationKey(op), op]));
  const now = new Map(after.operations.map((op) => [operationKey(op), op]));
  const diff: ModelDiff = { added: [], removed: [], changed: [] };
  for (const [key, operation] of now) {
    const previous = old.get(key);
    if (!previous) {
      diff.added.push(operation.id);
      continue;
    }
    const changes = [
      ...(previous.id !== operation.id ? [`renamed from ${previous.id}`] : []),
      ...paramChanges(previous, operation),
      ...schemaChanges(
        resolveAll(before, okSchema(previous)),
        resolveAll(after, okSchema(operation)),
      ).map((line) => `response ${line}`),
    ];
    if (JSON.stringify(previous.security) !== JSON.stringify(operation.security))
      changes.push(
        `security ${previous.security.join(",") || "none"} → ${operation.security.join(",") || "none"}`,
      );
    if (changes.length) diff.changed.push({ id: operation.id, changes });
  }
  for (const [key, operation] of old) if (!now.has(key)) diff.removed.push(operation.id);
  return diff;
}

/** Inlines `$ref`s so schemas from different versions compare by structure. */
export function resolveAll(
  model: Pick<SiteModel, "components"> | undefined,
  schema: JsonSchema | undefined,
  depth = 0,
): JsonSchema | undefined {
  if (!schema || depth > 8) return schema;
  if (typeof schema.$ref === "string")
    return resolveAll(model, model?.components[schema.$ref.split("/").pop() ?? ""], depth + 1);
  const out: JsonSchema = { ...schema };
  if (schema.properties)
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, JsonSchema>).map(([k, v]) => [
        k,
        resolveAll(model, v, depth + 1),
      ]),
    );
  if (schema.items) out.items = resolveAll(model, schema.items as JsonSchema, depth + 1);
  return out;
}

export function isEmptyDiff(diff: ModelDiff): boolean {
  return !diff.added.length && !diff.removed.length && !diff.changed.length;
}

export function formatDiff(diff: ModelDiff): string {
  if (isEmptyDiff(diff)) return "No changes.";
  const lines: string[] = [];
  for (const id of diff.added) lines.push(`+ ${id}`);
  for (const id of diff.removed) lines.push(`- ${id}`);
  for (const { id, changes } of diff.changed)
    lines.push(`~ ${id}`, ...changes.map((change) => `    ${change}`));
  return lines.join("\n");
}
