import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { loadCapture, mergeCaptures, parseCapture } from "./load/index.js";
import { buildSiteModel, type Stage } from "./pipeline.js";
import {
  addLearnedNoise,
  learnedNoise,
  listFlows,
  readOverrides,
  saveFlow,
  saveModel,
  siteName,
  type FlowMeta,
  type SaveResult,
} from "./registry.js";
import type { Recording } from "./record.js";
import type { Exchange, SiteModel } from "./types.js";
import type { StorageSnapshot } from "./infer/trace.js";

// The everyday workflows on top of the registry: add captures to a site, rebuild its API from
// every flow recorded so far (merging, never overwriting), and save the result as a version.

export interface RebuildOptions {
  until?: Stage;
  workDir?: string;
  title?: string;
}

export interface RebuildResult extends Partial<SaveResult> {
  model: SiteModel;
  stage: Stage;
  learned: string[];
}

function mergeStorage(storages: (FlowMeta["storage"] | undefined)[]): StorageSnapshot | undefined {
  const merged: StorageSnapshot = {};
  for (const storage of storages) {
    if (storage?.localStorage)
      merged.localStorage = { ...merged.localStorage, ...storage.localStorage };
    if (storage?.sessionStorage)
      merged.sessionStorage = { ...merged.sessionStorage, ...storage.sessionStorage };
  }
  return merged.localStorage || merged.sessionStorage ? merged : undefined;
}

export async function loadFlows(
  site: string,
): Promise<{ exchanges: Exchange[]; storage?: StorageSnapshot }> {
  const flows = await listFlows(site);
  const captures = await Promise.all(
    flows.map((flow) => loadCapture(flow.harPath, flow.meta.name)),
  );
  const storage = mergeStorage(flows.map((flow) => flow.meta.storage));
  return { exchanges: mergeCaptures(captures), ...(storage ? { storage } : {}) };
}

/** Rebuilds a site's API from all its flows and saves it (unless stopped at an early stage). */
export async function rebuild(site: string, options: RebuildOptions = {}): Promise<RebuildResult> {
  const name = siteName(site);
  const { exchanges, storage } = await loadFlows(name);
  if (!exchanges.length)
    throw new Error(
      `${name} has no recorded flows. Record one: npx site-to-api record https://${name}`,
    );
  const overrides = await readOverrides(name);
  const result = await buildSiteModel(exchanges, {
    site: name,
    overrides,
    learnedNoise: await learnedNoise(),
    ...(storage ? { storage } : {}),
    ...(options.until ? { until: options.until } : {}),
    ...(options.workDir ? { workDir: options.workDir } : {}),
    ...(options.title ? { title: options.title } : {}),
  });
  const learned = result.learned.map((item) => item.pattern);
  await addLearnedNoise(learned);
  if (result.stage !== "trace") return { model: result.model, stage: result.stage, learned };
  const saved = await saveModel(result.model, overrides);
  return { ...saved, model: result.model, stage: result.stage, learned };
}

/** Adds HAR or mitmproxy files to a site as flows. */
export async function importCaptures(site: string, paths: string[]): Promise<string[]> {
  const saved: string[] = [];
  for (const path of paths) {
    const data = await readFile(path);
    parseCapture(data, basename(path));
    const extension = extname(path).slice(1) || "har";
    saved.push(
      await saveFlow(
        siteName(site),
        { name: `import-${basename(path, extname(path))}`, recordedAt: new Date().toISOString() },
        data,
        extension,
      ),
    );
  }
  return saved;
}

/** Saves a finished browser recording as a flow. */
export function saveRecording(
  site: string,
  recording: Recording,
  meta: { name?: string; description?: string; steps?: string[] } = {},
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return saveFlow(
    siteName(site),
    {
      name: meta.name ?? `flow-${stamp}`,
      recordedAt: new Date().toISOString(),
      startUrl: recording.startUrl,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.steps?.length ? { steps: meta.steps } : {}),
      ...(recording.storage ? { storage: recording.storage } : {}),
    },
    recording.har,
  );
}
