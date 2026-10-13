import { createRedactor, redactUrl, type Redactor } from "../redact.js";
import type { Operation, Overrides, SiteModel } from "../types.js";
import { sentence } from "./openapi.js";

// Human-facing output: curl examples, a Markdown report, and redacted samples.

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function curlExample(operation: Operation, redactor: Redactor): string | undefined {
  const sample = operation.samples[0];
  if (!sample) return undefined;
  const lines = [`curl -X ${sample.method} ${shellQuote(redactUrl(sample.url, redactor))}`];
  for (const [name, value] of Object.entries(sample.requestHeaders)) {
    if (
      /^(accept-encoding|content-length|host|connection|sec-|priority|user-agent|referer|origin|accept-language)/.test(
        name,
      )
    )
      continue;
    lines.push(`  -H ${shellQuote(`${name}: ${redactor.header(name, value)}`)}`);
  }
  const body = redactor.body(sample.requestBody);
  if (body) lines.push(`  --data-raw ${shellQuote(body)}`);
  return lines.join(" \\\n");
}

export function redactedSamples(
  model: SiteModel,
  rules: Overrides["redact"] = {},
): Record<string, unknown[]> {
  const redactor = createRedactor(rules);
  return Object.fromEntries(
    model.operations.map((operation) => [
      operation.id,
      operation.samples.map((sample) => ({
        method: sample.method,
        url: redactUrl(sample.url, redactor),
        status: sample.status,
        requestHeaders: redactor.headers(sample.requestHeaders),
        requestBody: redactor.body(sample.requestBody),
        responseBody: redactor.body(sample.responseBody?.slice(0, 20_000)),
      })),
    ]),
  );
}

function confidenceBadge(operation: Operation): string {
  return `${operation.bucket} (${Math.round(operation.confidence * 100)}%)`;
}

/** A titled section, or nothing when it would be empty. */
function section(title: string, lines: string[], header: string[] = []): string[] {
  return lines.length ? [`## ${title}`, "", ...header, ...lines, ""] : [];
}

function schemeLine(scheme: SiteModel["security"][number]): string {
  const key = scheme.key ? ` (\`${scheme.key}\`)` : "";
  const source = scheme.source ? `, from ${describeSource(scheme.source)}` : "";
  const refresh = scheme.refresh ? `, renewed by \`${scheme.refresh.operationId}\`` : "";
  return `- **${scheme.name}**: ${scheme.type}${key}${source}${refresh}`;
}

export function markdownReport(model: SiteModel, rules: Overrides["redact"] = {}): string {
  const redactor = createRedactor(rules);
  const origins = model.origins.join(", ") || "no origins";
  return [
    `# ${model.title}`,
    "",
    `${model.operations.length} operations, ${model.pages.length} page endpoints and ${model.channels.length} streams across ${origins}, from ${model.stats.kept} of ${model.stats.exchanges} recorded requests.`,
    "",
    ...section("Authentication", model.security.map(schemeLine)),
    ...section(
      "Operations",
      model.operations.map(
        (op) =>
          `| \`${op.id}\` | ${op.method} | \`${op.path}\` | ${confidenceBadge(op)} | ${op.sampleCount} |`,
      ),
      ["| Operation | Method | Path | Confidence | Samples |", "|---|---|---|---|---|"],
    ),
    ...model.operations.flatMap((op) => operationSection(op, redactor)),
    ...section(
      "Page endpoints",
      model.pages.map(
        (page) =>
          `- \`${page.id}\`: GET \`${page.origin}${page.path}\` (${page.extractor ? "CSS extractor" : page.embedded.join(", ")})`,
      ),
    ),
    ...section(
      "Streams",
      model.channels.map(
        (c) =>
          `- \`${c.id}\` (${c.kind}) \`${c.url}\`: ${c.messages.map((m) => `${m.direction} ${m.name}`).join(", ")}`,
      ),
    ),
    ...section(
      "Left out",
      model.noise
        .slice(0, 60)
        .map((item) => `| ${redactor.text(item.url)} | ${item.reason} | ${item.count || ""} |`),
      ["| URL | Why | Count |", "|---|---|---|"],
    ),
  ].join("\n");
}

function describeSource(source: NonNullable<SiteModel["security"][number]["source"]>): string {
  if (source.kind === "cookie") return `cookie \`${source.name}\``;
  if (source.kind === "meta") return `the page's \`${source.name}\` meta tag`;
  if (source.kind === "response") return `\`${source.operationId}\` response \`${source.pointer}\``;
  if (source.kind === "storage") return `${source.storage} \`${source.key}\``;
  return "a fixed value";
}

function paramTable(op: Operation): string[] {
  const params = op.params.filter((p) => !p.constant);
  if (!params.length) return [];
  const rows = params.map(
    (p) =>
      `| \`${p.name}\` | ${p.in} | ${p.required ? "yes" : "no"} | ${JSON.stringify(p.schema.type ?? "any")} | ${p.generated ? `generated (${p.generated})` : ""} |`,
  );
  return ["| Parameter | In | Required | Type | Notes |", "|---|---|---|---|---|", ...rows, ""];
}

function paginationLine(op: Operation): string[] {
  const p = op.pagination;
  if (!p) return [];
  const via = p.param ? ` via \`${p.param}\`` : "";
  const next = p.nextPointer ? `, next from \`${p.nextPointer}\`` : "";
  return [`Pagination: ${p.style}${via}${next}.`, ""];
}

function dependencyLines(op: Operation): string[] {
  const deps = op.dependencies.filter((dep) => dep.source.kind === "response");
  if (!deps.length) return [];
  return [
    "Depends on:",
    ...deps.map((dep) => `- \`${dep.target}\` ← ${describeSource(dep.source as never)}`),
    "",
  ];
}

function signingLine(op: Operation): string[] {
  const signing = op.signing;
  if (!signing) return [];
  const names = [...signing.headers, ...signing.query].map((n) => `\`${n}\``).join(", ");
  const frame = signing.initiator;
  const where = frame
    ? `, built by \`${frame.functionName || "anonymous"}\` in ${frame.url}:${frame.line}`
    : "";
  return [`Signed: ${names}${where}.`, ""];
}

function operationSection(op: Operation, redactor: Redactor): string[] {
  const curl = curlExample(op, redactor);
  return [
    `### ${op.id}`,
    "",
    `${sentence(op.id)}. \`${op.method} ${op.origin}${op.path}\`, ${op.role}, confidence ${confidenceBadge(op)}.`,
    "",
    ...(op.description ? [op.description, ""] : []),
    ...(op.flags.length ? [...op.flags.map((flag) => `- ⚠ ${flag}`), ""] : []),
    ...paramTable(op),
    ...paginationLine(op),
    ...dependencyLines(op),
    ...signingLine(op),
    ...(curl ? ["```bash", curl, "```", ""] : []),
  ];
}
