import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { filterExchanges, filterOptions, learnNoise, originMatches } from "./filter.js";
import { inferSecurity } from "./infer/auth.js";
import { hoistComponents } from "./infer/components.js";
import { scoreOperation } from "./infer/confidence.js";
import { buildOperation, finalizeNames, groupExchanges, type Grouped } from "./infer/operations.js";
import { buildChannels, buildPages } from "./infer/pages.js";
import { detectPagination } from "./infer/pagination.js";
import { detectSigning } from "./infer/signing.js";
import { traceDependencies, type StorageSnapshot } from "./infer/trace.js";
import type { Exchange, Overrides, SiteModel } from "./types.js";

// The build pipeline: filter → normalize → infer → trace. Each stage can be the last one run,
// and each writes its intermediate result when a work folder is given.

export const STAGES = ["filter", "normalize", "infer", "trace"] as const;
export type Stage = (typeof STAGES)[number];

export interface BuildOptions {
  site: string;
  title?: string;
  overrides?: Overrides;
  /** URL patterns learned as noise in earlier builds. */
  learnedNoise?: string[];
  /** Web storage captured with the recording, to trace tokens kept there. */
  storage?: StorageSnapshot;
  /** Stop after this stage. */
  until?: Stage;
  /** Write each stage's output here. */
  workDir?: string;
}

export interface BuildResult {
  model: SiteModel;
  /** New noise patterns learned from this build. */
  learned: { pattern: string; url: string }[];
  stage: Stage;
}

async function save(workDir: string | undefined, stage: Stage, value: unknown): Promise<void> {
  if (!workDir) return;
  await mkdir(workDir, { recursive: true });
  const index = STAGES.indexOf(stage) + 1;
  await writeFile(join(workDir, `${index}-${stage}.json`), JSON.stringify(value, null, 2));
}

function emptyModel(options: BuildOptions, exchanges: Exchange[]): SiteModel {
  return {
    version: 1,
    site: options.site,
    title: options.title ?? options.site,
    generatedAt: new Date().toISOString(),
    origins: [],
    security: [],
    operations: [],
    pages: [],
    channels: [],
    components: {},
    noise: [],
    stats: {
      exchanges: exchanges.length,
      kept: 0,
      captures: [...new Set(exchanges.map((e) => e.source))],
    },
  };
}

function normalizedSummary(grouped: Grouped): unknown {
  return {
    operations: grouped.groups.map((group) => ({
      key: group.key,
      samples: group.members.length,
      params: group.pathParams,
    })),
    documents: grouped.documents.map((doc) => doc.origin + doc.template),
    channels: grouped.channels.map((channel) => channel.url),
  };
}

export async function buildSiteModel(
  exchanges: Exchange[],
  options: BuildOptions,
): Promise<BuildResult> {
  const overrides = options.overrides ?? {};
  const model = emptyModel(options, exchanges);
  const filtered = filterExchanges(exchanges, filterOptions(overrides, options.learnedNoise));
  const learned = learnNoise(filtered.kept);
  const learnedSet = new Set(learned.map((item) => item.url));
  const kept = filtered.kept.filter(({ exchange }) => {
    const url = new URL(exchange.url);
    return !learnedSet.has(url.origin + url.pathname);
  });
  model.noise = [
    ...filtered.noise,
    ...learned.map((item) => ({
      url: item.url,
      reason: "learned noise: only empty answers to event-like posts",
      count: 0,
    })),
  ];
  model.stats.kept = kept.length;
  await save(options.workDir, "filter", {
    kept: kept.map(({ exchange, category }) => ({
      category,
      method: exchange.method,
      url: exchange.url,
      status: exchange.status,
    })),
    noise: model.noise,
  });
  if (options.until === "filter") return { model, learned, stage: "filter" };

  const grouped = groupExchanges(kept, overrides.templates);
  grouped.documents = grouped.documents.filter((doc) =>
    originMatches(new URL(doc.origin), options.site),
  );
  await save(options.workDir, "normalize", normalizedSummary(grouped));
  if (options.until === "normalize") return { model, learned, stage: "normalize" };

  const drop = new Set(overrides.drop ?? []);
  const entries = grouped.groups.map((group) => ({
    operation: buildOperation(group),
    members: group.members,
  }));
  finalizeNames(
    entries.map((entry) => entry.operation),
    overrides.names,
  );
  const live = entries.filter((entry) => !drop.has(entry.operation.id));
  model.operations = live.map((entry) => entry.operation);
  model.pages = buildPages(grouped.documents, overrides);
  model.channels = buildChannels(grouped.channels);
  model.origins = [
    ...new Set([
      ...model.operations.map((op) => op.origin),
      ...model.pages.map((page) => page.origin),
    ]),
  ].sort();
  await save(options.workDir, "infer", model);
  if (options.until === "infer") return { model, learned, stage: "infer" };

  const pageIds = new Map(
    model.pages.flatMap((page) => page.samples.map((url) => [url, page.id] as const)),
  );
  traceDependencies({
    members: live,
    documents: grouped.documents.map((doc) => ({
      pageId: pageIds.get(doc.member.exchange.url) ?? "page",
      exchange: doc.member.exchange,
    })),
    ...(options.storage ? { storage: options.storage } : {}),
  });
  model.security = inferSecurity(live);
  for (const { operation, members } of live) {
    const pagination = detectPagination(operation, members);
    if (pagination) operation.pagination = pagination;
    const signing = detectSigning(operation, members);
    if (signing) operation.signing = signing;
    const description = overrides.descriptions?.[operation.id];
    if (description) operation.description = description;
    scoreOperation(operation);
  }
  hoistComponents(model);
  await save(options.workDir, "trace", model);
  return { model, learned, stage: "trace" };
}
