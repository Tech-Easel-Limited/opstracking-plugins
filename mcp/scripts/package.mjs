#!/usr/bin/env node
/**
 * `pnpm package` — builds every release artifact from one set of sources.
 *
 *   plugins/opstracking/            the Claude plugin (committed): manifest, .mcp.json,
 *                                   skills/, commands/
 *   plugins/opstracking/server/     the server as readable files (built here, committed):
 *                                   lib/ compiled from mcp/src one module per file, and
 *                                   node_modules/ holding only the dependency files it loads,
 *                                   as their packages publish them — no bundle, so the plugin
 *                                   directory's security scan can read every file
 *
 * into mcp/release/ (git-ignored):
 *
 *   opstracking-mcp.mjs              the bare server, one self-contained file
 *   opstracking-plugins/             ONE marketplace folder that Claude Code and Cursor both install
 *                                    from: .claude-plugin/marketplace.json and .cursor-plugin/marketplace.json
 *                                    listing plugins/opstracking/, plus INSTALL.md and INSTALL-CURSOR.md
 *   opstracking-plugins.zip          that folder, zipped only to send it — unzip it before installing
 *   opstracking-plugin.zip           the plugin alone, files at the top — Upload plugin in the Claude desktop app
 *
 * The plugin in them is one folder with both apps' manifests. Claude reads
 * .claude-plugin/plugin.json, .mcp.json, commands/ and skills/ — the committed
 * sources, unchanged. Cursor reads .cursor-plugin/plugin.json FIRST (it only
 * falls back to the Claude manifest when there is none), and that manifest
 * points it at files generated for it: mcp.json with `${CURSOR_PLUGIN_ROOT}` and
 * no Claude `${user_config.…}` placeholders, and cursor/commands/ and
 * cursor/skills/ with the names Cursor shows (`/opstracking-setup` where Claude
 * shows `/opstracking:setup`). Neither app reads the other's files.
 *
 * Nothing outside mcp/release/ and plugins/opstracking/server/ is deleted or
 * written, apart from Cursor's generated files with --repo.
 *
 *   node scripts/package.mjs                 everything
 *   node scripts/package.mjs --server-only   just plugins/opstracking/server/ (`pnpm build:server`)
 *   node scripts/package.mjs --repo          the server plus Cursor's generated files, written into
 *                                            the repository itself (`pnpm build:repo`), because both
 *                                            marketplaces install straight from the Git repository
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const MCP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(MCP, "..");
const PLUGIN = join(ROOT, "plugins", "opstracking");
const SERVER = join(PLUGIN, "server");
const RELEASE = join(MCP, "release");
const STAGE = join(RELEASE, ".build");

function fail(message) {
  process.stderr.write(`package: ${message}\n`);
  process.exit(1);
}

/** Only ever delete inside `root`. */
function removeInside(root, path) {
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    fail(`refusing to delete ${target}: it is not inside ${root}`);
  }
  rmSync(target, { recursive: true, force: true });
}

const removeInRelease = (path) => removeInside(RELEASE, path);

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** No shipped file may be larger than this: past it a scanner stops reading. */
const MAX_FILE_BYTES = 256 * 1024;

const SERVER_ENTRY = `#!/usr/bin/env node
// The OpsTracking MCP server. Its code is in lib/, compiled from mcp/src one
// module per file; node_modules/ holds the dependency files it loads.
import "./lib/index.js";
`;

/**
 * The server inside the plugin, every file readable:
 *
 *   server/opstracking-mcp.mjs   the entry .mcp.json and mcp.json start
 *   server/package.json          marks lib/ as ES modules
 *   server/lib/                  mcp/src compiled by tsc, one file per module
 *   server/node_modules/         the dependency files the server loads, copied as published
 *
 * esbuild walks the import graph from src/index.ts the way Node resolves it
 * (same conditions, require() included), and every node_modules file it
 * reaches is copied with its package's package.json and licence. Nothing is
 * bundled, minified or rewritten.
 */
