import type { Operation } from "../types.js";
import type { Params } from "./request.js";

// Multi-step actions: one named call that runs several operations in order, such as
// "bookSlot" = searchSlots → holdSlot → confirmBooking. Saved in the site's overrides:
//
//   "actions": { "bookSlot": { "description": "...", "steps": [
//     { "operation": "searchSlots", "params": { "date": "{{inputs.date}}" } },
//     { "operation": "holdSlot", "params": { "slotId": "{{steps.0.slots.0.id}}" } },
//     { "operation": "confirmBooking" } ] } }
//
// Each step gets the inputs it accepts by name, its own params ("{{inputs.x}}", "{{steps.N.path}}"
// and "{{last.path}}" fill values from earlier steps), and any input it still needs is looked up
// by name in the earlier steps' results.

export interface ActionStep {
  operation: string;
  params?: Record<string, unknown>;
}

export interface SiteAction {
  description?: string;
  steps: ActionStep[];
}

export interface ActionResult {
  action: string;
  result: unknown;
  steps: { operation: string; result: unknown }[];
}

interface ActionHost {
  site: string;
  operation(id: string): Operation;
  call(id: string, params?: Params): Promise<unknown>;
}

const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;

function lookup(path: string, scope: { inputs: Params; steps: unknown[] }): unknown {
  const [head = "", ...rest] = path.split(".");
  let value: unknown =
    head === "inputs"
      ? scope.inputs
      : head === "last"
        ? scope.steps[scope.steps.length - 1]
        : head === "steps"
          ? scope.steps
          : undefined;
  for (const key of rest) value = (value as Record<string, unknown> | undefined)?.[key];
  return value;
}

function fill(value: unknown, scope: { inputs: Params; steps: unknown[] }): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(whole[1] ?? "", scope);
    return value.replace(TEMPLATE, (_, path: string) => String(lookup(path, scope) ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, scope));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, scope)]));
  return value;
}

/** The inputs an operation takes by name: its parameters and top-level body fields. */
export function acceptedInputs(operation: Operation): string[] {
  const body = (operation.requestBody?.schema.properties ?? {}) as Record<string, unknown>;
  const variables = ((body.variables as { properties?: Record<string, unknown> } | undefined)
    ?.properties ?? {}) as Record<string, unknown>;
  return [
    ...operation.params.filter((p) => !p.constant && !p.generated).map((p) => p.name),
    ...Object.keys(body).filter((key) => key !== "variables"),
    ...Object.keys(variables),
  ];
}

/** Finds a value by key name in earlier results (latest first), breadth first. */
function findByName(name: string, results: unknown[]): unknown {
  for (const result of [...results].reverse()) {
    const queue: unknown[] = [result];
    for (let seen = 0; queue.length && seen < 5000; seen++) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      for (const [key, value] of Object.entries(node)) {
        if (key === name && (typeof value !== "object" || value === null)) return value;
        if (value && typeof value === "object") queue.push(value);
      }
    }
  }
  return undefined;
}

function stepParams(
  operation: Operation,
  step: ActionStep,
  scope: { inputs: Params; steps: unknown[] },
): Params {
  const accepted = acceptedInputs(operation);
  const params: Params = {};
  for (const name of accepted)
    if (scope.inputs[name] !== undefined) params[name] = scope.inputs[name];
  Object.assign(params, fill(step.params ?? {}, scope) as Params);
  for (const name of accepted) {
    if (params[name] !== undefined) continue;
    const found = findByName(name, scope.steps);
    if (found !== undefined) params[name] = found;
  }
  return operation.kind === "graphql" ? asVariables(operation, params) : params;
}

/** GraphQL operations take their inputs as variables. */
function asVariables(operation: Operation, params: Params): Params {
  const body = (operation.requestBody?.schema.properties ?? {}) as Record<string, unknown>;
  const names = Object.keys(
    ((body.variables as { properties?: Record<string, unknown> } | undefined)?.properties ??
      {}) as Record<string, unknown>,
  );
  const variables = { ...((params.variables as Params | undefined) ?? {}) };
  const rest: Params = {};
  for (const [key, value] of Object.entries(params))
    if (names.includes(key)) variables[key] = value;
    else if (key !== "variables") rest[key] = value;
  return { ...rest, variables };
}

export async function runAction(
  host: ActionHost,
  action: SiteAction,
  inputs: Params,
  name = "action",
): Promise<ActionResult> {
  const scope = { inputs, steps: [] as unknown[] };
  const steps: ActionResult["steps"] = [];
  for (const [index, step] of action.steps.entries()) {
    try {
      const operation = host.operation(step.operation);
      const result = await host.call(step.operation, stepParams(operation, step, scope));
      scope.steps.push(result);
      steps.push({ operation: step.operation, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`Step ${index + 1} (${step.operation}) failed: ${message}`), {
        cause: error,
      });
    }
  }
  return { action: name, result: scope.steps[scope.steps.length - 1], steps };
}
