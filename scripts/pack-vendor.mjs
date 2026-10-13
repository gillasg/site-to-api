// Packs a tarball that other repos keep in their vendor/ folder:
//   node scripts/pack-vendor.mjs ../some-repo/vendor
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? "vendor-out");
mkdirSync(target, { recursive: true });
execSync("pnpm build", { stdio: "inherit" });
execSync(`pnpm pack --pack-destination "${target}"`, { stdio: "inherit" });
