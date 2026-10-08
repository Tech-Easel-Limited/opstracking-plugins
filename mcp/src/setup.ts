import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { appFromSlug, appSlug, type AppLabel } from "./app.js";
import {
  ConfigError,
  configFilePath,
  configReadPath,
  parseBaseUrl,
  parseToken,
  readConfigFile,
  saveConfigFile as saveConfig,
  type FileConfig,
} from "./config.js";
import { whoAmI } from "./connect.js";
import { redact } from "./redact.js";

/**
 * `opstracking-mcp setup` — the settings, asked for in a terminal.
 *
 * The fallback to the `connect` tool's browser approval (src/connect.ts), for
 * a machine where no browser can be opened. It asks for the address and the token, proves them against
 * GET /api/auth/me before keeping anything, and writes the settings file
 * readable by this user only (0600, in a 0700 folder) — the same place and
 * permissions a CLI like `gh` keeps its token.
 *
 * `--app claude|cursor` picks that app's own file (`~/.opstracking/claude.json`,
 * `cursor.json`); without it, the shared `config.json`, which an app reads
 * until it has a file of its own (src/config.ts).
 */

/** `otk_1a2b…wxyz` — enough to tell two tokens apart, never enough to use one. */
function maskToken(token: string | undefined): string {
  if (!token) return "(not set)";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/**
 * Takes `--app <name>` (or `--app=<name>`) out of the arguments. An app this
 * server does not know is an error rather than a silent fall back to the
 * shared file, which another app may be using.
 */
export function takeAppFlag(args: string[]): { app?: AppLabel; rest: string[] } {
  const rest: string[] = [];
  let app: AppLabel | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;
    if (arg === "--app") value = args[++i] ?? "";
    else if (arg.startsWith("--app=")) value = arg.slice("--app=".length);
    else {
      rest.push(arg);
      continue;
    }
    app = appFromSlug(value);
    if (!app) throw new ConfigError(`Unknown app "${value}". Use --app claude or --app cursor.`);
  }
  return { app, rest };
}

/** What to restart so the plugin reads a changed file. */
function restartHint(app: AppLabel | undefined): string {
  if (app === "Claude") return "Restart Claude (or run /reload-plugins)";
  if (app === "Cursor") return "Restart Cursor (or reload its window)";
  return "Restart your AI assistant";
}

/** readline has no hidden-input mode; muting its echo is the usual way. */
type Echo = Interface & { _writeToOutput?: (s: string) => void };

async function askHidden(rl: Interface, question: string): Promise<string> {
  const echo = rl as Echo;
  const original = echo._writeToOutput;
  let asked = false;
  echo._writeToOutput = (s: string) => {
    // Let the question itself through once, then echo nothing typed.
    if (!asked) {
      asked = true;
      stdout.write(s);
    }
  };
  try {
    return (await rl.question(question)).trim();
  } finally {
    echo._writeToOutput = original;
    stdout.write("\n");
  }
}

