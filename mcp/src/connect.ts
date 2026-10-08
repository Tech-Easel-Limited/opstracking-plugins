import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { appNoun, GENERIC_APP, type AppLabel } from "./app.js";
import type { FetchLike } from "./client.js";
import {
  ConfigError,
  configFilePath,
  parseBaseUrl,
  parseToken,
  readConfigFile,
  saveConfigFile,
  type FileConfig,
} from "./config.js";
import { redact } from "./redact.js";

/**
 * Connecting from the browser — the `gh auth login --web` shape.
 *
 * The `connect` tool starts a one-shot HTTP listener on 127.0.0.1 and opens
 * `<address>/connect/ai?callback=http://127.0.0.1:<port>/callback&state=…&client=<machine>&app=<app>`
 * (`/connect/claude`, the first path, serves the same page for plugins built
 * before it). The person signs in there as usual, ticks what the connection
 * may change (none ticked is read only), and confirms with their password; the page mints a personal API token and sends the browser
 * to `http://127.0.0.1:<port>/callback#state=…&token=…&url=…`.
 *
 * The token rides in the FRAGMENT, which a browser never sends in a request:
 * no server log, proxy or Referer ever holds it. The page served at /callback
 * reads the fragment, strips it from the address bar, and POSTs it to this
 * listener on the same loopback origin. The token is proved against
 * GET /api/auth/me before anything is kept; then it is written to the settings
 * file and handed to the running server, so the tools work without a restart.
 *
 * The token never passes through the chat, the model, or any host but the
 * person's own OpsTracking and their own machine.
 */

/** How long a started connection waits for the browser. */
export const CONNECT_TIMEOUT_MS = 10 * 60_000;
/** Refused posts before the listener gives up — a guessing loop ends here. */
export const MAX_FAILED_POSTS = 5;
const MAX_BODY_BYTES = 16 * 1024;
const VERIFY_TIMEOUT_MS = 15_000;

/** What the model asks when it has no address — the user's own words decide it. */
export const ASK_ADDRESS =
  "What's your OpsTracking address? (your organization's link, e.g. https://amento-tech.neoeasel.com — or http://localhost:3000 for a local copy)";

// ---------------------------------------------------------------------------
// Opening the browser
// ---------------------------------------------------------------------------

/**
 * The program and arguments that open `url` in the default browser.
 *
 * Always an argument vector, never a shell string: the URL carries `&` between
 * its parameters, which a shell reads as "run another command". That is also
 * why Windows does not use `cmd /c start` — `start` is a cmd builtin, so the
 * URL would be parsed by cmd — but `rundll32 url.dll,FileProtocolHandler`,
 * which takes the URL as a single argument and hands it to the default browser.
 */
export function openCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (!/^https?:\/\//.test(url)) throw new Error("Only http(s) addresses are opened.");
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/** Opens a URL; resolves whether the opener could be started at all. */
export type Opener = (url: string) => Promise<boolean>;

export const defaultOpener: Opener = (url) =>
  new Promise((resolve) => {
    let cmd: { command: string; args: string[] };
    try {
      cmd = openCommand(process.platform, url);
    } catch {
      resolve(false);
      return;
    }
    const child = spawn(cmd.command, cmd.args, { stdio: "ignore", detached: true, shell: false });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });

/**
 * A short, harmless name for this machine, for the token's name ("Cursor on
 * wali-mbp"). The page sanitizes it again; this keeps it tidy at the source.
 */
export function clientLabel(host: string = hostname()): string {
  const label = host
    .replace(/\.(local|lan|home|localdomain)$/i, "")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .trim()
    .slice(0, 40);
  return label || "this computer";
}

// ---------------------------------------------------------------------------
// Proving a token
// ---------------------------------------------------------------------------

/** "wali in Amento Tech" — who a token belongs to, from GET /api/auth/me. */
export async function whoAmI(baseUrl: string, token: string, fetchImpl: FetchLike = (i, o) => fetch(i, o)): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), VERIFY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "opstracking-mcp" },
      signal: abort.signal,
    });
  } catch {
    throw new ConfigError(`Could not reach OpsTracking at ${baseUrl}.`);
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as {
    user?: { username?: string };
    currentOrg?: { name?: string } | null;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new ConfigError(redact(body.error?.message ?? `OpsTracking answered ${res.status}.`, token));
  }
  const who = body.user?.username ?? "you";
  const org = body.currentOrg?.name;
  return org ? `${who} in ${org}` : who;
}

// ---------------------------------------------------------------------------
// The loopback listener
// ---------------------------------------------------------------------------

export type ConnectOutcome = "connected" | "cancelled" | "timeout" | "failed" | "replaced" | "closed";

