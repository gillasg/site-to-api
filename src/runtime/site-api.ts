import { originMatches } from "../filter.js";
import { extractEmbedded, metaTags } from "../infer/html.js";
import { getPointer } from "../infer/schema.js";
import { loadModel, readOverrides, readSession, siteName } from "../registry.js";
import type { Operation, PageEndpoint, SecurityScheme, SiteModel } from "../types.js";
import { BrowserNotConnected, type Bridge } from "./bridge.js";
import { RateLimiter, RETRYABLE, retryDelay, sleep } from "./limits.js";
import {
  buildRequest,
  dependencyFor,
  MissingParams,
  SET,
  type Params,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./request.js";
import type { SessionFile } from "./session.js";
import { DirectTransport, PageTransport, type CallContext, type Transport } from "./transports.js";
import { pageExtractExpression } from "./page-extract.js";
import { paginate, type PaginateOptions } from "./paginate.js";

// The runtime: `const api = await siteApi("shop.example")`, then `await api.searchProducts({ q })`
// or `for await (const item of api.paginate.searchProducts({ q }))`.

export interface SiteApiOptions {
  /** auto (default): direct when nothing needs the browser, else the page. */
  transport?: "auto" | "page" | "direct";
  model?: SiteModel;
  session?: SessionFile | false;
  /** Requests per second and parallel calls for this site. Default 5 and 4. */
  rateLimit?: { perSecond?: number; concurrency?: number };
  retries?: number;
  bridge?: () => Promise<Bridge>;
  /** Custom transports (for tests or other runtimes). */
  transports?: { page?: Transport; direct?: Transport };
  signers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly response: RuntimeResponse,
  ) {
    const detail =
      response.json !== undefined ? JSON.stringify(response.json) : (response.text ?? "");
    super(`${operationId} answered HTTP ${response.status}: ${detail.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

const SESSION_FRESH_MS = 12 * 3600_000;

export class SiteClient {
  readonly site: string;
  private readonly limiter: RateLimiter;
  private readonly page: Transport;
  private readonly direct: Transport;
  private readonly cache = new Map<string, { value: string; at: number }>();

  constructor(
    readonly model: SiteModel,
    private readonly options: Omit<SiteApiOptions, "session"> & { session?: SessionFile },
  ) {
    this.site = model.site;
    this.limiter = new RateLimiter(
      options.rateLimit?.perSecond ?? 5,
      options.rateLimit?.concurrency ?? 4,
    );
    this.page = options.transports?.page ?? new PageTransport(options.bridge);
    this.direct = options.transports?.direct ?? new DirectTransport(options.session);
  }

  get operations(): Operation[] {
    return this.model.operations;
  }

  operation(id: string): Operation {
    const operation = this.model.operations.find((op) => op.id === id);
    if (!operation)
      throw new Error(
        `${this.site} has no operation ${id}. Known: ${this.model.operations.map((op) => op.id).join(", ")}`,
      );
    return operation;
  }

  /** Where the site calls this operation from: its tab is opened there. */
  home(operation: { origin: string; pageUrls?: string[] }): string {
    const page = operation.pageUrls?.[0];
    if (page) return new URL(page).origin + "/";
    const main = this.model.origins.find((origin) => originMatches(new URL(origin), this.site));
    return (main ?? `https://${this.site}`) + "/";
  }

  private schemes(operation: Operation): SecurityScheme[] {
    return this.model.security.filter((scheme) => operation.security.includes(scheme.name));
  }

  private chooseTransport(operation: Operation): Transport {
    const mode = this.options.transport ?? "auto";
    if (mode === "page") return this.page;
    if (mode === "direct") return this.direct;
    if (operation.signing || this.options.signers?.[operation.id]) return this.page;
    const schemes = this.schemes(operation);
    const needsBrowserState = schemes.some(
      (s) => s.type !== "apiKey" || (s.source && s.source.kind !== "constant"),
    );
    if (!needsBrowserState) return this.direct;
    const session = this.options.session;
    const fresh = session && Date.now() - Date.parse(session.savedAt) < SESSION_FRESH_MS;
    return fresh ? this.direct : this.page;
  }

  /** Auth values that come from another operation's response (a token endpoint). */
  private async responseAuth(
    operation: Operation,
    params: Params,
    depth: number,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const scheme of this.schemes(operation)) {
      if (
        scheme.source?.kind !== "response" ||
        scheme.source.operationId === operation.id ||
        !scheme.key
      )
        continue;
      const value = await this.cached(`auth:${scheme.name}`, async () => {
        const source = scheme.source as { operationId: string; pointer: string };
        const response = await this.request(source.operationId, params, depth + 1);
        return String(getPointer(response.json, source.pointer.replace(/\*/g, "0")) ?? "");
      });
      if (!value) continue;
      if (scheme.type === "bearer") headers.authorization = `Bearer ${value}`;
      else if (scheme.in === "header") headers[scheme.key] = value;
    }
    return headers;
  }

  /** CSRF tokens kept in a page's meta tag, for calls made outside the browser. */
  private async metaAuth(
    operation: Operation,
    transport: Transport,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (transport.name !== "direct") return headers;
    for (const scheme of this.schemes(operation)) {
      if (scheme.source?.kind !== "meta" || !scheme.key || scheme.in !== "header") continue;
      const name = scheme.source.name;
      const value = await this.cached(`meta:${name}`, async () => {
        const page = await transport.send(
          {
            operationId: "page",
            origin: operation.origin,
            method: "GET",
            url: this.home(operation),
            headers: { accept: "text/html" },
          },
          { auth: [], home: this.home(operation) },
        );
        return metaTags(page.text ?? "")[name] ?? "";
      });
      if (value) headers[scheme.key] = value;
    }
    return headers;
  }

  private async cached(key: string, load: () => Promise<string>): Promise<string> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const value = await load();
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  /** Fills required inputs nobody passed from the operations that produce them. */
  private async resolveMissing(
    operation: Operation,
    params: Params,
    missing: string[],
    depth: number,
  ): Promise<Params> {
    if (depth > 3) throw new MissingParams(operation, missing);
    const sets: Params = { ...((params[SET] as Params | undefined) ?? {}) };
    const unresolved: string[] = [];
    for (const target of missing) {
      const dep = dependencyFor(operation, target);
      if (!dep) {
        unresolved.push(target);
        continue;
      }
      const response = await this.request(dep.source.operationId, params, depth + 1);
      const value = getPointer(response.json, dep.source.pointer.replace(/\*/g, "0"));
      if (value === undefined) unresolved.push(target);
      else sets[target] = value;
    }
    if (unresolved.length) throw new MissingParams(operation, unresolved);
    return { ...params, [SET]: sets };
  }

  private context(operation: Operation): CallContext {
    const context: CallContext = { auth: this.schemes(operation), home: this.home(operation) };
    if (operation.signing) context.via = operation.signing.via;
    const signer = this.options.signers?.[operation.id];
    if (signer) context.signer = signer;
    return context;
  }

  private async send(
    transport: Transport,
    request: RuntimeRequest,
    context: CallContext,
  ): Promise<RuntimeResponse> {
    const retries = this.options.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.limiter.run(() => transport.send(request, context));
        if (!RETRYABLE.has(response.status) || attempt >= retries) return response;
        await sleep(retryDelay(attempt, response.headers["retry-after"]));
      } catch (error) {
        if (error instanceof BrowserNotConnected || attempt >= retries) throw error;
        await sleep(retryDelay(attempt));
      }
    }
  }

  private async prepare(
    operation: Operation,
    params: Params,
    depth: number,
  ): Promise<RuntimeRequest> {
    let built = buildRequest(operation, params);
    if (built.missing.length)
      built = buildRequest(
        operation,
        await this.resolveMissing(operation, params, built.missing, depth),
      );
    return built.request;
  }

  /** Sends; when the browser is gone and the mode allows it, falls back to a direct call. */
  private async sendWithFallback(
    transport: Transport,
    request: RuntimeRequest,
    context: CallContext,
  ): Promise<{ response: RuntimeResponse; transport: Transport }> {
    try {
      return { response: await this.send(transport, request, context), transport };
    } catch (error) {
      const canFallBack = transport !== this.direct && this.options.transport !== "page";
      if (!(error instanceof BrowserNotConnected) || !canFallBack) throw error;
      return { response: await this.send(this.direct, request, context), transport: this.direct };
    }
  }

  /** After a 401/403: retry in the page (auto mode), or renew a token and retry. */
  private async retryAuth(
    operation: Operation,
    params: Params,
    depth: number,
    sent: { request: RuntimeRequest; context: CallContext; transport: Transport },
  ): Promise<RuntimeResponse | undefined> {
    if (this.options.transport === "direct") return undefined;
    for (const key of [...this.cache.keys()]) if (key.startsWith("auth:")) this.cache.delete(key);
    if (sent.transport === this.direct && (this.options.transport ?? "auto") === "auto")
      return this.send(this.page, sent.request, sent.context);
    if (!this.schemes(operation).some((s) => s.refresh)) return undefined;
    Object.assign(sent.request.headers, await this.responseAuth(operation, params, depth));
    return this.send(sent.transport, sent.request, sent.context);
  }

  /** The full response (status, headers, body) for an operation. */
  async request(id: string, params: Params = {}, depth = 0): Promise<RuntimeResponse> {
    const operation = this.operation(id);
    const request = await this.prepare(operation, params, depth);
    const chosen = this.chooseTransport(operation);
    Object.assign(
      request.headers,
      await this.responseAuth(operation, params, depth),
      await this.metaAuth(operation, chosen),
    );
    const context = this.context(operation);
    const { response, transport } = await this.sendWithFallback(chosen, request, context);
    if (response.status !== 401 && response.status !== 403) return response;
    return (
      (await this.retryAuth(operation, params, depth, { request, context, transport })) ?? response
    );
  }

  /** The operation's data; throws HttpError on 4xx/5xx. */
  async call(id: string, params: Params = {}): Promise<unknown> {
    const response = await this.request(id, params);
    if (response.status >= 400 || response.status === 0) throw new HttpError(id, response);
    return response.json ?? response.text;
  }

  paginate(id: string, params: Params = {}, options: PaginateOptions = {}): AsyncIterable<unknown> {
    return paginate(this, this.operation(id), params, options);
  }

  pageEndpoint(id: string): PageEndpoint | undefined {
    return this.model.pages.find((page) => page.id === id);
  }

  private pageUrl(page: PageEndpoint, params: Record<string, string>): string {
    let path = page.path;
    for (const param of page.params) {
      const value = params[param.name];
      if (value === undefined) throw new Error(`${page.id} needs ${param.name}`);
      path = path.replace(`{${param.name}}`, encodeURIComponent(value));
    }
    return page.origin + path;
  }

  /** A server-rendered page's data: its embedded state, or fields read with its CSS extractor. */
  async fetchPage(id: string, params: Record<string, string> = {}): Promise<unknown> {
    const page = this.pageEndpoint(id);
    if (!page) throw new Error(`${this.site} has no page endpoint ${id}`);
    const url = this.pageUrl(page, params);
    const home = page.origin + "/";
    const inBrowser = page.extractor || (this.options.transport ?? "auto") !== "direct";
    const transport = this.page as Partial<PageTransport>;
    if (inBrowser && transport.inPage) {
      const inPage = transport.inPage.bind(transport);
      const result = await this.limiter.run(() =>
        inPage(home, pageExtractExpression(url, page.extractor)),
      );
      if (page.extractor) return result;
      return extractEmbedded(String((result as { html?: string } | null)?.html ?? ""));
    }
    const request = {
      operationId: id,
      origin: page.origin,
      method: "GET",
      url,
      headers: { accept: "text/html" },
    };
    const response = await this.limiter.run(() => this.direct.send(request, { auth: [], home }));
    return extractEmbedded(response.text ?? "");
  }
}

