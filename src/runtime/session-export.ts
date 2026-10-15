import { originMatches } from "../filter.js";
import { writeSession } from "../registry.js";
import type { SiteModel } from "../types.js";
import type { Bridge } from "./bridge.js";
import { sharedBridge } from "./bridge.js";
import { sessionExportExpression, type SessionFile } from "./session.js";
import { PageTransport } from "./transports.js";

// Exports the user's session for a site from their browser (cookies plus web storage), so calls
// can run from Node. Used by `site-to-api session`, and to renew an exported session that expired.

export async function exportSession(
  model: SiteModel,
  bridge?: () => Promise<Bridge>,
): Promise<{ session: SessionFile; path: string }> {
  const page = new PageTransport(bridge);
  const home =
    model.origins.find((o) => originMatches(new URL(o), model.site)) ?? `https://${model.site}`;
  const info = (await page.inPage(home + "/", sessionExportExpression())) as {
    userAgent: string;
    language: string;
    origin: string;
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  };
  const cookies = (await (
    await (bridge ?? sharedBridge)()
  ).run(
    `(await globalThis.__siteToApiTabs[${JSON.stringify(new URL(home).origin)}].cdp('Network.getCookies', { urls: ${JSON.stringify(model.origins.map((o) => o + "/"))} })).cookies`,
    { session: "site-to-api" },
  )) as SessionFile["cookies"];
  const session: SessionFile = {
    site: model.site,
    savedAt: new Date().toISOString(),
    userAgent: info.userAgent,
    language: info.language,
    cookies,
    localStorage: { [info.origin]: info.localStorage },
    sessionStorage: { [info.origin]: info.sessionStorage },
  };
  return { session, path: await writeSession(session) };
}