export type ConnectOptions = {
  /** The OpsTracking origin to open, already validated by `parseBaseUrl`. */
  address: string;
  /** Where the settings are written; defaults to `configFilePath()`. */
  configPath?: string;
  /**
   * Where the current settings are read from, to carry the default workspace
   * over — the shared file until this app has its own; defaults to `configPath`.
   */
  readConfigPath?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Called once the token is proved and saved, with the address it was proved on. */
  onConnected: (saved: { url: string; token: string }) => void;
  /** Machine label for the token name; defaults to `clientLabel()`. */
  client?: string;
  /** The app asking — named on the page and in the token; a generic assistant when unknown. */
  app?: AppLabel;
};

type PostBody = { state?: unknown; token?: unknown; url?: unknown; error?: unknown };

/** Equal-time comparison of two strings of any length. */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1" || address === "::1";
}

/**
 * One pending browser connection. Start it with `PendingConnect.start`; it
 * closes itself after a success, a cancel, `MAX_FAILED_POSTS` refusals or the
 * timeout, and `close()` ends it early (a newer `connect` replaces it).
 */
export class PendingConnect {
  readonly state: string;
  readonly address: string;
  readonly authorizeUrl: string;
  readonly port: number;
  /** Settles with how the connection ended. */
  readonly done: Promise<ConnectOutcome>;

  private readonly server: Server;
  private readonly opts: ConnectOptions;
  private failures = 0;
  private busy = false;
  private finished = false;
  private timer?: NodeJS.Timeout;
  private settle!: (o: ConnectOutcome) => void;

  private constructor(server: Server, port: number, opts: ConnectOptions) {
    this.server = server;
    this.port = port;
    this.opts = opts;
    this.address = opts.address;
    this.state = randomBytes(32).toString("base64url");
    const callback = `http://127.0.0.1:${port}/callback`;
    const q = new URLSearchParams({
      callback,
      state: this.state,
      client: opts.client ?? clientLabel(),
      app: opts.app ?? GENERIC_APP,
    });
    this.authorizeUrl = `${opts.address}/connect/ai?${q.toString()}`;
    this.done = new Promise((resolve) => (this.settle = resolve));
  }

  static async start(opts: ConnectOptions): Promise<PendingConnect> {
    const address = parseBaseUrl(opts.address);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    // Never the reason the process stays alive: when the app closes stdin, a
    // pending connection goes with it.
    server.unref();
    const port = (server.address() as AddressInfo).port;
    const pending = new PendingConnect(server, port, { ...opts, address });
    server.on("request", (req, res) => void pending.handle(req, res));
    pending.timer = setTimeout(() => pending.close("timeout"), opts.timeoutMs ?? CONNECT_TIMEOUT_MS);
    pending.timer.unref();
    return pending;
  }

  get open(): boolean {
    return !this.finished;
  }

