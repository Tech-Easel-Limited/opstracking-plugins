import { ALWAYS, SCOPE_LABELS, TIER_A_SCOPES, TIER_B_SCOPES, type Scope } from "../access.js";
import type { MeToken } from "../types.js";
import { defineTool, READ, result, type ToolContext } from "./common.js";

/** What this connection may change, in the approval page's words. */
function scopeLines(token: MeToken | null | undefined): string[] {
  if (!token) {
    return ["Changes allowed: not reported — this OpsTracking predates per-permission connections."];
  }
  const held = new Set(token.scopes ?? []);
  const labels = (list: readonly Scope[]) => list.filter((s) => held.has(s)).map((s) => `${SCOPE_LABELS[s]} (${s})`);
  const direct = labels(TIER_A_SCOPES);
  const approved = labels(TIER_B_SCOPES);
  return [
    `Connection: ${token.name ?? "this token"}${token.expiresAt ? `, expires ${token.expiresAt}` : ""}`,
    direct.length === 0 && approved.length === 0 ? "Changes allowed: none — this connection is read only." : "",
    direct.length > 0 ? `Changes it can make: ${direct.join("; ")}` : "",
    approved.length > 0 ? `Changes the user approves in the app: ${approved.join("; ")}` : "",
  ].filter(Boolean);
}

export function registerAccountTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "whoami",
    {
      title: "Who am I",
      description:
        "Shows who the OpsTracking API token belongs to, the organization, and every workspace they hold a seat in " +
        "with their role and permissions there, and what this connection was allowed to change. Call this first to " +
        "learn which workspaces exist and what the user may do.",
      inputSchema: {},
      annotations: READ,
      access: ALWAYS,
    },
    async (_args, session) => {
      // A fresh read also re-decides which tools are shown (src/access.ts).
      const me = await session.getMe(true);
      const profileName = [me.profile?.firstName, me.profile?.lastName].filter(Boolean).join(" ");
      const org = me.currentOrg;
      const memberId = me.orgs?.find((o) => o.id === org?.id)?.memberId ?? "";
      const seats = me.workspaces ?? [];
      const defaultWs = seats.length > 0 ? await session.workspace().catch(() => undefined) : undefined;

      const workspaces = seats.map((w) => ({
        id: w.id,
        name: w.name,
        role: w.role?.name ?? "",
        roleKey: w.role?.key ?? "",
        memberType: w.memberType ?? "",
        tracksTime: w.tracksTime ?? false,
        permissions: (w.perms ?? [])
          .filter((p) => p.enabled)
          .map((p) => ({ category: p.cat, actions: p.acts ?? [], extras: p.extras ?? [], scope: p.scope ?? "" })),
      }));

      const lines = [
        `Signed in as ${profileName || me.user.username} (@${me.user.username})${org ? ` in ${org.name} (${org.slug})` : ""}.`,
        memberId ? `Your member id: ${memberId}` : "",
        ...scopeLines(me.token),
        "",
        seats.length === 0 ? "No workspace seats." : "Workspaces:",
        ...workspaces.map(
          (w) =>
            `- ${w.name} (${w.id})${defaultWs?.id === w.id ? " [default]" : ""} — role ${w.role}` +
            `${w.tracksTime ? ", tracks time" : ""}\n  permissions: ${
              w.permissions.map((p) => `${p.category}: ${p.actions.join("/") || "none"}${p.scope ? ` (${p.scope})` : ""}`).join("; ") || "none"
            }`,
        ),
      ].filter((l, i, a) => !(l === "" && a[i - 1] === ""));

      return result(
        lines.join("\n"),
        {
          user: { id: me.user.id, username: me.user.username, name: profileName },
          organization: org,
          memberId,
          defaultWorkspace: defaultWs ? { id: defaultWs.id, name: defaultWs.name } : null,
          token: me.token ? { name: me.token.name ?? "", scopes: me.token.scopes ?? [], expiresAt: me.token.expiresAt ?? null } : null,
          workspaces,
        },
        ctx.token(),
      );
    },
  );
}
