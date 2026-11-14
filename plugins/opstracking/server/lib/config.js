import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export class ConfigError extends Error {
    constructor(message) {
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
function unexpanded(value) {
    return /^\$\{[^}]*\}$/.test(value.trim());
}
function isLocalHost(hostname) {
    const h = hostname.toLowerCase();
    return h === "localhost" || h.endsWith(".localhost");
}
export function parseBaseUrl(raw) {
    const value = (raw ?? "").trim();
    if (value === "" || unexpanded(value)) {
        throw new ConfigError("The OpsTracking address is not set.");
    }
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new ConfigError(`OPSTRACKING_URL is not a valid URL. Use the OpsTracking address, e.g. https://neoeasel.com.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new ConfigError("OPSTRACKING_URL must start with https://.");
    }
    if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
        throw new ConfigError("OPSTRACKING_URL must use https://. Plain http is only allowed for localhost during development.");
    }
    if (url.username !== "" || url.password !== "") {
        throw new ConfigError("OPSTRACKING_URL must not contain a username or password.");
    }
    if (url.search !== "" || url.hash !== "") {
        throw new ConfigError("OPSTRACKING_URL must be just the address, without ?query or #fragment.");
    }
    if (url.pathname !== "/" && url.pathname !== "") {
        throw new ConfigError(`OPSTRACKING_URL must be the organization's address only (${url.origin}), without a path.`);
    }
    return url.origin;
}
export function parseToken(raw) {
    const value = (raw ?? "").trim();
    if (value === "" || unexpanded(value)) {
        throw new ConfigError("The OpsTracking API token is not set.");
    }
    if (!TOKEN_PATTERN.test(value)) {
        // Never echo the value back: a mistyped token is still mostly a token.
        throw new ConfigError("OPSTRACKING_TOKEN does not look like an OpsTracking API token (expected otk_…). Copy it again from Settings → Password & security → API tokens.");
    }
    return value;
}
/**
 * Where the settings are WRITTEN: `$OPSTRACKING_CONFIG` when set; else, for an
 * app that keeps its own connection, `~/.opstracking/<app>.json` (claude.json,
 * cursor.json) — so connecting Cursor never overwrites Claude's token on the
 * same machine; else the shared `~/.opstracking/config.json`.
 */
export function configFilePath(env = process.env, app) {
    const override = (env.OPSTRACKING_CONFIG ?? "").trim();
    if (override !== "" && !unexpanded(override))
        return override;
    return join(homedir(), ".opstracking", app ? `${app}.json` : "config.json");
}
/**
 * Where the settings are READ from: the app's own file once it exists, and
 * until then the shared `config.json` — the only file earlier versions wrote,
 * so an existing connection keeps working without reconnecting. The app's
 * first connect (or `setup --app`) then writes its own file.
 */
export function configReadPath(env = process.env, app) {
    const own = configFilePath(env, app);
    if (!app || existsSync(own))
        return own;
    return configFilePath(env);
}
/**
 * Reads the settings file. A missing file is simply no settings; a file that
 * is there but unreadable as JSON is an error worth saying, because the person
 * who wrote it expects it to be used.
 */
export function readConfigFile(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return {};
        throw new ConfigError(`Could not read ${path}. Run "opstracking-mcp setup" again.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new ConfigError(`${path} is not valid JSON. Run "opstracking-mcp setup" again.`);
    }
    if (typeof parsed !== "object" || parsed === null)
        return {};
    const out = {};
    for (const key of ["url", "token", "workspace"]) {
        const v = parsed[key];
        if (typeof v === "string")
            out[key] = v;
    }
    return out;
}
/**
 * Writes the settings file, readable by this user only (0600, in a 0700
 * folder) — the same place and permissions a CLI like `gh` keeps its token.
 */
export function saveConfigFile(path, cfg) {
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
export function savedAddress(env = process.env, file, app) {
    let fromFile = file;
    if (!fromFile) {
        try {
            fromFile = readConfigFile(configReadPath(env, app));
        }
        catch {
            fromFile = {};
        }
    }
    const raw = pick(env.OPSTRACKING_URL, fromFile.url);
    if (!raw)
        return undefined;
    try {
        return parseBaseUrl(raw);
    }
    catch {
        return undefined;
    }
}
/** The saved setting when there is one, else an environment value that was really given. */
function pick(fromEnv, fromFile) {
    const saved = (fromFile ?? "").trim();
    if (saved !== "")
        return saved;
    const v = (fromEnv ?? "").trim();
    return v !== "" && !unexpanded(v) ? v : undefined;
}
export function loadConfig(env = process.env, file = readConfigFile(configReadPath(env))) {
    const baseUrl = parseBaseUrl(pick(env.OPSTRACKING_URL, file.url));
    const token = parseToken(pick(env.OPSTRACKING_TOKEN, file.token));
    const ws = (pick(env.OPSTRACKING_WORKSPACE, file.workspace) ?? "").trim();
    const config = { baseUrl, token };
    if (ws !== "" && !unexpanded(ws))
        config.defaultWorkspace = ws;
    return config;
}
