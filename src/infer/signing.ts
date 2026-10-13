import type { Operation, Signing } from "../types.js";
import type { Member } from "./operations.js";

// Finds request signatures: values that change on every call, come from no response, cookie
// or storage, and look like hashes. Records which script built the request, so calls can go
// through the site's own code (its fetch or XMLHttpRequest hooks sign them).

const SIGN_NAME =
  /(sign|signature|sig$|hmac|digest|x-s$|x-t$|x-bogus|_signature|mstoken|x-gorgon|x-khronos|x-argus|x-ladon|x-tt-params|x-request-sign|x-sign|nonce|x-client-data|anti-?content|x-zse-96)/i;
const ENTROPY = /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9+/=_.:-]{16,}$/;

function untraced(operation: Operation, target: string): boolean {
  const dep = operation.dependencies.find((d) => d.target === target);
  return !dep || (dep.source.kind === "generated" && dep.source.generator === "nonce");
}

function varies(values: string[]): boolean {
  return values.length < 2 || new Set(values).size === values.length;
}

function signedNames(
  operation: Operation,
  members: Member[],
  location: "header" | "query",
): string[] {
  const names = operation.params.filter((p) => p.in === location).map((p) => p.name);
  return names.filter((name) => {
    const values = members
      .map((m) =>
        location === "header"
          ? m.exchange.requestHeaders[name]
          : new URL(m.exchange.url).searchParams.get(name),
      )
      .filter((v): v is string => !!v);
    if (!values.length || !untraced(operation, `${location}:${name}`)) return false;
    const hashLike = values.every((v) => ENTROPY.test(v));
    return (
      (SIGN_NAME.test(name) && hashLike) ||
      (hashLike && varies(values) && members.length >= 2 && /^x-/i.test(name))
    );
  });
}

const LIBRARY =
  /(jquery|axios|polyfill|zone\.js|sentry|datadog|newrelic|bugsnag|framework|vendor)/i;

export function detectSigning(operation: Operation, members: Member[]): Signing | undefined {
  const headers = signedNames(operation, members, "header");
  const query = signedNames(operation, members, "query");
  if (!headers.length && !query.length) return undefined;
  const stack =
    members.find((m) => m.exchange.initiator?.stack?.length)?.exchange.initiator?.stack ?? [];
  const frame = stack.find((f) => f.url && !LIBRARY.test(f.url)) ?? stack[0];
  const viaXhr = stack.some((f) => /XMLHttpRequest|\.send$|^send$/.test(f.functionName));
  const signing: Signing = { headers, query, via: viaXhr ? "xhr" : "fetch" };
  if (frame)
    signing.initiator = { url: frame.url, functionName: frame.functionName, line: frame.line };
  return signing;
}
