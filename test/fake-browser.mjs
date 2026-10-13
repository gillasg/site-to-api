// A stand-in for the browser bridge in unit tests: runs the browser code site-to-api sends,
// with tabs whose "page" is a sandbox holding the site's cookies, its meta tags, web storage
// and the site's own fetch wrapper (which signs requests, like real sites do).
import vm from "node:vm";
import { sign } from "./fixture-site.mjs";

class FakeTab {
  constructor(browser, url) {
    this.browser = browser;
    this.url = url;
    this.html = "";
  }

  async load() {
    const response = await this.browser.fetch(this.url, {});
    this.html = await response.text();
  }

  pageContext() {
    const browser = this.browser;
    const html = () => this.html;
    const origin = new URL(this.url).origin;
    const document = {
      get cookie() {
        return [...browser.cookies]
          .filter(([name]) => !browser.httpOnly.has(name))
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      },
      querySelector(selector) {
        const name = /meta\[name="([^"]+)"/.exec(selector)?.[1];
        const match = name && new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html());
        return match ? { content: match[1], getAttribute: () => match[1] } : null;
      },
    };
    const realFetch = (input, init = {}) => browser.fetch(new URL(input, origin).href, init);
    // The site's own wrapper, as its page script installs it: signs /api/signed calls.
    const fetch = (input, init = {}) => {
      const url = new URL(input, origin);
      if (url.pathname.startsWith("/api/signed")) {
        const ts = String(Date.now());
        init = {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            "x-timestamp": ts,
            "x-signature": sign(init.method || "GET", url.pathname + url.search, ts),
          },
        };
      }
      return realFetch(url.href, init);
    };
    const storage = (data) => ({
      getItem: (k) => data[k] ?? null,
      setItem: (k, v) => (data[k] = String(v)),
      ...data,
    });
    const localStorage = storage(browser.localStorage);
    const sessionStorage = storage({});
    const window = { localStorage, sessionStorage, fetch };
    return vm.createContext({
      document,
      window,
      localStorage,
      sessionStorage,
      fetch,
      location: new URL(this.url),
      URL,
      Headers,
      DOMParser: undefined,
      XMLHttpRequest: undefined,
      JSON,
      Object,
      String,
      Number,
      Promise,
      decodeURIComponent,
      encodeURIComponent,
    });
  }

  async inspect(expression) {
    const value = await vm.runInContext(
      typeof expression === "function" ? `(${expression})()` : expression,
      this.pageContext(),
    );
    return JSON.parse(JSON.stringify(value ?? null));
  }

  async navigate(url) {
    this.url = url;
    await this.load();
  }

  get network() {
    const browser = this.browser;
    return {
      start: async () => (browser.recording = []),
      har: async () => ({ log: { version: "1.2", entries: browser.recording ?? [] } }),
      stop: async () => (browser.recording = undefined),
    };
  }

  async close() {}
}

export class FakeBrowser {
  constructor() {
    this.cookies = new Map();
    this.httpOnly = new Set();
    this.localStorage = {};
    this.tabs = [];
    this.calls = [];
  }

  async fetch(url, init) {
    const headers = { ...(init.headers ?? {}) };
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    this.calls.push({ url, method: init.method ?? "GET", headers });
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "follow",
    });
    if (this.recording) await this.record(url, init, headers, response.clone());
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...rest] = line.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      this.cookies.set(name, pair.slice(pair.indexOf("=") + 1));
      if (rest.some((attr) => /httponly/i.test(attr))) this.httpOnly.add(name);
    }
    return response;
  }

  /** What a recording tab would capture, as HAR entries. */
  async record(url, init, headers, response) {
    this.recording.push({
      startedDateTime: new Date(Date.now() + this.recording.length).toISOString(),
      _resourceType: "fetch",
      request: {
        method: init.method ?? "GET",
        url,
        headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
        ...(init.body ? { postData: { text: init.body } } : {}),
      },
      response: {
        status: response.status,
        headers: [...response.headers].map(([name, value]) => ({ name, value })),
        content: {
          mimeType: response.headers.get("content-type") ?? "",
          text: await response.text(),
        },
      },
    });
  }

  /** The Bridge interface PageTransport uses. */
  async run(code) {
    const browser = {
      openTab: async (url) => {
        const tab = new FakeTab(this, url);
        await tab.load();
        this.tabs.push(tab);
        return tab;
      },
    };
    const lines = code.trim().split("\n");
    lines[lines.length - 1] = "return " + lines[lines.length - 1];
    const context = vm.createContext({ browser, globalThis: (this.globals ??= {}), JSON, Error });
    return vm.runInContext(`(async () => { ${lines.join("\n")} })()`, context);
  }
}
