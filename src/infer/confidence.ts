import type { Operation } from "../types.js";

// How much to trust each operation, with the reasons, so people know what to record again.

type Rule = (operation: Operation) => { flag: string; penalty: number } | undefined;

const okResponse = (operation: Operation) =>
  Object.entries(operation.responses).find(([status]) => status.startsWith("2"))?.[1];

function untracedTokens(operation: Operation): string[] {
  return operation.params
    .filter(
      (param) =>
        param.in !== "path" &&
        !param.constant &&
        !param.generated &&
        /token|key|hash|sig/i.test(param.name) &&
        !operation.dependencies.some((dep) => dep.target === `${param.in}:${param.name}`),
    )
    .map((param) => param.name);
}

const RULES: Rule[] = [
  (op) =>
    Object.keys(op.responses).every((status) => Number(status) >= 400)
      ? { flag: "only error responses recorded", penalty: 0.3 }
      : undefined,
  (op) => {
    const ok = okResponse(op);
    return ok && !ok.schema && ok.mime !== "" && op.role === "read"
      ? { flag: "response is not JSON", penalty: 0.1 }
      : undefined;
  },
  (op) =>
    okResponse(op)?.schema?.anyOf ? { flag: "response shape varies", penalty: 0.1 } : undefined,
  (op) =>
    op.sampleCount === 1
      ? { flag: "seen once: record it again to confirm optional fields", penalty: 0 }
      : undefined,
  (op) =>
    op.signing
      ? { flag: "signed requests: calls must go through the page", penalty: 0.05 }
      : undefined,
  (op) => {
    const names = untracedTokens(op);
    return names.length
      ? { flag: `untraced values: ${names.join(", ")}`, penalty: 0.1 }
      : undefined;
  },
];

function baseScore(samples: number): number {
  if (samples >= 5) return 0.9;
  if (samples >= 3) return 0.8;
  return samples === 2 ? 0.65 : 0.45;
}

export function scoreOperation(operation: Operation): void {
  const hits = RULES.map((rule) => rule(operation)).filter((hit) => hit !== undefined);
  const score = hits.reduce((total, hit) => total - hit.penalty, baseScore(operation.sampleCount));
  operation.confidence = Math.max(0.05, Math.min(0.99, Math.round(score * 100) / 100));
  operation.bucket =
    operation.confidence >= 0.75 ? "high" : operation.confidence >= 0.5 ? "medium" : "low";
  operation.flags = hits.map((hit) => hit.flag);
}