export async function runSetup(args: string[] = []): Promise<void> {
  let app: AppLabel | undefined;
  try {
    ({ app } = takeAppFlag(args));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const slug = appSlug(app);
  const path = configFilePath(process.env, slug);
  const existing = (() => {
    try {
      return readConfigFile(configReadPath(process.env, slug));
    } catch {
      return {};
    }
  })();
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    stdout.write(app ? `OpsTracking for ${app} — setup\n\n` : "OpsTracking — setup\n\n");
    // No built-in default: the address is your organization's own link.
    const urlAnswer = (
      await rl.question(
        existing.url
          ? `OpsTracking address [${existing.url}]: `
          : "OpsTracking address (your organization's link, e.g. https://amento-tech.neoeasel.com): ",
      )
    ).trim();
    const baseUrl = parseBaseUrl(urlAnswer || existing.url);

    const tokenAnswer = await askHidden(
      rl,
      existing.token ? "API token (Enter keeps the current one): " : "API token (otk_…, hidden while you type): ",
    );
    const token = parseToken(tokenAnswer || existing.token);

    const wsAnswer = (
      await rl.question(`Default workspace, optional [${existing.workspace || "none"}]: `)
    ).trim();
    const workspace = wsAnswer || existing.workspace || "";

    stdout.write("\nChecking with OpsTracking… ");
    const who = await whoAmI(baseUrl, token);
    stdout.write(`connected as ${who}.\n`);

    saveConfig(path, { url: baseUrl, token, ...(workspace ? { workspace } : {}) });

    stdout.write(`\nSaved to ${path} (readable only by you).\n`);
    stdout.write(`${restartHint(app)} so the OpsTracking plugin picks it up.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nNot saved: ${redact(message)}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

const KEYS = ["url", "token", "workspace"] as const;
type Key = (typeof KEYS)[number];

const USAGE = `Usage:
  opstracking-mcp setup [--app claude|cursor]      ask for every setting (Enter keeps the current value)
  opstracking-mcp config [--app claude|cursor]     show the saved settings (token masked)
  opstracking-mcp config set url <address>
  opstracking-mcp config set token      asks for the token, hidden — never type it on the command line
  opstracking-mcp config set workspace <name>
  opstracking-mcp config unset <url|token|workspace>

With --app, the settings are that app's own: ~/.opstracking/claude.json or
cursor.json. Without it, the shared ~/.opstracking/config.json, which an app
reads until it has a file of its own. OPSTRACKING_CONFIG overrides the path.
Saved settings override whatever the plugin passes. Restart the app (in Claude
Code, /reload-plugins) after a change.
`;

/**
 * `opstracking-mcp config …` — see or change one saved setting at a time.
 * Every change is checked before it is written; a change to the address or
 * the token is also proved against OpsTracking when both are known.
 */
export async function runConfig(argv: string[]): Promise<void> {
  try {
    const { app, rest: args } = takeAppFlag(argv);
    const slug = appSlug(app);
    const path = configFilePath(process.env, slug);
    const readPath = configReadPath(process.env, slug);
    const current = readConfigFile(readPath);
    const [action, rawKey, ...rest] = args;

    if (!action) {
      stdout.write(`${readPath}\n`);
      stdout.write(`  url        ${current.url ?? "(not set)"}\n`);
      stdout.write(`  token      ${maskToken(current.token)}\n`);
      stdout.write(`  workspace  ${current.workspace || "(not set)"}\n`);
      return;
    }
    if ((action !== "set" && action !== "unset") || !KEYS.includes(rawKey as Key)) {
      stdout.write(USAGE);
      process.exitCode = action === "help" || action === "--help" ? 0 : 1;
      return;
    }
    const key = rawKey as Key;
    const next: FileConfig = { ...current };

    if (action === "unset") {
      delete next[key];
      saveConfig(path, next);
      stdout.write(`Removed ${key} from ${path}.\n`);
      return;
    }

    let value = rest.join(" ").trim();
    if (key === "token") {
      if (value) {
        throw new ConfigError(
          "Don't put the token on the command line — it would stay in your shell history. Run \"opstracking-mcp config set token\" and paste it when asked.",
        );
      }
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        value = await askHidden(rl, "API token (otk_…, hidden while you type): ");
      } finally {
        rl.close();
      }
    }
    if (!value) throw new ConfigError(`Give a value: opstracking-mcp config set ${key} <value>`);

    if (key === "url") next.url = parseBaseUrl(value);
    else if (key === "token") next.token = parseToken(value);
    else next.workspace = value;

    if ((key === "url" || key === "token") && next.url && next.token) {
      stdout.write("Checking with OpsTracking… ");
      stdout.write(`connected as ${await whoAmI(next.url, next.token)}.\n`);
    }
    saveConfig(path, next);
    stdout.write(`Saved ${key} to ${path}. ${restartHint(app)} to use it.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Not saved: ${redact(message)}\n`);
    process.exitCode = 1;
  }
}

export function printUsage(): void {
  stdout.write(USAGE);
}
