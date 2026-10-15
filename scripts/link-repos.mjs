// Sets up the sibling repos this one links to. Repos use each other through live links to
// folders next to them (../<repo>), not copies: this clones any that are missing, then installs
// and builds them in order. Run it once after cloning, and again after pulling changes there.
//
//   node scripts/link-repos.mjs                 the repos this one uses
//   node scripts/link-repos.mjs --also <repo>   plus another repo that uses this one (for CI)
//   node scripts/link-repos.mjs --revisions     print the revision of each linked repo
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "https://github.com/gillasg";
// The same table in every repo: what each repo links to, and the script that builds what the
// repos above it use (none when they use its source directly).
const REPOS = {
  "pi-ai-login": { links: [], build: "build" },
  "site-to-api": { links: ["pi-ai-login"], build: "build" },
  "browser-crawl": { links: ["site-to-api", "pi-ai-login"], build: "build" },
  "site-boosts": { links: [], build: undefined },
  "browser-use-extension": {
    links: ["pi-ai-login", "site-to-api", "browser-crawl", "site-boosts"],
    build: "build",
  },
  core: { links: ["browser-use-extension", "pi-ai-login"], build: "build:protocol" },
  "aeon-browser": { links: ["core", "browser-use-extension"], build: undefined },
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = dirname(root);
const args = process.argv.slice(2);
const self = valueOf("--repo") ?? basename(root);
if (!REPOS[self]) throw new Error(`Unknown repo ${self}: pass --repo <name>`);
const also = valueOf("--also")?.split(",") ?? [];

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const folder = (name) => (name === self ? root : join(parent, name));

/** Every repo the given ones need, each after the repos it links to. */
function order(names) {
  const out = [];
  const visit = (name) => {
    if (out.includes(name)) return;
    for (const link of REPOS[name].links) visit(link);
    out.push(name);
  };
  names.forEach(visit);
  return out;
}

function run(command, commandArgs, cwd) {
  process.stdout.write(`> ${command} ${commandArgs.join(" ")}  (${basename(cwd)})\n`);
  execFileSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function revision(name) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: folder(name),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

if (args.includes("--revisions")) {
  const revisions = Object.fromEntries(order([self]).map((name) => [name, revision(name)]));
  process.stdout.write(`${JSON.stringify(revisions, null, 2)}\n`);
} else {
  const ci = Boolean(process.env.CI);
  // This repo is set up by its own install; it only joins the list when an --also repo uses it.
  const needed = order([...REPOS[self].links, ...also]).filter(
    (name) => name !== self || also.length,
  );
  for (const name of needed) {
    const dir = folder(name);
    if (!existsSync(join(dir, "package.json")))
      run("git", ["clone", "--depth", "1", `${OWNER}/${name}.git`, dir], parent);
    run("pnpm", ["install", ...(ci ? ["--frozen-lockfile"] : [])], dir);
    if (REPOS[name].build) run("pnpm", ["run", REPOS[name].build], dir);
  }
}
