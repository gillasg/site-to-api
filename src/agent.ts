import { RecordingSession } from "./record.js";
import { readOverrides, siteName, writeOverrides } from "./registry.js";
import type { Bridge } from "./runtime/bridge.js";
import type { Overrides, SiteModel } from "./types.js";
import { loadFlows, rebuild, saveRecording } from "./workflow.js";

// The optional model-powered features, using whatever model the user signed in to with
// pi-ai-login (shared with Pi): describe a flow in plain English and an agent performs it in the
// browser while it is recorded; edit an API in plain English; better operation names.

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type Content = { type: string; text?: string } | ToolCall;
type Message = Record<string, unknown> & { role: string; content: unknown };

export interface ModelLike {
  complete(context: {
    systemPrompt: string;
    messages: Message[];
    tools: unknown[];
  }): Promise<{ content: Content[] } & Record<string, unknown>>;
}

/** The user's model, via pi-ai-login. Shows the sign-in page when none is connected yet. */
export async function connectModel(
  options: { provider?: string; model?: string; login?: boolean } = {},
): Promise<ModelLike> {
  const login = await import("pi-ai-login");
  const handle = await login.getModel({
    login: options.login ?? true,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  return {
    complete: (context) => handle.models.completeSimple(handle.model, context as never) as never,
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): unknown {
  return {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

function text(content: Content[]): string {
  return content
    .map((part) => ("text" in part && part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

function toolResult(call: ToolCall, output: string, isError = false): Message {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: output.slice(0, 30_000) }],
    isError,
    timestamp: Date.now(),
  };
}

const BROWSER_PROMPT = `You operate the user's real, signed-in browser through JavaScript (the browser_code tool). A tab is open on the site and every request is being recorded, so the goal is to make the site do the flow through its normal UI.
- \`page\` is the recorded tab. \`await bu.state()\` shows the page with element ids; \`await bu.click(id)\`, \`await bu.type(id, text, { enter: true })\`, \`await page.scroll('down')\`, \`await page.navigate(url)\`.
- Chain several steps per call. Never invent data; use what the page shows. Do not buy, pay, delete or send anything unless the flow explicitly says so.
- When the flow is complete, call done with a one-line summary.`;

export interface FlowResult {
  summary: string;
  steps: string[];
  flowPath: string;
}

export interface FlowOptions {
  startUrl?: string;
  maxSteps?: number;
  model?: ModelLike;
  bridge?: () => Promise<Bridge>;
  onStep?: (code: string) => void;
  /** Browser session for the recording (separate sessions record in parallel). */
  session?: string;
  /** Bring the recorded tab to the front. Default true. */
  foreground?: boolean;
}

const FLOW_TOOLS = [
  tool(
    "browser_code",
    "Run JavaScript in the browser; the last expression is returned.",
    { code: { type: "string" } },
    ["code"],
  ),
  tool("done", "Finish: the flow is complete.", { summary: { type: "string" } }, ["summary"]),
];

/** One agent turn's tool calls: run browser code (keeping the steps that worked) or finish. */
class FlowAgent {
  readonly steps: string[] = [];
  summary = "";

  constructor(
    private readonly session: RecordingSession,
    private readonly onStep?: (code: string) => void,
  ) {}

  async handle(call: ToolCall): Promise<Message> {
    if (call.name === "done") {
      this.summary = String(call.arguments.summary ?? "Done.");
      return toolResult(call, "ok");
    }
    const code = String(call.arguments.code ?? "");
    this.onStep?.(code);
    try {
      const value = await this.session.run(code);
      this.steps.push(code);
      return toolResult(
        call,
        typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"),
      );
    } catch (error) {
      return toolResult(call, error instanceof Error ? error.message : String(error), true);
    }
  }
}

async function drive(
  model: ModelLike,
  agent: FlowAgent,
  messages: Message[],
  maxSteps: number,
): Promise<void> {
  for (let turn = 0; turn < maxSteps && !agent.summary; turn++) {
    const reply = await model.complete({
      systemPrompt: BROWSER_PROMPT,
      messages,
      tools: FLOW_TOOLS,
    });
    messages.push(reply as Message);
    const calls = reply.content.filter((part): part is ToolCall => part.type === "toolCall");
    if (!calls.length) {
      agent.summary = text(reply.content) || "Finished.";
      return;
    }
    for (const call of calls) messages.push(await agent.handle(call));
  }
}

/** An agent performs a described flow in the browser while it is recorded; the flow is saved with its steps. */
export async function performFlow(
  site: string,
  description: string,
  options: FlowOptions = {},
): Promise<FlowResult> {
  const name = siteName(site);
  const model = options.model ?? (await connectModel());
  const session = await RecordingSession.start({
    url: options.startUrl ?? `https://${name}/`,
    ...(options.bridge ? { bridge: options.bridge } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.foreground === false ? { foreground: false } : {}),
  });
  const agent = new FlowAgent(session, options.onStep);
  const messages: Message[] = [
    {
      role: "user",
      content: `Site: ${name}\nFlow to perform: ${description}\nStart with: await bu.state()`,
      timestamp: Date.now(),
    },
  ];
  let recording: Awaited<ReturnType<RecordingSession["stop"]>>;
  try {
    await drive(model, agent, messages, options.maxSteps ?? 30);
  } finally {
    recording = await session.stop();
  }
  const flowPath = await saveRecording(name, recording, { description, steps: agent.steps });
  return {
    summary: agent.summary || "Stopped after the step limit.",
    steps: agent.steps,
    flowPath,
  };
}

function modelSummary(model: SiteModel): string {
  return model.operations
    .map(
      (op) =>
        `${op.id}: ${op.method} ${op.origin}${op.path} params=[${op.params.map((p) => `${p.in}:${p.name}`).join(", ")}] samples=${op.sampleCount}`,
    )
    .join("\n");
}

const OVERRIDES_HELP = `Overrides (JSON) fields:
- templates: path templates to force, e.g. "/api/items/{itemId}"
- names: { generatedId: newId }   - descriptions: { id: text }   - drop: [ids to remove]
- noise / include / exclude: URL regexes   - origins: allowed origins
- redact: { headers, keys, patterns }
- pages: [{ id, url: "https://site/path/{slug}", baseSelector?, fields: [{ name, selector, type?: text|html|attr|number|list, attr? }] }]
- signers: { operationId: "async (request) => ({ status, json })" } (runs in the page)`;

/** A recorded page's HTML, for writing CSS extractors: the exact URL, else the same path. */
async function recordedHtml(site: string, url: string): Promise<string | undefined> {
  const { exchanges } = await loadFlows(site);
  const pages = exchanges.filter((e) => /html/i.test(e.responseMime ?? "") && e.responseBody);
  const path = (href: string) => {
    try {
      return new URL(href).pathname;
    } catch {
      return href;
    }
  };
  return (pages.find((e) => e.url === url) ?? pages.find((e) => path(e.url) === path(url)))
    ?.responseBody;
}

/** Applies a plain-English change to a site's API by editing its overrides, then rebuilds. */
export async function editApi(
  site: string,
  instruction: string,
  options: { model?: ModelLike; pageHtml?: (url: string) => Promise<string | undefined> } = {},
): Promise<{ overrides: Overrides; note: string }> {
  const name = siteName(site);
  const current = await readOverrides(name);
  const { model: built } = await rebuild(name, { until: "infer" });
  const model = options.model ?? (await connectModel());
  const tools = [
    tool(
      "set_overrides",
      "Replace the overrides with this complete JSON object.",
      { overrides: { type: "object" }, note: { type: "string" } },
      ["overrides", "note"],
    ),
    tool(
      "page_html",
      "Read a recorded page's HTML (to write CSS selectors).",
      { url: { type: "string" } },
      ["url"],
    ),
  ];
  const messages: Message[] = [
    {
      role: "user",
      content: `${OVERRIDES_HELP}\n\nOperations:\n${modelSummary(built)}\n\nCurrent overrides:\n${JSON.stringify(current, null, 2)}\n\nChange requested: ${instruction}`,
      timestamp: Date.now(),
    },
  ];
  for (let turn = 0; turn < 8; turn++) {
    const reply = await model.complete({
      systemPrompt:
        "You edit the overrides of an API generated from recorded browser traffic. Make exactly the requested change and keep everything else.",
      messages,
      tools,
    });
    messages.push(reply as Message);
    const calls = reply.content.filter((part): part is ToolCall => part.type === "toolCall");
    const set = calls.find((call) => call.name === "set_overrides");
    if (set) {
      const overrides = set.arguments.overrides as Overrides;
      await writeOverrides(name, overrides);
      await rebuild(name);
      return { overrides, note: String(set.arguments.note ?? "") };
    }
    if (!calls.length) throw new Error(text(reply.content) || "The model made no change.");
    const pageHtml = options.pageHtml ?? ((url: string) => recordedHtml(name, url));
    for (const call of calls) {
      const html = await pageHtml(String(call.arguments.url));
      messages.push(toolResult(call, html?.slice(0, 40_000) ?? "Not recorded."));
    }
  }
  throw new Error("The model did not finish the edit.");
}

/** Readable operation ids and one-line descriptions, written to the overrides. */
export async function nameOperations(
  site: string,
  options: { model?: ModelLike } = {},
): Promise<Record<string, string>> {
  const name = siteName(site);
  const { model: built } = await rebuild(name, { until: "infer" });
  const model = options.model ?? (await connectModel());
  const samples = built.operations
    .map(
      (op) =>
        `${op.id}: ${op.method} ${op.path} → ${(op.samples[0]?.responseBody ?? "").slice(0, 300)}`,
    )
    .join("\n");
  const reply = await model.complete({
    systemPrompt:
      "Name API operations: camelCase verbs + nouns (listOrders, getProduct, addToCart), unique, and a one-line description each.",
    messages: [{ role: "user", content: samples, timestamp: Date.now() }],
    tools: [
      tool(
        "set_names",
        "The new names and descriptions.",
        { names: { type: "object" }, descriptions: { type: "object" } },
        ["names"],
      ),
    ],
  });
  const call = reply.content.find((part): part is ToolCall => part.type === "toolCall");
  if (!call) throw new Error("The model returned no names.");
  const overrides = await readOverrides(name);
  const names = (call.arguments.names ?? {}) as Record<string, string>;
  const descriptions = (call.arguments.descriptions ?? {}) as Record<string, string>;
  overrides.names = { ...overrides.names, ...names };
  overrides.descriptions = {
    ...overrides.descriptions,
    ...Object.fromEntries(
      Object.entries(descriptions).map(([id, text]) => [names[id] ?? id, text]),
    ),
  };
  await writeOverrides(name, overrides);
  await rebuild(name);
  return names;
}
