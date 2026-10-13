import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The connection to the user's browser: the Browser Use Extension's local bridge. Each call
// runs a small piece of browser code in a named session; tabs and variables persist per session.

export function bridgeDataDirectory(): string {
  if (process.env.BROWSER_USE_EXTENSION_HOME) return process.env.BROWSER_USE_EXTENSION_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, "browser-use-extension");
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "browser-use-extension");
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "browser-use-extension",
  );
}

export interface CellResult {
  value?: unknown;
  output?: string;
  error?: string;
}

export class BrowserNotConnected extends Error {
  constructor(detail: string) {
    super(
      `${detail} Install the Browser Use Extension in Chrome or Edge and run \`npx browser-use-extension setup\` once, then keep the browser open.`,
    );
    this.name = "BrowserNotConnected";
  }
}

type Waiter = {
  resolve(value: Record<string, unknown>): void;
  onEvent?: (event: Record<string, unknown>) => void;
};

export class Bridge {
  private sequence = 0;
  private readonly waiting = new Map<number, Waiter>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const waiter = this.waiting.get(Number(message.id));
      if (!waiter) return;
      if (message.event) waiter.onEvent?.(message);
      else {
        this.waiting.delete(Number(message.id));
        waiter.resolve(message);
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.waiting.values())
        waiter.resolve({ error: "The browser bridge disconnected." });
      this.waiting.clear();
    });
  }

  static async connect(): Promise<Bridge> {
    let state: { port: number; token: string };
    try {
      state = JSON.parse(
        await readFile(join(bridgeDataDirectory(), "bridge.json"), "utf8"),
      ) as typeof state;
    } catch {
      throw new BrowserNotConnected("The browser bridge has never run on this machine.");
    }
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}/client`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new BrowserNotConnected("The browser bridge did not answer.")),
        5000,
      );
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new BrowserNotConnected("The browser bridge is not running."));
      });
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ kind: "hello", token: state.token })),
      );
      socket.addEventListener(
        "message",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    return new Bridge(socket);
  }

  private request(
    kind: string,
    body: Record<string, unknown> = {},
    onEvent?: Waiter["onEvent"],
  ): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve, ...(onEvent ? { onEvent } : {}) });
      this.socket.send(JSON.stringify({ id, kind, ...body }));
    });
  }

  async status(): Promise<{ browsers: number }> {
    const reply = await this.request("status");
    return { browsers: Number(reply.browsers ?? 0) };
  }

  /** Runs browser code; throws with the cell's error so callers see what the page said. */
  async run(
    code: string,
    options: { session?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const reply = (await this.request("run", {
      code,
      session: options.session ?? "site-to-api",
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    })) as CellResult;
    if (reply.error) {
      if (/BROWSER_OFFLINE|no browser/i.test(reply.error))
        throw new BrowserNotConnected("No browser is connected to the bridge.");
      throw new Error(reply.error);
    }
    return reply.value;
  }

  close(): void {
    this.socket.close();
  }
}

/** One shared connection per process, opened on first use. */
let shared: Promise<Bridge> | undefined;

export function sharedBridge(): Promise<Bridge> {
  shared ??= Bridge.connect().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

export async function closeSharedBridge(): Promise<void> {
  const current = shared;
  shared = undefined;
  if (current) (await current.catch(() => undefined))?.close();
}