async function buildServer() {
  removeInside(SERVER, SERVER);
  mkdirSync(SERVER, { recursive: true });

  const lib = join(SERVER, "lib");
  const tsc = spawnSync(
    join(MCP, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.build.json", "--outDir", lib, "--declaration", "false"],
    { cwd: MCP, stdio: "inherit" },
  );
  if (tsc.error) fail(`could not run tsc (${tsc.error.message}). Run pnpm install first.`);
  if (tsc.status !== 0) fail(`tsc exited with ${tsc.status}.`);

  const { metafile } = await build({
    entryPoints: [join(MCP, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    write: false,
    metafile: true,
    absWorkingDir: MCP,
    outfile: join(STAGE, "graph.mjs"),
    logLevel: "warning",
  });

  const packages = new Map(); // name -> its folder in mcp/node_modules/.pnpm
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/\.pnpm\/[^/]+\/node_modules\/)((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(input);
    if (!match) continue;
    const [, store, name, file] = match;
    const from = resolve(MCP, store, name);
    const seen = packages.get(name);
    if (seen && seen !== from) fail(`two versions of ${name} are loaded; node_modules/ can hold only one.`);
    packages.set(name, from);
    cpSync(join(from, file), join(SERVER, "node_modules", name, file));
  }
  for (const [name, from] of packages) {
    for (const entry of readdirSync(from)) {
      if (entry === "package.json" || /^(licen[cs]e|notice)/i.test(entry)) {
        cpSync(join(from, entry), join(SERVER, "node_modules", name, entry));
      }
    }
  }

  writeFileSync(join(SERVER, "opstracking-mcp.mjs"), SERVER_ENTRY, { mode: 0o755 });
  writeJson(join(SERVER, "package.json"), { private: true, type: "module" });

  const oversized = listFiles(SERVER).filter((file) => statSync(file).size > MAX_FILE_BYTES);
  if (oversized.length) {
    fail(`files over ${MAX_FILE_BYTES / 1024} KB in server/: ${oversized.map((f) => relative(SERVER, f)).join(", ")}`);
  }
  return packages.size;
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** The bare server as one file, for people who run it outside a plugin (INSTALL.md). */
async function bundle(outfile) {
  await build({
    entryPoints: [join(MCP, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile,
    // Some dependencies still call require(); give the ESM bundle one.
    banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
    logLevel: "warning",
  });
}

// ---------------------------------------------------------------------------
// Zips — the system `zip`, with an argument vector (never a shell string)
// ---------------------------------------------------------------------------

function zip(out, cwd, entries) {
  const res = spawnSync("zip", ["-qr", out, ...entries, "-x", "*.DS_Store"], { cwd, stdio: "inherit" });
  if (res.error) fail(`could not run zip (${res.error.message}). Install zip and try again.`);
  if (res.status !== 0) fail(`zip exited with ${res.status} while writing ${basename(out)}.`);
}

// ---------------------------------------------------------------------------
// The Cursor plugin, generated from the Claude one
// ---------------------------------------------------------------------------

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** Claude namespaces a plugin's commands (`/opstracking:setup`); Cursor lists them by name. */
const cursorCommandName = (name) => `opstracking-${name}`;
const forCursor = (text) => text.replace(/\/opstracking:([a-z][a-z0-9-]*)/g, (_, name) => `/${cursorCommandName(name)}`);

/** The Cursor manifest: the Claude manifest's identity, worded for Cursor, without Claude's `userConfig`. */
function cursorManifest(claude) {
  const description = claude.description.replace(/\bfrom Claude Code\b/, "from Cursor");
  if (/Claude/.test(description)) {
    fail(`plugin.json's description names Claude in a way this script cannot reword for Cursor: "${claude.description}"`);
  }
  const manifest = {
    name: claude.name,
    displayName: claude.displayName,
    version: claude.version,
    description,
    author: claude.author,
    homepage: claude.homepage,
    repository: claude.repository,
    license: claude.license,
    // Cursor asks for a square logo on a background plate; the Claude icon is the bare mark.
    logo: "./assets/logo-plate.svg",
    keywords: claude.keywords,
  };
  return Object.fromEntries(Object.entries(manifest).filter(([, v]) => v !== undefined));
}

/**
 * A command file for Cursor: named `opstracking-<name>` so it cannot collide
 * with another plugin's `/setup`; `name` and `description` in the front
 * matter (Claude's `argument-hint` has no Cursor counterpart). `$ARGUMENTS`
 * stays, with a line for the case where Cursor leaves it unfilled.
 */
function cursorCommand(source, name) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) fail(`commands/${name}.md has no front matter.`);
  const [, front, body] = match;
  const kept = front
    .split("\n")
    .filter((line) => !/^argument-hint:/.test(line) && !/^name:/.test(line));
  let out = `---\nname: ${cursorCommandName(name)}\n${kept.join("\n")}\n---\n${forCursor(body)}`;
  if (body.includes("$ARGUMENTS")) {
    out = `${out.trimEnd()}\n\nIf nothing was filled in above, use what the user typed after the command in the chat.\n`;
  }
  return out;
}

/** Copies a folder, passing every Markdown file through `transform`. */
function copyTree(from, to, transform) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry === ".DS_Store") continue;
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) copyTree(src, dst, transform);
    else if (entry.endsWith(".md")) writeFileSync(dst, transform(readFileSync(src, "utf8")));
    else cpSync(src, dst);
  }
}

/** Cursor's own files, beside the Claude plugin already copied into `dir`. */
function addCursorFiles(dir) {
  const claude = readJson(join(PLUGIN, ".claude-plugin", "plugin.json"));
  // Explicit paths: with them Cursor reads only these, not the Claude
  // commands/ and skills/ it would otherwise discover by default.
  writeJson(join(dir, ".cursor-plugin", "plugin.json"), {
    ...cursorManifest(claude),
    commands: "./cursor/commands/",
    skills: "./cursor/skills/",
    mcpServers: "./mcp.json",
  });
  // No env block: the connection is made in the browser (the `connect` tool),
  // and Cursor has no settings prompt to fill Claude's user_config from.
  writeJson(join(dir, "mcp.json"), {
    mcpServers: {
      opstracking: { command: "node", args: ["${CURSOR_PLUGIN_ROOT}/server/opstracking-mcp.mjs"] },
    },
  });
  copyTree(join(PLUGIN, "skills"), join(dir, "cursor", "skills"), forCursor);
  mkdirSync(join(dir, "cursor", "commands"), { recursive: true });
  for (const file of readdirSync(join(PLUGIN, "commands")).filter((f) => f.endsWith(".md"))) {
    const name = file.replace(/\.md$/, "");
    const text = cursorCommand(readFileSync(join(PLUGIN, "commands", file), "utf8"), name);
    writeFileSync(join(dir, "cursor", "commands", `${cursorCommandName(name)}.md`), text);
  }
}

