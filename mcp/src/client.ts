import type { Config } from "./config.js";
import { redact } from "./redact.js";

/**
 * The one place this server talks to OpsTracking.
 *
 * Every request goes to `<origin>/api/...` with the personal token as a bearer
 * credential. The organization's own host fronts the API with a proxy that
 * refuses a body in any content type but JSON (415), so every body is sent as
 * `application/json`, and every request asks for JSON back.
 */

export type Query = Record<string, string | number | boolean | undefined | null>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([502, 503, 504]);

/**
 * A refused or failed request. `code` and `serverMessage` are the API's own
 * `{"error":{"code","message"}}`; `message` is the sentence the model reads,
 * which always carries the server's message verbatim plus what to do next.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: string;

  constructor(status: number, code: string, serverMessage: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

/** Builds the explanation for a failed response. Exported for tests. */
export function describeFailure(
  status: number,
  code: string,
  serverMessage: string,
  retryAfter?: string | null,
): string {
  const said = serverMessage ? ` ${serverMessage}` : "";
  const tag = code ? ` [${code}]` : "";
  switch (status) {
    case 400:
      if (code === "agent_request_kind") {
        return `OpsTracking rejected the request:${said}${tag}. This OpsTracking does not take that kind of approval request.`;
      }
      return `OpsTracking rejected the request:${said}${tag}`;
    case 401:
      return (
        `OpsTracking did not accept the API token:${said}${tag}. ` +
        "The token may be expired or revoked. Offer to reconnect: call the `connect` tool with reconnect: true " +
        "(it reuses the saved address) and tell the user a browser window will open for them to approve a new token. " +
        "Old tokens can be revoked in Settings → Password & security → API tokens. Never ask the user to paste a token into the chat."
      );
    case 403:
      if (code === "token_read_only") {
        return (
          `Not allowed:${said}${tag}. This API token is read-only. ` +
          "To make changes the user needs a token created with write access."
        );
      }
      if (code === "token_scope") {
        return (
          `Not allowed:${said}${tag} The connection was approved without that permission. ` +
          "To add it, the user connects again (the `connect` tool with reconnect: true) and ticks it on the " +
          "approval page. Never ask the user for a token."
        );
      }
      if (code === "token_forbidden") {
        return (
          `Not allowed:${said}${tag}. Personal API tokens cannot do this; ` +
          "the user has to do it in the OpsTracking app."
        );
      }
      if (code === "module_disabled") {
        return `Not available:${said}${tag}. The module is turned off in this workspace.`;
      }
      return (
        `Permission denied:${said}${tag}. ` +
        "The token acts with the user's own permissions, and their role does not allow this."
      );
    case 404:
      if (code === "agent_request_not_found") {
        return `Not found:${said}${tag}. list_agent_requests shows the user's own requests.`;
      }
      return `Not found:${said}${tag}. It may not exist, or the user may not have access to it.`;
    case 409:
      if (code === "agent_request_closed") {
        return `Conflict:${said}${tag}. File a new request if the user still wants it.`;
      }
      return `Conflict:${said}${tag}`;
    case 413:
      return `Too large:${said}${tag}`;
    case 415:
      return `OpsTracking refused the request format:${said}${tag}`;
    case 422:
      return `OpsTracking could not process the request:${said}${tag}`;
    case 429: {
      const wait = retryAfter && /^\d+$/.test(retryAfter) ? ` Try again in ${retryAfter} seconds.` : " Wait a moment before trying again.";
      if (code === "token_write_budget") {
        // A budget, not congestion: retrying in a loop is exactly what it stops.
        return `Change limit reached:${said}${tag}${wait} Tell the user; do not retry in a loop.`;
      }
      return `Rate limited by OpsTracking:${said}${tag}.${wait}`;
    }
    default:
      if (status >= 500) {
        return `OpsTracking had a server error (HTTP ${status}):${said}${tag}. Try again shortly.`;
      }
      return `OpsTracking answered HTTP ${status}:${said}${tag}`;
  }
}

function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export class OpsTrackingClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: Pick<Config, "baseUrl" | "token">, fetchImpl?: FetchLike, timeoutMs = REQUEST_TIMEOUT_MS) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = timeoutMs;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) throw new Error(`API path must start with "/": ${path}`);
    const url = `${this.baseUrl}/api${path}${buildQuery(opts.query)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "opstracking-mcp",
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    // One retry, for reads only, on the gateway statuses a redeploy produces.
    // A write is never retried: a POST that timed out at the gateway may well
    // have landed, and repeating it would log the hours twice.
    const attempts = method === "GET" ? 2 : 1;
    for (let attempt = 1; ; attempt++) {
      // A timer of our own rather than AbortSignal.timeout(): that one is
      // unref'd, so a hung request would not keep the process waiting for it.
      // It covers reading the body as well as the headers.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...init, signal: abort.signal });
        if (RETRYABLE.has(response.status) && attempt < attempts) {
          await response.body?.cancel().catch(() => undefined);
        } else {
          return await this.read<T>(response);
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (abort.signal.aborted) {
          throw new ApiError(0, "timeout", "",
            `OpsTracking did not answer ${method} ${path} within ${Math.round(this.timeoutMs / 1000)} seconds.`);
        }
        const e = err as { message?: string; cause?: { code?: string; message?: string } };
        const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "network error";
        throw new ApiError(0, "network", "",
          redact(`Could not reach OpsTracking at ${this.baseUrl} (${detail}). Check OPSTRACKING_URL and the network.`, this.token));
      } finally {
        clearTimeout(timer);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (response.ok) {
      if (text !== "" && parsed === undefined) {
        throw new ApiError(response.status, "invalid_response", "",
          "OpsTracking answered with something other than JSON. Check that OPSTRACKING_URL is the organization's address.");
      }
      return (parsed ?? null) as T;
    }
    const envelope = (parsed ?? {}) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof envelope.error?.code === "string" ? envelope.error.code : "";
    const serverMessage = typeof envelope.error?.message === "string" ? redact(envelope.error.message, this.token) : "";
    const message = describeFailure(response.status, code, serverMessage, response.headers.get("retry-after"));
    throw new ApiError(response.status, code, serverMessage, redact(message, this.token));
  }
}
