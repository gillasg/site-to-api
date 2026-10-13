import type { JsonSchema, Operation, SiteModel } from "../types.js";

// Small helpers over a site model, shared by the runtime and the emitters.

export function resolve(
  model: Pick<SiteModel, "components">,
  schema: JsonSchema | undefined,
): JsonSchema | undefined {
  let current = schema;
  for (let i = 0; i < 10 && typeof current?.$ref === "string"; i++)
    current = model.components[current.$ref.split("/").pop() ?? ""];
  return current;
}

/** The schema at a JSON pointer inside a response schema (array indexes and `*` step into items). */
export function schemaAt(
  model: Pick<SiteModel, "components">,
  schema: JsonSchema | undefined,
  pointer: string,
): JsonSchema | undefined {
  let current = resolve(model, schema);
  for (const raw of pointer.split("/").slice(1)) {
    if (!current) return undefined;
    if (raw === "*" || /^\d+$/.test(raw))
      current = resolve(model, current.items as JsonSchema | undefined);
    else
      current = resolve(
        model,
        (current.properties as Record<string, JsonSchema> | undefined)?.[raw],
      );
  }
  return current;
}

/** The schema of one item of a paginated operation's results. */
export function itemsSchema(
  model: Pick<SiteModel, "components">,
  operation: Operation,
): JsonSchema | undefined {
  const pointer = operation.pagination?.itemsPointer;
  if (pointer === undefined) return undefined;
  const ok = Object.entries(operation.responses).find(([status]) => status.startsWith("2"))?.[1];
  const list = schemaAt(model, ok?.schema, pointer);
  return list?.items as JsonSchema | undefined;
}

export function okStatus(operation: Operation): string | undefined {
  return Object.keys(operation.responses).find((status) => status.startsWith("2"));
}
