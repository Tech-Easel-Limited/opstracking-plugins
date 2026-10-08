#!/usr/bin/env node
/**
 * `pnpm package` — builds every release artifact from one set of sources.
 *
 *   plugins/opstracking/            the Claude plugin (committed): manifest, .mcp.json,
 *                                   skills/, commands/
 *   plugins/opstracking/server/     the bundled server (built here, git-ignored)
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
 * Nothing outside mcp/release/ is deleted; the only file written outside it is
 * the bundle in plugins/opstracking/server/.
 *
 *   node scripts/package.mjs                 everything
 *   node scripts/package.mjs --bundle-only   just the bundle (`pnpm bundle`)
 *   node scripts/package.mjs --repo          the bundle plus Cursor's generated files, written into
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
const BUNDLE = join(PLUGIN, "server", "opstracking-mcp.mjs");
const RELEASE = join(MCP, "release");
const STAGE = join(RELEASE, ".build");

function fail(message) {
  process.stderr.write(`package: ${message}\n`);
  process.exit(1);
}

/** Only ever delete inside mcp/release/. */
function removeInRelease(path) {
  const target = resolve(path);
  if (target !== RELEASE && !target.startsWith(`${RELEASE}${sep}`)) {
    fail(`refusing to delete ${target}: it is not inside ${RELEASE}`);
  }
  rmSync(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

async function bundle() {
  await build({
    entryPoints: [join(MCP, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: BUNDLE,
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
    logo: claude.icon,
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
  await bundle();
  if (process.argv.includes("--bundle-only")) {
    process.stdout.write(`Bundled ${relative(ROOT, BUNDLE)}\n`);
    return;
  }
  if (process.argv.includes("--repo")) {
    // Regenerated from scratch so a removed command or skill does not linger.
    rmSync(join(PLUGIN, "cursor"), { recursive: true, force: true });
    addCursorFiles(PLUGIN);
    writeCursorMarketplace(ROOT, readJson(join(ROOT, ".claude-plugin", "marketplace.json")), readJson(join(PLUGIN, ".cursor-plugin", "plugin.json")));
    process.stdout.write("Wrote the bundle and Cursor's files into plugins/opstracking/ and .cursor-plugin/\n");
    return;
  }
  for (const needed of [join(MCP, "INSTALL.md"), join(MCP, "INSTALL-CURSOR.md"), join(ROOT, ".claude-plugin", "marketplace.json")]) {
    if (!existsSync(needed)) fail(`${relative(ROOT, needed)} is missing.`);
  }

  removeInRelease(RELEASE);
  mkdirSync(RELEASE, { recursive: true });

  cpSync(BUNDLE, join(RELEASE, "opstracking-mcp.mjs"));

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
