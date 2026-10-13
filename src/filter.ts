import type { Category, Exchange, NoiseReport, Overrides } from "./types.js";

// Keeps the requests that make up a site's API and drops everything else, saying why.

const ANALYTICS_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
  "adservice.google.com",
  "connect.facebook.net",
  "facebook.com/tr",
  "segment.io",
  "segment.com",
  "api.segment.io",
  "cdn.segment.com",
  "mixpanel.com",
  "amplitude.com",
  "hotjar.com",
  "hotjar.io",
  "sentry.io",
  "ingest.sentry.io",
  "browser-intake-datadoghq.com",
  "datadoghq-browser-agent.com",
  "nr-data.net",
  "newrelic.com",
  "clarity.ms",
  "fullstory.com",
  "heapanalytics.com",
  "optimizely.com",
  "launchdarkly.com",
  "braze.com",
  "branch.io",
  "app.link",
  "appsflyer.com",
  "adjust.com",
  "analytics.tiktok.com",
  "px.ads.linkedin.com",
  "snap.licdn.com",
  "ads-twitter.com",
  "analytics.twitter.com",
  "ct.pinterest.com",
  "sc-static.net",
  "tr.snapchat.com",
  "bat.bing.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "quantserve.com",
  "scorecardresearch.com",
  "chartbeat.com",
  "chartbeat.net",
  "parsely.com",
  "cloudflareinsights.com",
  "onetrust.com",
  "cookielaw.org",
  "cookiebot.com",
  "trustarc.com",
  "usercentrics.eu",
  "m.stripe.network",
  "logrocket.io",
  "lr-ingest.io",
  "mouseflow.com",
  "crazyegg.com",
  "smartlook.com",
  "posthog.com",
  "plausible.io",
  "matomo.cloud",
  "rudderstack.com",
  "moengage.com",
  "clevertap-prod.com",
  "wzrkt.com",
  "webengage.com",
  "pubmatic.com",
  "rubiconproject.com",
  "adnxs.com",
  "casalemedia.com",
  "amazon-adsystem.com",
  "yandex.ru/metrika",
  "mc.yandex.ru",
  "tealium.com",
  "tiqcdn.com",
  "ensighten.com",
  "adobedtm.com",
  "omtrdc.net",
  "demdex.net",
  "everesttech.net",
  "2o7.net",
  "krxd.net",
  "bluekai.com",
  "rlcdn.com",
  "bidswitch.net",
  "openx.net",
  "3lift.com",
  "teads.tv",
  "bugsnag.com",
  "rollbar.com",
  "raygun.io",
  "trackjs.com",
  "speedcurve.com",
  "intercom.io",
  "intercomcdn.com",
  "zdassets.com",
  "zopim.com",
  "drift.com",
  "crisp.chat",
  "freshchat.com",
  "tawk.to",
  "livechatinc.com",
  "hs-analytics.net",
  "hs-banner.com",
  "hsforms.com",
  "fonts.googleapis.com",
  "gstatic.com",
  "recaptcha.net",
  "pagead2.googlesyndication.com",
  "region1.google-analytics.com",
];

const BOT_DEFENSE = [
  /\/cdn-cgi\/(challenge-platform|rum|bm\/)/i,
  /recaptcha\/|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha/i,
  /perimeterx\.net|px-cdn\.net|px-cloud\.net|\/px\/[a-z0-9]+\/(xhr|init)/i,
  /datadome\.co|captcha-delivery\.com|\/akam\/\d+\/|kasada|\/149e9513-01fa-4fb0-aad4-566afd725d1b\//i,
  /imperva|incapsula|_Incapsula_Resource|\/_sec\/cp_challenge|queue-it\.net/i,
];

const NOISE_PATHS =
  /\/(collect|beacon|track(ing)?|events?|analytics|telemetry|metrics|rum|pixel|ping|heartbeat|keep-?alive|log(s|ging)?|csp-report|report-uri|sockjs-node|__webpack_hmr|hot-update[^/]*|stats|impression|clicks?)(\/|$|\?|\.)/i;

const STATIC_FILE =
  /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|m4a|pdf|zip|wasm)(\?|$)/i;

const STATIC_PATHS =
  /\/(_next\/static|static\/|assets\/|favicon|manifest\.json|robots\.txt|sw\.js|service-worker|\.well-known\/)/i;

const AUTH_PATHS =
  /\/(oauth2?|auth|token|refresh|session|login|signin|sign-in|csrf|xsrf)(\/|$|\?)/i;

export interface Classified {
  exchange: Exchange;
  category: Category;
}

export interface FilterResult {
  kept: Classified[];
  noise: NoiseReport[];
}

export interface FilterOptions {
  include?: string[];
  exclude?: string[];
  origins?: string[];
  /** Learned or hand-added noise patterns (URL regexes). */
  noise?: string[];
}

function isJsonLike(exchange: Exchange): boolean {
  const mime = (
    exchange.responseMime ??
    exchange.responseHeaders["content-type"] ??
    ""
  ).toLowerCase();
  if (/json|graphql|xml|protobuf|grpc|x-ndjson/.test(mime)) return true;
  const body = exchange.responseBody?.trimStart() ?? "";
  return /^text\/plain/.test(mime) && (body.startsWith("{") || body.startsWith("["));
}

function isDocument(exchange: Exchange): boolean {
  if (exchange.resourceType === "document") return true;
  const mime = (
    exchange.responseMime ??
    exchange.responseHeaders["content-type"] ??
    ""
  ).toLowerCase();
  return !exchange.resourceType && exchange.method === "GET" && mime.includes("html");
}

function analyticsHost(url: URL): boolean {
  const target = url.hostname + url.pathname;
  return ANALYTICS_HOSTS.some(
    (host) => target === host || target.startsWith(host) || target.includes("." + host),
  );
}

