import { OpsTrackingClient, type FetchLike } from "./client.js";
import type { Config } from "./config.js";
import { choose, isUuid, ResolveError } from "./resolve.js";
import type { Me, MeWorkspace } from "./types.js";

const ME_TTL_MS = 5 * 60_000;

/**
 * Who the token belongs to and which workspace a call is about.
 *
 * `GET /api/auth/me` is the one account-level read a token may make; it lists
 * the workspaces the person holds a seat in, each with the role and the
 * permission grants that seat carries. It is cached briefly because every
 * workspace-scoped tool needs it to turn a workspace name into its uuid.
 */
export class Session {
  readonly client: OpsTrackingClient;
  readonly config: Config;
  private me?: { value: Me; at: number };
  private readonly onMe?: (me: Me) => void;

  /** `onMe` hears every fresh answer — what the tool list is shown from (src/access.ts). */
  constructor(config: Config, fetchImpl?: FetchLike, timeoutMs?: number, onMe?: (me: Me) => void) {
    this.config = config;
    this.client = new OpsTrackingClient(config, fetchImpl, timeoutMs);
    this.onMe = onMe;
  }

  async getMe(fresh = false): Promise<Me> {
    if (!fresh && this.me && Date.now() - this.me.at < ME_TTL_MS) return this.me.value;
    const value = await this.client.get<Me>("/auth/me");
    this.me = { value, at: Date.now() };
    this.onMe?.(value);
    return value;
  }

  /** The caller's own org-member uuid — the id every "me" filter speaks. */
  async myMemberId(): Promise<string> {
    const me = await this.getMe();
    const current = me.currentOrg?.id;
    const org = me.orgs?.find((o) => o.id === current) ?? me.orgs?.[0];
    if (!org?.memberId) {
      throw new ResolveError("Could not determine your own member id from /api/auth/me.");
    }
    return org.memberId;
  }

  /**
   * The workspace a call is about: the tool's own `workspace` argument, else
   * OPSTRACKING_WORKSPACE, else the first workspace the token can see. A uuid
   * or an exact (case-insensitive) name; anything else is refused with the
   * list of workspaces rather than guessed at.
   */
  async workspace(arg?: string): Promise<MeWorkspace> {
    const me = await this.getMe();
    const seats = me.workspaces ?? [];
    if (seats.length === 0) {
      throw new ResolveError("This account has no workspace seat in the organization, so there is nothing to work in.");
    }
    const wanted = (arg ?? this.config.defaultWorkspace ?? "").trim();
    if (wanted === "") return seats[0];
    if (isUuid(wanted)) {
      const hit = seats.find((w) => w.id.toLowerCase() === wanted.toLowerCase());
      if (hit) return hit;
      throw new ResolveError(
        `No workspace with id ${wanted} is available to this token. Available: ${seats.map((w) => `${w.name} (${w.id})`).join(", ")}.`,
      );
    }
    return choose("workspace", wanted, seats.map((w) => ({ item: w, label: `${w.name} (${w.id})`, keys: [w.name] })));
  }

  /** The workspace-scoped path prefix, `/ws/<uuid>`. */
  async wsPath(arg?: string): Promise<{ ws: MeWorkspace; base: string }> {
    const ws = await this.workspace(arg);
    return { ws, base: `/ws/${ws.id}` };
  }
}
