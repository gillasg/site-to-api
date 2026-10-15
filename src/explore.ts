import { connectModel, performFlow, type ModelLike } from "./agent.js";
import { siteName } from "./registry.js";
import type { Bridge } from "./runtime/bridge.js";
import { rebuild } from "./workflow.js";

// Mapping a site by name: an agent opens it in the user's browser and uses its main features
// (search, filters, pages, item details, sections) while every request is recorded, then the API
// is built from that. Several sites run at once, each in its own background tab.

export const EXPLORE_BRIEF = `Use this site's main features so that its API shows up in the recording:
- search for something typical for this site, and open the next page of results;
- apply a filter or change the sort order;
- open an item's or an article's details page;
- open the main sections or categories from its navigation.
Look around, do not change anything: never buy, book, post, send, follow, like, delete or change settings. Close pop-ups and cookie banners. Stop once these have been done.`;

/** With actions: true, writes are blocked in the browser, so the agent may press action buttons. */
export const EXPLORE_ACTIONS_BRIEF = `Use this site's main features so that its API shows up in the recording: search, open the next page of results, apply a filter, open an item's details, open the main sections.
This tab is in dry run: any request that would change something is blocked before it reaches the site and only recorded. So also use each of the site's main actions once (for example like, follow, save, add to cart, comment, send a message, post), filling forms with harmless test values. The page may act as if it worked; nothing was sent. Do not enter payment card details or passwords. Close pop-ups and cookie banners. Stop once these have been done.`;

export interface ExploreOptions {
  /** Extra things to do, for example "check delivery dates" or "open the cart". */
  goal?: string;
  model?: ModelLike;
  bridge?: () => Promise<Bridge>;
  /** Browser steps per site (default 25). */
  maxSteps?: number;
  /** Sites at once (default 3). */
  parallel?: number;
  /** Bring tabs to the front (default false: background tabs). */
  foreground?: boolean;
  onSite?: (result: ExploreResult) => void;
  /** Also map the site's actions (like, send, post, add to cart) in dry run: blocked, recorded only. */
  actions?: boolean;
}

export interface ExploreResult {
  site: string;
  summary?: string;
  operations?: number;
  version?: number;
  error?: string;
}

const brief = (options: ExploreOptions) =>
  options.actions ? EXPLORE_ACTIONS_BRIEF : EXPLORE_BRIEF;

async function exploreOne(
  site: string,
  model: ModelLike,
  options: ExploreOptions,
): Promise<ExploreResult> {
  const name = siteName(site);
  // A full URL starts there; a bare name starts at its home page.
  const startUrl = /^https?:\/\//i.test(site) ? site : undefined;
  try {
    const flow = await performFlow(
      name,
      options.goal ? `${brief(options)}\nAlso: ${options.goal}` : brief(options),
      {
        model,
        maxSteps: options.maxSteps ?? 25,
        session: `site-to-api-explore-${name}`,
        ...(startUrl ? { startUrl } : {}),
        foreground: options.foreground === true,
        ...(options.actions ? { dryRun: true } : {}),
        ...(options.bridge ? { bridge: options.bridge } : {}),
      },
    );
    const built = await rebuild(name);
    return {
      site: name,
      summary: flow.summary,
      operations: built.model.operations.length,
      version: built.version,
    };
  } catch (error) {
    return { site: name, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Maps each site (a name, or a URL to start from) by using it; returns what was found per site. */
export async function explore(
  sites: string[],
  options: ExploreOptions = {},
): Promise<ExploreResult[]> {
  const model = options.model ?? (await connectModel());
  const seen = new Set<string>();
  const queue = sites.filter((site) => !seen.has(siteName(site)) && seen.add(siteName(site)));
  const results: ExploreResult[] = [];
  const worker = async (): Promise<void> => {
    for (let site = queue.shift(); site; site = queue.shift()) {
      const result = await exploreOne(site, model, options);
      results.push(result);
      options.onSite?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.parallel ?? 3) }, worker));
  return results;
}