const matchesAny = (patterns: string[] | undefined, url: URL) =>
  !!patterns?.some((pattern) => new RegExp(pattern, "i").test(url.href));

function transportReason(exchange: Exchange): string | undefined {
  if (exchange.method === "OPTIONS") return "CORS preflight";
  if (exchange.status >= 300 && exchange.status < 400) return "redirect";
  return exchange.status === 0 ? "failed or blocked" : undefined;
}

function optionReason(url: URL, options: FilterOptions): string | undefined {
  if (options.origins?.length && !options.origins.some((origin) => originMatches(url, origin)))
    return "outside the allowed origins";
  if (options.include?.length && !matchesAny(options.include, url)) return "not matched by include";
  if (matchesAny(options.exclude, url)) return "matched by exclude";
  return matchesAny(options.noise, url) ? "learned noise" : undefined;
}

/** Why an exchange is not part of the API, or undefined to keep it. */
function dropReason(exchange: Exchange, url: URL, options: FilterOptions): string | undefined {
  const reason = transportReason(exchange) ?? optionReason(url, options);
  if (reason) return reason;
  if (analyticsHost(url)) return "analytics or ads";
  if (BOT_DEFENSE.some((pattern) => pattern.test(url.href))) return "bot defense";
  return staticReason(exchange, url);
}

function staticReason(exchange: Exchange, url: URL): string | undefined {
  const type = exchange.resourceType;
  if (
    type &&
    /^(script|stylesheet|image|font|media|manifest|texttrack|ping|cspviolationreport|preflight)$/.test(
      type,
    )
  )
    return `static ${type}`;
  if (STATIC_FILE.test(url.pathname) || STATIC_PATHS.test(url.pathname)) return "static file";
  const stream =
    type === "eventsource" || type === "websocket" || !!exchange.frames || !!exchange.messages;
  if (!stream && NOISE_PATHS.test(url.pathname) && !isUsefulResponse(exchange)) return "telemetry";
  return undefined;
}

/** Beacons answer with nothing; a real endpoint at a /events path answers with data. */
function isUsefulResponse(exchange: Exchange): boolean {
  const body = exchange.responseBody?.trim() ?? "";
  return exchange.status !== 204 && body.length > 20 && isJsonLike(exchange);
}

export function originMatches(url: URL, origin: string): boolean {
  if (origin.includes("://")) return url.origin === new URL(origin).origin;
  // "shop.example" covers its subdomains; "127.0.0.1:8080" names a host and port.
  const host = origin.includes(":") ? url.host : url.hostname;
  return host === origin || host.endsWith("." + origin);
}

function isStream(exchange: Exchange): boolean {
  const type = exchange.resourceType;
  return type === "websocket" || type === "eventsource" || !!exchange.frames || !!exchange.messages;
}

function categorize(exchange: Exchange, url: URL): Category | undefined {
  if (isStream(exchange)) return "channel";
  if (isDocument(exchange)) return "document";
  const type = exchange.resourceType;
  if (type && !["xhr", "fetch", "other"].includes(type)) return undefined;
  const answersData = isJsonLike(exchange) || exchange.status === 204 || exchange.method !== "GET";
  if (!answersData) return undefined;
  return AUTH_PATHS.test(url.pathname) ? "auth" : "api";
}

export function filterExchanges(exchanges: Exchange[], options: FilterOptions = {}): FilterResult {
  const kept: Classified[] = [];
  const reasons = new Map<string, NoiseReport>();
  const drop = (url: URL, reason: string) => {
    const key = `${url.origin}${url.pathname}|${reason}`;
    const report = reasons.get(key) ?? { url: url.origin + url.pathname, reason, count: 0 };
    report.count++;
    reasons.set(key, report);
  };
  for (const exchange of exchanges) {
    let url: URL;
    try {
      url = new URL(exchange.url);
    } catch {
      continue;
    }
    if (!/^(https?|wss?):$/.test(url.protocol)) continue;
    const reason = dropReason(exchange, url, options);
    if (reason) {
      drop(url, reason);
      continue;
    }
    const category = categorize(exchange, url);
    if (category) kept.push({ exchange, category });
    else drop(url, "not an API response");
  }
  return { kept, noise: [...reasons.values()].sort((a, b) => b.count - a.count) };
}

/**
 * Learns noise that the fixed lists miss: an endpoint hit at least three times, always with a
 * body, that never answers with data (event batches, client logs). Returns URL patterns.
 */
export function learnNoise(kept: Classified[]): { pattern: string; url: string }[] {
  const byEndpoint = new Map<string, Exchange[]>();
  for (const { exchange, category } of kept) {
    if (category !== "api" || exchange.method === "GET") continue;
    const url = new URL(exchange.url);
    const key = url.origin + url.pathname;
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), exchange]);
  }
  const learned: { pattern: string; url: string }[] = [];
  for (const [key, list] of byEndpoint) {
    if (list.length < 3) continue;
    const empty = list.every(
      (item) => (item.responseBody ?? "").trim().length <= 2 || item.status === 204,
    );
    const eventLike = list.every((item) =>
      /"(events?|event_type|eventName|ts|timestamp|sid|session_id|batch)"/.test(
        item.requestBody ?? "",
      ),
    );
    if (empty && eventLike) learned.push({ pattern: "^" + escapeRegex(key) + "(\\?|$)", url: key });
  }
  return learned;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function filterOptions(overrides: Overrides, learned: string[] = []): FilterOptions {
  return {
    include: overrides.include ?? [],
    exclude: overrides.exclude ?? [],
    origins: overrides.origins ?? [],
    noise: [...(overrides.noise ?? []), ...learned],
  };
}