export type SiteApi = SiteClient &
  Record<string, unknown> & {
    paginate: Record<
      string,
      (params?: Params, options?: PaginateOptions) => AsyncIterable<unknown>
    >;
  };

/** Opens a mapped site from the registry (or a given model) as a callable API. */
export async function siteApi(site: string, options: SiteApiOptions = {}): Promise<SiteApi> {
  const model = options.model ?? (await loadModel(site));
  if (!model)
    throw new Error(
      `${siteName(site)} is not mapped yet. Record it first: npx site-to-api record https://${siteName(site)}`,
    );
  const overrides = options.model ? {} : await readOverrides(site);
  const session =
    options.session === false ? undefined : (options.session ?? (await readSession(model.site)));
  const { session: _ignored, ...rest } = options;
  void _ignored;
  const client = new SiteClient(model, {
    ...rest,
    ...(session ? { session } : {}),
    signers: { ...(overrides.signers ?? {}), ...(options.signers ?? {}) },
  });
  // api.paginate("listItems", params) and api.paginate.listItems(params) both work.
  const pagers = new Proxy(
    (id: string, params?: Params, opts?: PaginateOptions) => client.paginate(id, params, opts),
    {
      get: (_, name: string) => (params?: Params, opts?: PaginateOptions) =>
        client.paginate(name, params, opts),
    },
  );
  return new Proxy(client, {
    get(target, name, receiver) {
      if (name === "paginate") return pagers;
      if (typeof name === "string" && !(name in target)) {
        if (target.model.operations.some((op) => op.id === name))
          return (params?: Params) => target.call(name, params);
        if (target.pageEndpoint(name))
          return (params?: Record<string, string>) => target.fetchPage(name, params);
      }
      return Reflect.get(target, name, receiver);
    },
  }) as SiteApi;
}
