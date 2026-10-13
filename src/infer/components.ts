import type { JsonSchema, SiteModel } from "../types.js";
import { singular } from "./templates.js";

// Structurally identical object schemas used in more than one place become named components.

function pascal(text: string): string {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join("") || "Item"
  );
}

/** Child objects already keyed (in either pass) count by their key, so both passes agree. */
const keys = new WeakMap<object, string>();

function canonical(schema: unknown): string {
  if (schema && typeof schema === "object" && keys.has(schema)) return "#" + keys.get(schema);
  if (Array.isArray(schema)) return "[" + schema.map(canonical).join(",") + "]";
  if (schema && typeof schema === "object")
    return (
      "{" +
      Object.keys(schema)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((schema as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(schema);
}

function isRecord(schema: unknown): schema is JsonSchema {
  return !!schema && typeof schema === "object" && !Array.isArray(schema);
}

function eligible(schema: JsonSchema): boolean {
  return (
    schema.type === "object" &&
    isRecord(schema.properties) &&
    Object.keys(schema.properties).length >= 3
  );
}

/** Visits a schema bottom-up, letting `visit` replace each object schema. */
function transform(
  schema: unknown,
  hint: string,
  visit: (node: JsonSchema, hint: string) => JsonSchema,
): unknown {
  if (Array.isArray(schema)) return schema.map((item) => transform(item, hint, visit));
  if (!isRecord(schema)) return schema;
  const next: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isRecord(value))
      next[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, transform(child, name, visit)]),
      );
    else if (key === "items") next[key] = transform(value, singular(hint), visit);
    else if (key === "additionalProperties" || key === "anyOf" || key === "oneOf")
      next[key] = transform(value, hint, visit);
    else next[key] = value;
  }
  return visit(next, hint);
}

type Slot = { get(): unknown; set(value: unknown): void; hint: string };

function slots(model: SiteModel): Slot[] {
  const list: Slot[] = [];
  for (const operation of model.operations) {
    for (const response of Object.values(operation.responses))
      if (response.schema)
        list.push({
          get: () => response.schema,
          set: (v) => (response.schema = v as JsonSchema),
          hint: operation.id + " response",
        });
    const body = operation.requestBody;
    if (body)
      list.push({
        get: () => body.schema,
        set: (v) => (body.schema = v as JsonSchema),
        hint: operation.id + " body",
      });
  }
  for (const page of model.pages)
    if (page.schema)
      list.push({
        get: () => page.schema,
        set: (v) => (page.schema = v as JsonSchema),
        hint: page.id,
      });
  return list;
}

export function hoistComponents(model: SiteModel): void {
  const counts = new Map<string, { count: number; hints: Set<string> }>();
  const all = slots(model);
  for (const slot of all)
    transform(slot.get(), slot.hint, (node, hint) => {
      if (eligible(node)) {
        const key = canonical(node);
        keys.set(node, key);
        const entry = counts.get(key) ?? { count: 0, hints: new Set() };
        entry.count++;
        entry.hints.add(hint);
        counts.set(key, entry);
      }
      return node;
    });
  const names = new Map<string, string>();
  const used = new Set(Object.keys(model.components));
  for (const [key, { count, hints }] of counts) {
    if (count < 2) continue;
    let name = pascal(singular([...hints][0] ?? "Item"));
    for (let n = 2; used.has(name); n++) name = pascal(singular([...hints][0] ?? "Item")) + n;
    used.add(name);
    names.set(key, name);
  }
  for (const slot of all)
    slot.set(
      transform(slot.get(), slot.hint, (node) => {
        if (!eligible(node)) return node;
        const key = canonical(node);
        keys.set(node, key);
        const name = names.get(key);
        if (!name) return node;
        model.components[name] ??= node;
        const ref = { $ref: `#/components/schemas/${name}` };
        keys.set(ref, key);
        return ref;
      }),
    );
}

/** Follows a `$ref` into the model's components. */
export function resolveRef(
  model: Pick<SiteModel, "components">,
  schema: JsonSchema | undefined,
): JsonSchema | undefined {
  const ref = typeof schema?.$ref === "string" ? schema.$ref : undefined;
  if (!ref) return schema;
  return model.components[ref.split("/").pop() ?? ""];
}