  close(outcome: ConnectOutcome = "closed"): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.server.close();
    this.server.closeAllConnections();
    this.settle(outcome);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on some other name that resolves to 127.0.0.1
    // arrives with its own Host. Only the exact loopback address is served.
    if (req.headers.host !== `127.0.0.1:${this.port}`) return plain(res, 421, "Misdirected request.");
    if (!isLoopback(req.socket.remoteAddress)) return plain(res, 403, "Forbidden.");
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/callback") return plain(res, 404, "Not found.");
    if (req.method === "GET") return page(res, this.opts.app);
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return plain(res, 405, "Method not allowed.");
    }
    return this.receive(req, res);
  }

  private async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only this listener's own page may post. A cross-origin page cannot send
    // JSON here without a CORS preflight this server never approves, and one
    // that tries anyway is named by its Origin.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${this.port}`) {
      return json(res, 403, { ok: false, message: "This page can't approve the connection." });
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      return json(res, 415, { ok: false, message: "Unexpected request." });
    }
    const app = appNoun(this.opts.app);
    if (this.finished) return json(res, 410, { ok: false, message: `This connection has already finished. Ask ${app} to connect again.` });
    if (this.busy) return json(res, 409, { ok: false, message: "Already connecting — one moment." });

    let body: PostBody;
    try {
      body = JSON.parse(await readBody(req)) as PostBody;
      if (typeof body !== "object" || body === null) throw new Error("not an object");
    } catch {
      return this.refuse(res, 400, "Unexpected request.");
    }

    const state = typeof body.state === "string" ? body.state : "";
    if (!sameSecret(state, this.state)) {
      return this.refuse(res, 400, `This approval doesn't match the connection ${app} started. Ask ${app} to connect again.`);
    }

    if (body.error === "cancelled") {
      json(res, 200, { ok: false, cancelled: true, message: "Connection cancelled. You can close this tab." }, () =>
        this.close("cancelled"),
      );
      return;
    }

    this.busy = true;
    try {
      const token = parseToken(typeof body.token === "string" ? body.token : "");
      // The address that was opened is preferred: it is the one the user gave.
      // The page's own suggestion is tried only when that one refuses — e.g.
      // they chose another organization on the way through.
      const candidates = [this.address];
      if (typeof body.url === "string" && body.url.trim() !== "") {
        const suggested = parseBaseUrl(body.url);
        if (suggested !== this.address) candidates.push(suggested);
      }
      let who: string | undefined;
      let used = this.address;
      let lastErr: unknown;
      for (const candidate of candidates) {
        try {
          who = await whoAmI(candidate, token, this.opts.fetch);
          used = candidate;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (who === undefined) throw lastErr ?? new ConfigError("OpsTracking did not accept the token.");

      const path = this.opts.configPath ?? configFilePath();
      let existing: FileConfig = {};
      try {
        existing = readConfigFile(this.opts.readConfigPath ?? path);
      } catch {
        existing = {};
      }
      // A default workspace is a name in one organization; it only carries
      // over while the address does.
      const workspace = existing.url === used ? existing.workspace : undefined;
      saveConfigFile(path, { url: used, token, ...(workspace ? { workspace } : {}) });
      this.opts.onConnected({ url: used, token });

      json(res, 200, { ok: true, message: `Connected as ${who} — you can close this tab and return to ${app}.` }, () =>
        this.close("connected"),
      );
    } catch (err) {
      const reason = err instanceof ConfigError ? err.message : "Something went wrong.";
      const token = typeof body.token === "string" ? body.token : undefined;
      this.refuse(res, 400, redact(`Not connected: ${reason} Nothing was saved. Ask ${app} to connect again.`, token));
    } finally {
      this.busy = false;
    }
  }

  private refuse(res: ServerResponse, status: number, message: string): void {
    this.failures++;
    const last = this.failures >= MAX_FAILED_POSTS;
    json(res, status, { ok: false, message }, () => {
      if (last) this.close("failed");
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const COMMON_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...COMMON_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>, after?: () => void): void {
  res.writeHead(status, { ...COMMON_HEADERS, "Content-Type": "application/json; charset=utf-8", Connection: "close" });
  res.end(JSON.stringify(body), after);
}

/**
 * The page the browser lands on. Self-contained — no external resource, a CSP
 * that allows only its own nonce'd script and style and requests to itself.
 * It strips the fragment before doing anything else, so the token does not
 * sit in the address bar or survive into history.
 */
function page(res: ServerResponse, app: AppLabel | undefined): void {
  const nonce = randomBytes(16).toString("base64");
  // One of three fixed labels (src/app.ts); escaped anyway, for the HTML and the script.
  const noun = appNoun(app);
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = app && app !== GENERIC_APP ? `OpsTracking for ${app}` : "OpsTracking";
  const gone = JSON.stringify(
    `${noun.charAt(0).toUpperCase()}${noun.slice(1)} isn't listening any more — the link may have expired. Ask ${noun} to connect again.`,
  ).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#1d2433;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;padding:32px;margin:16px;background:#fff;border:1px solid #e3e6eb;border-radius:12px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#4a5263}
.ok h1{color:#127a4b}.bad h1{color:#b42318}
</style></head>
<body><main id="box" role="status" aria-live="polite"><h1 id="title">Connecting ${esc(noun)}…</h1><p id="msg">One moment.</p></main>
<script nonce="${nonce}">
(function () {
  var box = document.getElementById("box");
  function show(title, msg, ok) {
    document.getElementById("title").textContent = title;
    document.getElementById("msg").textContent = msg;
    box.className = ok ? "ok" : "bad";
  }
  var hash = location.hash.replace(/^#/, "");
  history.replaceState(null, "", location.pathname);
  var p = new URLSearchParams(hash);
  var body = { state: p.get("state") || "", token: p.get("token") || "", url: p.get("url") || "", error: p.get("error") || "" };
  hash = ""; p = null;
  if (!body.state) { show("Nothing to do here", "You can close this tab.", false); return; }
  fetch("/callback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", credentials: "omit" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      body = null;
      if (d.ok) show("Connected", d.message, true);
      else show(d.cancelled ? "Cancelled" : "Not connected", d.message, !!d.cancelled);
    })
    .catch(function () { body = null; show("Not connected", ${gone}, false); });
})();
</script></body></html>`;
  res.writeHead(200, {
    ...COMMON_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.end(html);
}
