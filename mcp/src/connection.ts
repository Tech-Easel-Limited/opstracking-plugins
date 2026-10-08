import { appFromClientName, appSlug, type AppLabel, type AppSlug } from "./app.js";
import type { FetchLike } from "./client.js";
import {
  ConfigError,
  configFilePath,
  configReadPath,
  loadConfig,
  readConfigFile,
  savedAddress,
  type Config,
} from "./config.js";
import { ASK_ADDRESS, type PendingConnect } from "./connect.js";
import { Session } from "./session.js";
import type { Me } from "./types.js";

/**
 * Raised by a tool that needs OpsTracking while there is no usable token. Its
 * message is written for the model: what to ask the user, which tool to call,
 * and that a token is never asked for in the chat.
 */
export class NotConnectedError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "NotConnectedError";
  }
}

export function notConnectedMessage(reason: string | undefined, address: string | undefined): string {
  const why = reason ? ` (${reason.replace(/\.$/, "")})` : "";
  const never =
    "Never ask the user for an API token or accept one in the chat — the browser delivers it straight to this machine.";
  if (address) {
    return (
      `OpsTracking is not connected yet${why}. Call the \`connect\` tool — it reuses the saved address ${address} ` +
      "(pass `address` only if the user wants a different one) — and tell the user a browser window will open for " +
      `them to approve the connection. Once they have approved it, try the request again. ${never}`
    );
  }
  return (
    `OpsTracking is not connected yet${why}. Ask the user in the chat: "${ASK_ADDRESS}". Then call the \`connect\` ` +
    "tool with the address they give, and tell them a browser window will open for them to approve the connection. " +
    `Once they have approved it, try the request again. ${never}`
  );
}

export type ConnectionOptions = {
  /** A fixed config (tests); otherwise read from the environment and the settings file. */
  config?: Config;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  timeoutMs?: number;
  /**
   * The MCP client's self-reported name (`claude-code`, `cursor-vscode`, …) —
   * undefined until the client has initialized.
   */
  clientName?: () => string | undefined;
  /** Every fresh `/api/auth/me` answer, from whichever session asked. */
  onMe?: (me: Me) => void;
  /** A session was adopted: loaded from the settings, or delivered by `connect`. */
  onSession?: () => void;
};

/**
 * The server's live connection to OpsTracking.
 *
 * Tools ask for the session on every call rather than holding one, so the
 * `connect` flow can swap in a new token while the server runs. While there is
 * none, each call re-reads the configuration — a file written meanwhile (by
 * `connect` in another window of the same app, or `opstracking-mcp setup`) is
 * picked up without a restart.
 *
 * Which settings file is read depends on the app (src/app.ts), and the app is
 * only known after the MCP handshake: before it the shared `config.json` is
 * read, and the first call after it re-reads the app's own file.
 */
export class Connection {
  private session?: Session;
  private error?: ConfigError;
  private pending?: PendingConnect;
  /** The app whose settings the session came from — `null` before the first load. */
  private loadedFor: AppSlug | undefined | null = null;
  private readonly opts: ConnectionOptions;

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.load();
  }

  get env(): NodeJS.ProcessEnv {
    return this.opts.env;
  }

  get fetch(): FetchLike | undefined {
    return this.opts.fetch;
  }

  /** The app running this server, once the client has said; undefined before the handshake. */
  app(): AppLabel | undefined {
    const name = this.opts.clientName?.();
    return name === undefined ? undefined : appFromClientName(name);
  }

  private slug(): AppSlug | undefined {
    return appSlug(this.app());
  }

  /** Where `connect` writes this app's settings. */
  configPath(): string {
    return configFilePath(this.opts.env, this.slug());
  }

  /** Where this app's settings are read from: its own file, or the shared one until it has one. */
  readConfigPath(): string {
    return configReadPath(this.opts.env, this.slug());
  }

  /** Why the server is not connected, when it is not. */
  get configError(): ConfigError | undefined {
    return this.session ? undefined : this.error;
  }

  private load(): void {
    const slug = this.slug();
    this.loadedFor = slug;
    try {
      const config =
        this.opts.config ?? loadConfig(this.opts.env, readConfigFile(this.readConfigPath()));
      this.session = new Session(config, this.opts.fetch, this.opts.timeoutMs, this.opts.onMe);
      this.error = undefined;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      this.session = undefined;
      this.error = err;
      return;
    }
    this.opts.onSession?.();
  }

  /** A session loaded before the handshake came from the shared file; this app may have its own. */
  private stale(): boolean {
    return !this.opts.config && this.loadedFor !== this.slug();
  }

  current(): Session {
    if (!this.opts.config && (!this.session || this.stale())) this.load();
    if (this.session) return this.session;
    throw new NotConnectedError(notConnectedMessage(this.error?.message, this.savedAddress()));
  }

  /** The session when connected, without re-reading anything but a stale app's settings. */
  active(): Session | undefined {
    if (this.session && this.stale()) this.load();
    return this.session;
  }

  token(): string | undefined {
    return this.session?.config.token;
  }

  /** The address `connect` reuses when none is given. */
  savedAddress(): string | undefined {
    return this.active()?.config.baseUrl ?? savedAddress(this.opts.env, undefined, this.slug());
  }

  /**
   * Adopts a token the browser just delivered and `connect` proved. The rest
   * of the configuration (the default workspace) is re-read, so precedence is
   * exactly what a restart would give.
   */
  use(saved: { url: string; token: string }): void {
    const slug = this.slug();
    let config: Config = { baseUrl: saved.url, token: saved.token };
    try {
      const loaded = loadConfig(this.opts.env, readConfigFile(this.readConfigPath()));
      if (loaded.baseUrl === saved.url && loaded.token === saved.token) config = loaded;
    } catch {
      // The file was just written; if it cannot be read back, the proved pair
      // is still good for this session.
    }
    this.session = new Session(config, this.opts.fetch, this.opts.timeoutMs, this.opts.onMe);
    this.error = undefined;
    this.loadedFor = slug;
    this.opts.onSession?.();
  }

  /** Only one browser connection waits at a time; a newer one replaces it. */
  replacePending(next: PendingConnect): void {
    this.pending?.close("replaced");
    this.pending = next;
  }

  closePending(): void {
    this.pending?.close("closed");
    this.pending = undefined;
  }
}