/** The plugin both apps install: the committed Claude plugin plus Cursor's files. */
function stagePlugin(dir) {
  cpSync(PLUGIN, dir, { recursive: true, filter: (src) => basename(src) !== ".DS_Store" });
  addCursorFiles(dir);
}

/** Cursor's marketplace file at `root`, listing the one plugin with its Cursor manifest's identity. */
function writeCursorMarketplace(root, claudeMarket, manifest) {
  writeJson(join(root, ".cursor-plugin", "marketplace.json"), {
    name: claudeMarket.name,
    owner: claudeMarket.owner,
    metadata: { description: "Cursor plugins for OpsTracking." },
    plugins: [
      {
        name: manifest.name,
        source: "./plugins/opstracking",
        description: manifest.description,
        version: manifest.version,
        author: manifest.author,
      },
    ],
  });
}

/**
 * The marketplace folder both apps add: each app's marketplace file at the
 * top, both listing the one plugin at `plugins/opstracking/`, and both install
 * guides. Claude Code takes it with `/plugin marketplace add <folder>`; Cursor
 * with Settings → Plugins → add plugins from a folder, which looks for
 * .cursor-plugin/marketplace.json first. A marketplace rather than a bare
 * plugin, because that is what Cursor's folder import accepts — pointed at a
 * plugin folder it refuses with "No marketplace manifest found".
 */
function stageMarketplace(root) {
  const claudeMarket = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
  const pluginDir = join(root, "plugins", "opstracking");
  stagePlugin(pluginDir);
  writeJson(join(root, ".claude-plugin", "marketplace.json"), claudeMarket);
  writeCursorMarketplace(root, claudeMarket, readJson(join(pluginDir, ".cursor-plugin", "plugin.json")));
  cpSync(join(MCP, "INSTALL.md"), join(root, "INSTALL.md"));
  cpSync(join(MCP, "INSTALL-CURSOR.md"), join(root, "INSTALL-CURSOR.md"));
}

// ---------------------------------------------------------------------------

async function main() {
  const count = await buildServer();
  if (process.argv.includes("--server-only")) {
    process.stdout.write(`Wrote ${relative(ROOT, SERVER)}/ with ${count} dependency packages\n`);
    return;
  }
  if (process.argv.includes("--repo")) {
    // Regenerated from scratch so a removed command or skill does not linger.
    rmSync(join(PLUGIN, "cursor"), { recursive: true, force: true });
    addCursorFiles(PLUGIN);
    writeCursorMarketplace(ROOT, readJson(join(ROOT, ".claude-plugin", "marketplace.json")), readJson(join(PLUGIN, ".cursor-plugin", "plugin.json")));
    process.stdout.write("Wrote the server and Cursor's files into plugins/opstracking/ and .cursor-plugin/\n");
    return;
  }
  for (const needed of [join(MCP, "INSTALL.md"), join(MCP, "INSTALL-CURSOR.md"), join(ROOT, ".claude-plugin", "marketplace.json")]) {
    if (!existsSync(needed)) fail(`${relative(ROOT, needed)} is missing.`);
  }

  removeInRelease(RELEASE);
  mkdirSync(RELEASE, { recursive: true });

  await bundle(join(RELEASE, "opstracking-mcp.mjs"));

  // Claude Code and Cursor: one marketplace folder, kept unzipped as well as
  // zipped, because neither app installs from a zip — both add a folder.
  const folder = join(RELEASE, "opstracking-plugins");
  stageMarketplace(folder);
  zip(join(RELEASE, "opstracking-plugins.zip"), RELEASE, ["opstracking-plugins"]);

  // Claude desktop app: Upload plugin takes a zip with one plugin in it.
  const single = join(STAGE, "plugin");
  stagePlugin(single);
  zip(join(RELEASE, "opstracking-plugin.zip"), single, ["."]);
  removeInRelease(STAGE);

  process.stdout.write(
    [
      "mcp/release/:",
      "  opstracking-plugins/         the marketplace folder Claude Code and Cursor both add (INSTALL.md, INSTALL-CURSOR.md inside)",
      "  opstracking-plugins.zip      that folder zipped, to send — unzip before installing",
      "  opstracking-plugin.zip       the plugin alone, for Upload plugin in the Claude desktop app",
      "  opstracking-mcp.mjs          the bare server",
      "",
    ].join("\n"),
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
