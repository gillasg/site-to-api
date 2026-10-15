import type { Channel } from "../types.js";

// Live channels: a site's WebSocket or server-sent events stream, opened from the site's own page
// (its cookies apply). Send messages, listen for a while, and get what arrived:
//   await api.channel("liveFeed", { send: [{ type: "subscribe", room: "42" }], seconds: 15 })

export interface ChannelOptions {
  /** Messages to send once connected (objects are sent as JSON). WebSocket only. */
  send?: unknown[];
  /** How long to listen, in seconds (default 10, at most 120). */
  seconds?: number;
  /** Keep only messages containing this text. */
  match?: string;
  /** Stop after this many messages (default 200). */
  max?: number;
}

export interface ChannelResult {
  channel: string;
  url: string;
  messages: unknown[];
  error?: string;
}

/** Page code that opens the channel and starts collecting into window.__siteToApiChannels[key]. */
export function channelStartExpression(
  channel: Channel,
  key: string,
  options: ChannelOptions,
): string {
  const config = {
    key,
    url: channel.url,
    kind: channel.kind,
    send: (options.send ?? []).map((m) => (typeof m === "string" ? m : JSON.stringify(m))),
    match: options.match ?? "",
    max: options.max ?? 200,
  };
  return `(() => {
  const c = ${JSON.stringify(config)};
  const store = (window.__siteToApiChannels ??= {});
  const state = (store[c.key] = { messages: [], error: undefined, socket: undefined });
  const keep = (data) => {
    const text = typeof data === 'string' ? data : String(data);
    if (c.match && !text.includes(c.match)) return;
    if (state.messages.length < c.max) { try { state.messages.push(JSON.parse(text)); } catch { state.messages.push(text); } }
  };
  if (c.kind === 'sse') {
    const source = new EventSource(c.url, { withCredentials: true });
    source.onmessage = (event) => keep(event.data);
    source.onerror = () => { state.error = state.error ?? 'stream error'; };
    state.socket = source;
  } else {
    const socket = new WebSocket(c.url);
    socket.onopen = () => c.send.forEach((message) => socket.send(message));
    socket.onmessage = (event) => keep(event.data);
    socket.onerror = () => { state.error = 'connection failed'; };
    state.socket = socket;
  }
  return { started: true };
})()`;
}

/** Page code that stops the channel and returns what arrived. */
export function channelStopExpression(key: string): string {
  return `(() => {
  const state = (window.__siteToApiChannels ?? {})[${JSON.stringify(key)}];
  if (!state) return { messages: [], error: 'not started' };
  try { state.socket.close(); } catch {}
  delete window.__siteToApiChannels[${JSON.stringify(key)}];
  return { messages: state.messages, error: state.error };
})()`;
}
