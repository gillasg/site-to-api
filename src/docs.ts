import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName } from "./registry.js";
import { summarizeDocs, type DocsSummary } from "./runtime/docs.js";
import { siteApi } from "./runtime/site-api.js";

/** Finds a mapped site's published API documents and GraphQL schemas, saves them, and lists them. */
export async function readDocs(site: string): Promise<DocsSummary & { saved: string[] }> {
  const docs = await (await siteApi(site)).docs();
  const folder = join(siteDir(siteName(site)), "docs");
  await mkdir(folder, { recursive: true });
  const saved: string[] = [];
  const save = async (name: string, value: unknown) => {
    const path = join(folder, name);
    await writeFile(path, JSON.stringify(value, null, 2));
    saved.push(path);
  };
  for (const [index, item] of docs.openapi.entries())
    await save(`openapi-${index}.json`, item.document);
  for (const [index, item] of docs.graphql.entries())
    await save(`graphql-${index}.json`, { url: item.url, schema: item.schema });
  return { ...summarizeDocs(docs), saved };
}
