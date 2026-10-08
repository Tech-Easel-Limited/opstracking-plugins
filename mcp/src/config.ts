import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppSlug } from "./app.js";

/**
 * Configuration — from the environment, and failing that from a file on this
 * machine (`~/.opstracking/<app>.json`, or the shared `config.json`, written by the `connect` tool's
 * browser approval or by `opstracking-mcp setup`). The file exists because not every Claude app shows
 * a plugin's settings prompt: the variables then arrive unset (or as their
 * literal `${user_config.…}` placeholders). The file OVERRIDES the
 * environment: it is what somebody set deliberately on this machine, most
 * recently, with `setup` or `config set` — so what they set is what is used.
 *
 *   OPSTRACKING_URL        required — the organization's own origin, e.g.
 *                          https://acme.neoeasel.com. http is allowed only for
 *                          localhost and *.localhost (local development).
 *   OPSTRACKING_TOKEN      required — a personal API token, `otk_<32 hex>_<43 base64url>`.
 *   OPSTRACKING_WORKSPACE  optional — the default workspace, by uuid or exact
 *                          name. Without it the first workspace the token can
 *                          see is used.
 */

export type Config = {
  /** Origin only, no trailing slash: `https://acme.neoeasel.com`. */
  baseUrl: string;
  token: string;
  defaultWorkspace?: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The shape of a personal API token. Checked before the token is ever sent. */
export const TOKEN_PATTERN = /^otk_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;

/** Any substring that looks like a token — used for redaction, not validation. */
export const TOKEN_LIKE = /otk_[0-9a-f]{32}_[A-Za-z0-9_-]{43}/g;

/**
 * Claude Code leaves `${VAR}` in place when the variable is unset, so a
 * plugin installed without the variables exported arrives here as the literal
 * placeholder. Say that plainly rather than "invalid URL".
 */
function unexpanded(value: string): boolean {
  return /^\$\{[^}]*\}$/.test(value.trim());
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost");
}

export function parseBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "" || unexpanded(value)) {
    throw new ConfigError("The OpsTracking address is not set.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `OPSTRACKING_URL is not a valid URL. Use the OpsTracking address, e.g. https://neoeasel.com.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("OPSTRACKING_URL must start with https://.");
  }
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new ConfigError(
      "OPSTRACKING_URL must use https://. Plain http is only allowed for localhost during development.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("OPSTRACKING_URL must not contain a username or password.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("OPSTRACKING_URL must be just the address, without ?query or #fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError(
      `OPSTRACKING_URL must be the organization's address only (${url.origin}), without a path.`,
    );
  }
  return url.origin;
}

export function parseToken(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "" || unexpanded(value)) {
    throw new ConfigError("The OpsTracking API token is not set.");
  }
  if (!TOKEN_PATTERN.test(value)) {
    // Never echo the value back: a mistyped token is still mostly a token.
    throw new ConfigError(
      "OPSTRACKING_TOKEN does not look like an OpsTracking API token (expected otk_…). Copy it again from Settings → Password & security → API tokens.",
    );
  }
  return value;
}

/** What `~/.opstracking/config.json` may hold. */
export type FileConfig = { url?: string; token?: string; workspace?: string };

/**
 * Where the settings are WRITTEN: `$OPSTRACKING_CONFIG` when set; else, for an
 * app that keeps its own connection, `~/.opstracking/<app>.json` (claude.json,
 * cursor.json) — so connecting Cursor never overwrites Claude's token on the
 * same machine; else the shared `~/.opstracking/config.json`.
 */
export function configFilePath(env: NodeJS.ProcessEnv = process.env, app?: AppSlug): string {
  const override = (env.OPSTRACKING_CONFIG ?? "").trim();
  if (override !== "" && !unexpanded(override)) return override;
  return join(homedir(), ".opstracking", app ? `${app}.json` : "config.json");
}

/**
 * Where the settings are READ from: the app's own file once it exists, and
 * until then the shared `config.json` — the only file earlier versions wrote,
 * so an existing connection keeps working without reconnecting. The app's
 * first connect (or `setup --app`) then writes its own file.
 */
export function configReadPath(env: NodeJS.ProcessEnv = process.env, app?: AppSlug): string {
  const own = configFilePath(env, app);
  if (!app || existsSync(own)) return own;
  return configFilePath(env);
}

/**
 * Reads the settings file. A missing file is simply no settings; a file that
 * is there but unreadable as JSON is an error worth saying, because the person
 * who wrote it expects it to be used.
 */
export function readConfigFile(path: string): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`Could not read ${path}. Run "opstracking-mcp setup" again.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON. Run "opstracking-mcp setup" again.`);
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: FileConfig = {};
  for (const key of ["url", "token", "workspace"] as const) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * Writes the settings file, readable by this user only (0600, in a 0700
 * folder) — the same place and permissions a CLI like `gh` keeps its token.
 */
export function saveConfigFile(path: string, cfg: FileConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  // An existing file keeps its old mode on write; make sure it is ours alone.
  chmodSync(path, 0o600);
}

/**
 * The address to connect to when nobody named one: the saved setting, else an
 * address the environment (or the plugin's settings) really gave. Never a
 * built-in default — the address is the user's to say.
 */
export function savedAddress(
  env: NodeJS.ProcessEnv = process.env,
  file?: FileConfig,
  app?: AppSlug,
): string | undefined {
  let fromFile = file;
  if (!fromFile) {
    try {
      fromFile = readConfigFile(configReadPath(env, app));
    } catch {
      fromFile = {};
    }
  }
  const raw = pick(env.OPSTRACKING_URL, fromFile.url);
  if (!raw) return undefined;
  try {
    return parseBaseUrl(raw);
  } catch {
    return undefined;
  }
}

/** The saved setting when there is one, else an environment value that was really given. */
function pick(fromEnv: string | undefined, fromFile: string | undefined): string | undefined {
  const saved = (fromFile ?? "").trim();
  if (saved !== "") return saved;
  const v = (fromEnv ?? "").trim();
  return v !== "" && !unexpanded(v) ? v : undefined;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: FileConfig = readConfigFile(configReadPath(env)),
): Config {
  const baseUrl = parseBaseUrl(pick(env.OPSTRACKING_URL, file.url));
  const token = parseToken(pick(env.OPSTRACKING_TOKEN, file.token));
  const ws = (pick(env.OPSTRACKING_WORKSPACE, file.workspace) ?? "").trim();
  const config: Config = { baseUrl, token };
  if (ws !== "" && !unexpanded(ws)) config.defaultWorkspace = ws;
  return config;
}
