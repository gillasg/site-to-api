import { listSites, loadModel, siteName } from "./registry.js";
import type { Params } from "./runtime/request.js";
import { siteApi } from "./runtime/site-api.js";
import { watch } from "./watch.js";

// Requests from browser code (the `siteApi` global in the Browser Use Extension's runtime): a
// browser cell, or a watcher's check, can list mapped sites and call or watch their operations.

export interface SiteApiRequest {
  siteApi: "sites" | "operations" | "call" | "watch";
  site?: string;
  operation?: string;
  params?: Params;
  key?: string;
  items?: string;
  name?: string;
}

export function isSiteApiRequest(value: unknown): value is SiteApiRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { siteApi?: unknown }).siteApi === "string"
  );
}

function required(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) throw new Error(`siteApi: give the ${what}`);
  return value;
}

export async function handleSiteApiRequest(request: SiteApiRequest): Promise<unknown> {
  if (request.siteApi === "sites") return listSites();
  const site = siteName(required(request.site, "site"));
  if (request.siteApi === "operations") {
    const model = await loadModel(site);
    if (!model) throw new Error(`${site} is not mapped yet`);
    return model.operations.map((op) => ({
      id: op.id,
      what: op.summary,
      method: op.method,
      path: op.path,
      params: op.params.filter((p) => !p.constant && !p.generated).map((p) => p.name),
    }));
  }
  const operation = required(request.operation, "operation");
  if (request.siteApi === "watch")
    return watch(site, operation, request.params ?? {}, {
      ...(request.key ? { key: request.key } : {}),
      ...(request.items ? { items: request.items } : {}),
      ...(request.name ? { name: request.name } : {}),
    });
  if (request.siteApi === "call")
    return (await siteApi(site)).call(operation, request.params ?? {});
  throw new Error(`siteApi: unknown request ${String(request.siteApi)}`);
}
