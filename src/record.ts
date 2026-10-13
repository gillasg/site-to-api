import { sharedBridge, type Bridge } from "./runtime/bridge.js";

// Recording in the user's own browser: open a tab (or take one they already have), capture
// every request with headers, bodies and initiators while they use the site, then hand back
// a HAR plus the page's web storage (to trace tokens kept there).
//
// Passive mode watches every tab on chosen domains instead of one tab.

export interface Recording {
  har: { log: { entries: unknown[] } };
  storage?: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> };
  startUrl: string;
}

export interface RecordOptions {
  url: string;
  /** Record a tab the user already has open (a tab id, or text matching its title or URL). */
  attach?: string | number;
  bridge?: () => Promise<Bridge>;
  /** Bring the tab to the front so the user can use it. Default true. */
  foreground?: boolean;
  session?: string;
}

const SESSION = "site-to-api-record";

function mergeHars(hars: Recording["har"][]): Recording["har"] {
  return { log: { entries: hars.flatMap((har) => har?.log?.entries ?? []) } } as Recording["har"];
}

export class RecordingSession {
  private constructor(
    private readonly bridge: Bridge,
    private readonly session: string,
    readonly startUrl: string,
    private readonly opened: boolean,
  ) {}

  static async start(options: RecordOptions): Promise<RecordingSession> {
    const bridge = await (options.bridge ?? sharedBridge)();
    const session = options.session ?? SESSION;
    const foreground = options.foreground !== false;
    if (options.attach !== undefined) {
      const which = JSON.stringify(options.attach);
      await bridge.run(
        `const __match = ${which};
const __tabs = typeof __match === 'number' ? [{ tabId: __match }] : await browser.tabs(__match);
if (!__tabs.length) throw new Error('No open tab matches ' + __match);
globalThis.__recTabs = [await browser.attachTab(__tabs[0].tabId)];
await globalThis.__recTabs[0].network.start({ types: 'all' });
'recording'`,
        { session },
      );
      return new RecordingSession(bridge, session, options.url, false);
    }
    await bridge.run(
      // Tabs open on web pages only, so the first load happens before recording starts and
      // the page is loaded again once it has.
      `globalThis.__recTabs = [await browser.openTab(${JSON.stringify(options.url)}, { foreground: ${foreground}, new: true })];
await globalThis.__recTabs[0].network.start({ types: 'all' });
await globalThis.__recTabs[0].navigate(${JSON.stringify(options.url)});
'recording'`,
      { session },
    );
    return new RecordingSession(bridge, session, options.url, true);
  }

  /** Runs browser code against the recorded tab (`page` is that tab). */
  run(code: string, timeoutMs = 120_000): Promise<unknown> {
    return this.bridge.run(`page = globalThis.__recTabs[0];\n${code}`, {
      session: this.session,
      timeoutMs,
    });
  }

  async stop(options: { close?: boolean } = {}): Promise<Recording> {
    const result = (await this.bridge.run(
      `const __out = { hars: [], storage: undefined };
for (const tab of globalThis.__recTabs || []) {
  try { __out.hars.push(await tab.network.har()); } catch {}
  if (!__out.storage) { try { __out.storage = await tab.inspect(() => ({ localStorage: Object.fromEntries(Object.entries(localStorage)), sessionStorage: Object.fromEntries(Object.entries(sessionStorage)) })); } catch {} }
  try { await tab.network.stop(); } catch {}
  ${options.close !== false && this.opened ? "try { await tab.close(); } catch {}" : ""}
}
globalThis.__recTabs = [];
__out`,
      { session: this.session, timeoutMs: 180_000 },
    )) as { hars: Recording["har"][]; storage?: Recording["storage"] };
    const recording: Recording = { har: mergeHars(result.hars), startUrl: this.startUrl };
    if (result.storage) recording.storage = result.storage;
    return recording;
  }
}

/** Watches every tab on the given domains, recording each as it appears. */
export class PassiveRecorder {
  private timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly bridge: Bridge,
    private readonly domains: string[],
  ) {}

  static async start(
    domains: string[],
    bridge: () => Promise<Bridge> = sharedBridge,
  ): Promise<PassiveRecorder> {
    const recorder = new PassiveRecorder(await bridge(), domains);
    await recorder.sweep();
    recorder.timer = setInterval(() => void recorder.sweep().catch(() => undefined), 3000);
    return recorder;
  }

  private sweep(): Promise<unknown> {
    return this.bridge.run(
      `const __domains = ${JSON.stringify(this.domains)};
globalThis.__recTabs ??= [];
globalThis.__recIds ??= new Set();
for (const tab of await browser.tabs()) {
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { continue; }
  if (!__domains.some((d) => host === d || host.endsWith('.' + d)) || __recIds.has(tab.tabId)) continue;
  try { const page = await browser.attachTab(tab.tabId); await page.network.start({ types: 'all' }); __recTabs.push(page); __recIds.add(tab.tabId); } catch {}
}
__recTabs.length`,
      { session: SESSION + "-passive" },
    );
  }

  async stop(): Promise<Recording> {
    if (this.timer) clearInterval(this.timer);
    const result = (await this.bridge.run(
      `const __hars = [];
for (const tab of globalThis.__recTabs || []) { try { __hars.push(await tab.network.har()); await tab.network.stop(); } catch {} }
globalThis.__recTabs = []; globalThis.__recIds = new Set();
__hars`,
      { session: SESSION + "-passive", timeoutMs: 180_000 },
    )) as Recording["har"][];
    return { har: mergeHars(result), startUrl: `https://${this.domains[0] ?? ""}/` };
  }
}
