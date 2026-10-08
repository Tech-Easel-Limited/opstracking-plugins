# OpsTracking MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for OpsTracking. It lets an AI assistant —
Claude Code, Claude Desktop, Cursor, or any MCP client — read your projects, tasks, time, clients, people,
departments, assets and invoices, and make the changes you allowed when you connected it, each after you confirm
it in the chat: projects and board columns, departments and teams, clients and contacts, tasks, your own time
and timer, assets, and invoice **drafts**. Acts that grant access, send something outward or declare your
timesheet — inviting people, project membership, roles, sending an invoice, marking it paid, submitting a
week — it can only **ask for**: you approve each one in OpsTracking itself.

It runs on your machine over stdio and talks to your organization's OpsTracking address with a personal API
token. It can do exactly what you can do in the app, and less: see [Security model](#security-model).

## Requirements

- Node.js 20 or newer
- An OpsTracking account

## 1. Install the plugin

The server is not published to a package registry. `pnpm package` (see
[Building the release](#building-the-release)) produces the Claude and Cursor
plugins with the server already inside them — one self-contained file,
`server/opstracking-mcp.mjs`, with every dependency bundled, so nothing is
installed from the internet:

- `opstracking-plugins/` (and `opstracking-plugins.zip`, the same folder
  zipped to send it) — ONE marketplace folder that **Claude Code and Cursor
  both install**: `.claude-plugin/marketplace.json` and
  `.cursor-plugin/marketplace.json` at the top, both listing one plugin in
  `plugins/opstracking/` that carries both apps' manifests. Neither app
  installs from a zip — unzip it, then `/plugin marketplace add <folder>` +
  `/plugin install opstracking@amento-tech` in Claude Code, or **Settings →
  Plugins → add plugins from a folder** in Cursor (see [Cursor](#cursor));
- `opstracking-plugin.zip` — the plugin alone at the top of the zip, for
  **Upload plugin in the Claude desktop app**.

Step-by-step instructions for the person receiving it are in
[INSTALL.md](INSTALL.md) (Claude) and [INSTALL-CURSOR.md](INSTALL-CURSOR.md)
(Cursor), both inside the folder. The plugin also adds a skill with the everyday
workflows and three commands: `/opstracking:setup`, `/opstracking:new-task` and
`/opstracking:standup` in Claude; `/opstracking-setup`, `/opstracking-new-task`
and `/opstracking-standup` in Cursor.

## 2. Connect — from the browser

Run the setup command (`/opstracking:setup` in Claude, `/opstracking-setup`
in Cursor), or ask the assistant anything about OpsTracking. Any tool used
before a connection exists answers "not connected", and the model:

1. asks the user **in the chat** for their OpsTracking address — their
   organization's link, e.g. `https://amento-tech.neoeasel.com` (there is no
   built-in default; the main domain works too, and then the page asks which
   organization);
2. calls the `connect` tool with it, which opens the browser on
   `<address>/connect/ai?callback=http://127.0.0.1:<port>/callback&state=…&client=<machine>&app=<App>`;
3. the user signs in if needed and approves on the **"Connect *App* to
   *Org*"** card — what the connection may change (two groups of
   checkboxes, none ticked: "Changes it can make" and "Changes you approve in
   the app"; nothing ticked is read only), expiry (7/30/90 days, default 90;
   a connection that may file approval requests lasts 7 days) and their
   current password;
4. the page mints a personal API token named `<App> on <machine>` (revoking
   the same app's earlier one on this machine) and sends the browser to the
   loopback callback with the token in the URL **fragment**; the server proves
   it against `GET /api/auth/me`, saves it and uses it at once — no restart —
   and lists exactly the tools that approval allows (see
   [Which tools are listed](#which-tools-are-listed)).

The setup command (or `connect` with `reconnect: true`) does it again: a new
address, a new token or another account. `connection_status` shows the saved
address and who it connects as, without changing anything.

The address saved is the one the user gave (an organization's own address is
the usual case); the token decides the organization either way. A token used
on another organization's subdomain is refused.

### Which app — Claude, Cursor or another client

The server learns which app runs it from the MCP handshake: the client names
itself in `initialize` (`claude-code`, `claude-ai`, `cursor-vscode`, …), which
the SDK keeps as `server.server.getClientVersion()` (`src/app.ts`). A name
containing "cursor" is **Cursor**, one containing "claude" is **Claude**,
anything else is **AI assistant**. That label:

- goes on the connect link as `app=<label>` (next to `client=<machine>`);
- is checked by the page against exactly those three values
  (`parseConnectApp` in `frontend/src/lib/connectClaude.ts`) — anything else
  falls back to the route's default, so a crafted link cannot put its own text
  on the card — and names the app on the card ("Connect Cursor to Amento
  Tech", "Cursor on Wades-Mac is asking to work in…"; "your AI assistant" for
  the generic label);
- names the token, `<App> on <machine>`. A reconnect revokes only tokens of
  exactly that name, so connecting Cursor never revokes Claude's token on the
  same machine, and the other way round;
- picks the settings file (below), so the two apps never overwrite each
  other's saved token.

`/connect/ai` is the path the server opens now. `/connect/claude`, the first
one, serves the same page and stays working for plugins built before it: a
link there without an `app` is Claude's.

### How the pieces fit

| Piece | Where |
| --- | --- |
| `connect` / `connection_status` tools | `src/tools/connect.ts` |
| Loopback listener, callback page, browser opener | `src/connect.ts` |
| Live connection the tools read on every call | `src/connection.ts` |
| Which app is asking; its settings file | `src/app.ts`, `src/config.ts` |
| The approval page (`/connect/ai`, `/connect/claude`) | `frontend/src/features/auth/ConnectPage.tsx`, `frontend/src/features/auth/ConnectClaudeScreen.tsx` |
| Callback / state / app / token-name validation | `frontend/src/lib/connectClaude.ts` |

## Settings: file, plugin settings, environment

The connection is kept per app, 0600 in a 0700 folder:

| App | Settings file |
| --- | --- |
| Claude | `~/.opstracking/claude.json` |
| Cursor | `~/.opstracking/cursor.json` |
| any other client | `~/.opstracking/config.json` (the shared file) |

Until an app has its own file it **reads** the shared `config.json` — the only
file earlier versions wrote — so an existing connection keeps working without
reconnecting; its next connect **writes** its own file and leaves the shared
one alone. `OPSTRACKING_CONFIG` overrides the path for every app. Before the
handshake (for the startup message) the shared file is read; the first tool
call after it re-reads the app's own.

**Saved settings override the environment and the plugin's values** — they
are what somebody set deliberately on this machine, most recently. Tools
re-read the settings while not connected, so a file written by another window
of the same app is picked up too.

| Variable | Meaning |
| --- | --- |
| `OPSTRACKING_URL` | The OpsTracking address. Must be `https://` (plain `http://` only for `localhost` / `*.localhost`). No path. |
| `OPSTRACKING_TOKEN` | An `otk_…` token, for clients that cannot use the browser flow. |
| `OPSTRACKING_WORKSPACE` | Default workspace, by uuid or exact name. Without it, the first workspace you hold a seat in is used. Every tool also takes a `workspace` argument. |

The plugin's `userConfig` (`plugins/opstracking/.claude-plugin/plugin.json`)
maps onto these and is entirely optional: where a Claude app does not prompt
for it, the values arrive as literal `${user_config.…}` placeholders, which the
server treats as unset.

### Fallback: `setup` and `config` in a terminal

For a machine where no browser can be opened, with a token created by hand in
**Settings → Password & security → API tokens**:

```sh
node opstracking-mcp.mjs setup --app cursor          # address, token (hidden), workspace — Enter keeps a value
node opstracking-mcp.mjs config --app claude         # show (token masked)
node opstracking-mcp.mjs config set url http://localhost:3000
node opstracking-mcp.mjs config set token            # prompts; refuses a token on the command line
node opstracking-mcp.mjs config unset workspace
```

`--app claude|cursor` works on `setup` and every `config` form and picks that
app's file; without it they use the shared `config.json`.

`setup` and a change to the address or token are proved against
`GET /api/auth/me` before anything is written.

## Other MCP clients

Every client runs the same file. The `connect` tool works in any of them (it
opens the browser on the machine the server runs on), so the variables below
are optional; set `OPSTRACKING_URL` and `OPSTRACKING_TOKEN` only to skip the
browser approval.

### Claude Code — server only

```sh
claude mcp add --env OPSTRACKING_URL="$OPSTRACKING_URL" --env OPSTRACKING_TOKEN="$OPSTRACKING_TOKEN" \
  --transport stdio --scope user opstracking -- node ~/opstracking-plugins/plugins/opstracking/server/opstracking-mcp.mjs
```

Keep an option such as `--transport stdio` between the last `--env` and the
name, or the name is read as another variable. This stores the values in your
Claude Code config.

### Cursor

Install the unzipped `opstracking-plugins` folder ([INSTALL-CURSOR.md](INSTALL-CURSOR.md)):
it is a marketplace folder — `.cursor-plugin/marketplace.json` listing the
plugin at `plugins/opstracking/` — which is what Cursor's *add plugins from a
folder* accepts (pointed at a bare plugin it refuses with "No marketplace
manifest found"); Cursor does not install from a zip. Alternatively copy
`plugins/opstracking` into `~/.cursor/plugins/local/opstracking` and restart
Cursor. Cursor reads the plugin's `.cursor-plugin/plugin.json` before the
Claude manifest beside it, and that manifest points it at its own files. The plugin registers the server through its
`mcp.json` (`node ${CURSOR_PLUGIN_ROOT}/server/opstracking-mcp.mjs`, no
environment), and adds the same skill and the commands `/opstracking-setup`,
`/opstracking-new-task` and `/opstracking-standup`. Cursor has no settings
prompt: the browser approval is the setup — ask the agent to "connect to
OpsTracking", give the address, approve **"Connect Cursor to *Org*"**. The
token is saved in `~/.opstracking/cursor.json` and named `Cursor on <machine>`.
A Teams or Enterprise admin can publish it to a team marketplace instead
(Dashboard → Plugins & MCPs); see INSTALL-CURSOR.md.

**Without the plugin**, register the bare server in `~/.cursor/mcp.json` (all
projects) or `.cursor/mcp.json` (one project). Use the absolute path to the
`.mjs` file; Cursor expands `${env:NAME}`, so a token, if you set one, stays in
your environment (leave `env` out to connect from the browser):

```json
{
  "mcpServers": {
    "opstracking": {
      "command": "node",
      "args": ["/Users/you/opstracking-plugins/plugins/opstracking/server/opstracking-mcp.mjs"],
      "env": {
        "OPSTRACKING_URL": "${env:OPSTRACKING_URL}",
        "OPSTRACKING_TOKEN": "${env:OPSTRACKING_TOKEN}"
      }
    }
  }
}
```

### Claude Desktop — without the plugin

Uploading the plugin is simpler. To run the bare server instead: Settings →
Developer → Edit Config (`claude_desktop_config.json`). The `env` block can be
left out and the connection made with `connect`; Claude Desktop does not
expand variables, so values put there are written into the file — keep it
private to your user account.

```json
{
  "mcpServers": {
    "opstracking": {
      "command": "node",
      "args": ["/Users/you/opstracking-plugins/plugins/opstracking/server/opstracking-mcp.mjs"],
      "env": {
        "OPSTRACKING_URL": "https://amento-tech.neoeasel.com",
        "OPSTRACKING_TOKEN": "otk_…"
      }
    }
  }
}
```

### Any other MCP client

Run `node /path/to/opstracking-mcp.mjs` as a stdio server with the environment
variables set.

### Building the release

```sh
cd mcp && pnpm install && pnpm package
```

`pnpm package` runs the tests, then `scripts/package.mjs`: it bundles the
server into `plugins/opstracking/server/opstracking-mcp.mjs` and writes, into
`mcp/release/`:

| File | What |
| --- | --- |
| `opstracking-plugins/` | The marketplace folder Claude Code and Cursor both add: both marketplace files, the plugin, INSTALL.md and INSTALL-CURSOR.md |
| `opstracking-plugins.zip` | That folder, zipped to send — unzipped before installing |
| `opstracking-plugin.zip` | The plugin alone at the top, for Upload plugin in the Claude desktop app |
| `opstracking-mcp.mjs` | The bare server |

There is one source: `plugins/opstracking/`. The released plugin is that
folder unchanged plus Cursor's files, generated and never committed:
`.cursor-plugin/plugin.json` from the Claude manifest's name, version,
description (reworded for Cursor), author and keywords, without `userConfig`,
with `commands`, `skills` and `mcpServers` pointing at the files below — so
Cursor, which reads its own manifest before `.claude-plugin/plugin.json`,
loads none of Claude's; `mcp.json` with `${CURSOR_PLUGIN_ROOT}` and no
environment; the same skill in `cursor/skills/`; and in `cursor/commands/` the
commands renamed `opstracking-<name>` (with a `name` in
their front matter, since Cursor lists plugin commands without the plugin
prefix Claude adds) and `/opstracking:<name>` rewritten to match. The script
deletes nothing outside `mcp/release/`. `pnpm bundle` only bundles.

Both output paths are git-ignored — the zips are the things you send. Rebuild
them whenever the server changes, and bump `version` in `package.json`,
`plugins/opstracking/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` so `/plugin update` sees it (the Cursor
manifest takes the plugin's version).

## Tools

Every workspace tool takes an optional `workspace` (uuid or exact name). Lists are paged: `page` from 1,
`size` 25 by default and at most 100; each result says when there are more. Projects, statuses, clients,
contacts, departments, teams, roles, invoices, assets and people can be given by name — an exact match
(ignoring case) is used; anything ambiguous or merely close is refused with the candidates listed, never
guessed.

### Which tools are listed

The server reads `GET /api/auth/me` when the client connects, after every `connect`, and whenever it
re-reads it (`whoami`, or every five minutes of use). A tool is listed only when both allow it:

- **the connection's scopes** — what the person ticked when approving it. Scopes govern writes only: every
  connection may read what its owner may read;
- **the person's permissions** — a grant of the tool's permission in at least one workspace seat (the
  "Shown when" column). The organization's owners and admins may always ask for a role change.

When the answer changes, the server shows and hides tools with the SDK's own enable/disable and the client
hears one `notifications/tools/list_changed`. While there is no working connection every tool is listed, and
each one answers how to connect. An OpsTracking that predates scoped tokens reports no scopes: a token there
is treated as holding the seven direct-change scopes (how an existing write token is mapped, MX-7), and the
approval tools are not listed. `src/access.ts` holds the rules; each tool declares its own `access`.

### Reading

| Tool | Shown when | What it does |
| --- | --- | --- |
| `connect` | always | Opens the browser to approve a connection to `address` (asked of the user; the saved one when omitted). Says so and opens nothing when a working connection to that address exists, unless `reconnect: true`. Annotated not read-only, not destructive |
| `connection_status` | always | The saved address and whether it connects, as whom — opens and changes nothing |
| `whoami` | always | Who the token belongs to; workspaces with role and permissions; what this connection may change, in the approval page's words |
| `list_projects` / `get_project` | projects.view | Projects — search, status, client, paging; one project with its statuses (board columns) and members |
| `list_project_columns` / `list_project_members` | projects.view | A project's statuses in board order (the last is "done"); its roster |
| `list_tasks` / `get_task` / `list_task_comments` | tasks.view | Tasks across projects — search, project, status, assignee (`me`), priority, tag, due windows, overdue; one task by handle (`WEB-12`) or uuid; its comment thread |
| `list_time_entries` | timesheets.view | Your (or, with permission, someone's) time for a week or up to 8 weeks, with totals |
| `list_clients` / `get_client` | clients.view | Clients; one client's contacts (with ids and portal access) and projects |
| `list_employees` | employees.view | The people directory |
| `list_departments` / `list_teams` | departments.view / teams.view | Departments with head and counts; teams with department, lead and members |
| `list_assets` | assets.view | Assets with holder and status — search, status, type, department |
| `list_invoices` / `get_invoice` | invoicing.view | Invoices with totals; one invoice by uuid or number |
| `list_agent_requests` / `get_agent_request` | an OpsTracking with approval requests | The approval requests filed from your connections, and what became of one |

### Changes it can make (Tier A — the tool calls the route)

| Tool | Scope | Shown when | What it does |
| --- | --- | --- | --- |
| `create_project` / `update_project` | `projects:write` | projects.add / .edit | Name, description, client, manager, lead, billing type, currency (create), dates, whether time needs a task. Never a rate |
| `set_project_status` / `archive_project` | `projects:write` | projects.status / .archive | Active, Paused, Completed; Closed (reversible) |
| `create_project_column` / `update_project_column` | `projects:write` | projects.edit | Add, rename, WIP limit, move. A column added last becomes the done column unless `position` is given |
| `create_department` / `update_department` / `archive_department` / `restore_department` | `structure:write` | departments.add / .edit / .archive / .restore | Name, description, head (`null` clears) |
| `create_team` / `update_team` / `archive_team` / `restore_team` | `structure:write` | teams.add / .edit / .archive / .restore | Name, department, lead (`null` clears), the whole roster |
| `create_client` / `update_client` / `archive_client` / `restore_client` | `clients:write` | clients.add / .edit / .archive / .restore | Company details, billing identity, terms, primary contact |
| `add_client_contact` / `update_client_contact` | `clients:write` | clients.edit | Contact name, email, phone, title, primary. Grants no access |
| `create_task` / `update_task` | `tasks:write` | tasks.add / .edit | Project, title, markdown description, type, priority, status, dates, effort (hours), assignees, tags, parent |
| `set_task_assignees` | `tasks:write` | tasks.assign | Replace a task's assignees (empty list unassigns) |
| `bulk_update_tasks` | `tasks:write` | tasks.edit | One status, added assignees or one priority over up to 50 tasks |
| `set_task_parent` | `tasks:write` | tasks.edit | Make a task a subtask, or top-level again |
| `add_task_comment` | `tasks:write` | tasks.view | Comment (markdown), optionally as a reply |
| `log_time` / `update_time_entry` | `time:write` | timesheets.add / .edit | Log your own time on a task or project for a day; change an entry's day (same week), duration, note, billable, task |
| `start_timer` / `stop_timer` | `time:write` | timesheets.add | Your one timer, on a task; a stop the server cannot log hands the minutes back |
| `preview_invoice` | `invoices:draft` | invoicing.add | What a draft would contain — lines, totals, hours left out — without saving. A POST on the server, so it needs the scope; annotated read-only |
| `create_invoice_draft` / `update_invoice_draft` / `duplicate_invoice` | `invoices:draft` | invoicing.add / .edit / .add | Save, change or copy a **draft**. Always `send: false`, never a number |
| `create_asset` / `update_asset` | `assets:write` | assets.add / .edit | Register an asset; change its details, holder or status |

### Changes you approve in the app (Tier B — the tool files a request)

| Tool | Scope | Shown when | Request kind(s) → route replayed on approval |
| --- | --- | --- | --- |
| `request_workspace_invite` | `people:invite` | employees.view and .add | `workspace_invite` → `POST /ws/:wsId/employees/invite` |
| `request_client_invite` | `people:invite` | projects.edit | `client_invite` → `POST /ws/:wsId/projects/:uuid/client-invite` |
| `request_portal_access` | `people:invite` | clients.edit | `portal_access` → `POST /ws/:wsId/clients/:uuid/contacts/:contactUuid/portal-access` |
| `request_project_member_change` | `projects:roster` | projects.assign or .view (a project's manager) | `project_member_add` / `_update` / `_remove` → the roster routes |
| `request_client_access` | `projects:roster` | projects.edit | `client_access_set` / `client_access_revoke` → `PUT` / `DELETE /ws/:wsId/projects/:uuid/client-access` |
| `request_role_assignment` | `roles:assign` | wsaccess.assign or wsroles.assign, or an org owner/admin | `member_role_assign` → `PATCH /ws/:wsId/members/:memberUuid/role` |
| `request_invoice_send` / `request_invoice_paid` | `invoices:send` | invoicing.edit | `invoice_send` / `invoice_pay` → `POST /ws/:wsId/invoices/:uuid/send` / `pay` |
| `request_timesheet_submit` | `time:submit` | timesheets.add | `timesheet_submit` → `POST /ws/:wsId/timesheets/submit` |

A request tool resolves names to ids, then `POST /api/ws/:wsId/agent-requests` with `{ kind, params, payload }`
— `payload` is the target route's own request body, `params` its route parameters. The answer is always
"filed for approval — nothing has changed yet", the lines OpsTracking computed from the payload, and the
approval link (`<org host>/approvals/agent/<uuid>?ws=<workspace>`). It never says the act is done;
`get_agent_request` reports approved only when OpsTracking says the replayed route succeeded.

Write and request tools are annotated `readOnlyHint: false, destructiveHint: false`, and their descriptions
tell the model to show you the change and wait for your confirmation before calling them.

Two prompts are included: `triage-bug-report` (paste a report, get a confirmed Bug task) and `daily-standup`.

## Security model

- **The token is you.** Every call runs with your own role and permissions in each workspace. The server adds
  no privileges and cannot see anything you cannot.
- **Scopes narrow it further.** A connection may change only what the person ticked when approving it
  (`docs/plans/MCP-EXPANSION.md` §8.1); none ticked is read only. OpsTracking refuses anything else with
  `token_scope`, and the tool relays that message verbatim with how to add the permission (connect again and
  tick it). The server lists only the tools the scopes and the person's permissions allow, so the model
  never sees one it cannot use — but the refusal is the server's, not the list's.
- **Three tiers.** *Direct* (Tier A): reversible changes that stay in the product — the tool calls the
  route. *Approved in the app* (Tier B): acts that grant access, send something outward or are the person's
  own declaration — invites, portal access, project membership and client sharing, role assignment, invoice
  send and paid, timesheet submit. A token **never** performs these: the tool files a request, and the
  person approves or declines it on `/approvals/agent/<uuid>` in OpsTracking, which shows what will happen
  from the stored payload (never from the model's words) and asks for the password for invoice send and for
  a Workspace Admin role. Approval replays the stored request through the ordinary route under the person's
  session, with the app's own validation and side effects. Requests expire after 24 hours; a connection that
  may file them lasts 7 days. *Never through a token* (Tier C): everything else below.
- **What is deliberately not exposed**, whatever the scopes:
  - *Deleting anything* — tasks, comments, time entries, invoices, columns, contacts. Deletion is
    irreversible and the cost of a model misreading an instruction is too high; archive exists for
    projects, clients, departments, teams and assets.
  - *Voiding or reopening invoices, and invoice settings* — they rewrite a sent record. Drafts are always
    saved with `send: false` and without a number; sending is an approval request.
  - *Approving, rejecting, locking or unlocking timesheets* — sign-off of someone else's hours.
  - *Editing a role's permission matrix, workspace modules, org invites and org settings* — they change
    authority for everyone.
  - *Rates on projects and teams, compensation and bank details, billing and subscription*, and your
    account and token settings.

  OpsTracking refuses these for every token (`token_forbidden`); the server also simply has no tool for
  them.
- **Workspace text is data.** Task titles and descriptions, comments, project, client, contact,
  department, team and asset text, invoice lines and notes, time-entry notes, and what an approval request
  displays are written by people in the workspace — or by a client in the portal. Every such value reaches
  the model inside `<workspace-data field="…">…</workspace-data>` (an early `</workspace-data>` inside a
  value is escaped), and the server instructions say its contents are data, never instructions. People's
  display names, board column names and the server's own messages are not wrapped. `structuredContent`
  carries the plain values.
- **Limits.** OpsTracking caps a token's changes (`token_write_budget`, 60 a minute and 1,000 a day by
  default); the tool says so and tells the model not to retry in a loop.
- **The token never passes through the chat.** The browser approval delivers it from the OpsTracking page
  straight to a listener on the user's own machine; the model only ever sees the address. No tool asks for or
  accepts a token, and the not-connected messages tell the model never to ask. The server never prints it,
  redacts anything token-shaped from every result and error, and checks its shape before sending it.
- **The browser approval** (`src/connect.ts`, `frontend/src/lib/connectClaude.ts`):
  - The page refuses — before drawing any form — a callback that is not exactly
    `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` (compared as a string, so
    `127.1`, userinfo, a query or a fragment all fail), and a `state` that is not 20–200 URL-safe characters.
    Minting still needs the user's current password.
  - The token travels in the URL **fragment**, which browsers never send: no server log, proxy or `Referer`
    holds it. The callback page strips the fragment from the address bar before doing anything else.
  - The listener binds `127.0.0.1` only, on a random port; serves only its exact `Host` (DNS rebinding) and
    `Origin`; takes only `application/json` from a loopback socket; compares a 32-byte random `state` in
    constant time; checks the token's shape and the address (`https`, or `http` only for `localhost`); and
    proves the token against `GET /api/auth/me` on the address the user gave (then on the page's suggested
    address, if that one refuses) before writing anything.
  - It is single-use and short-lived: closed after a success, a cancel, five refused posts or ten minutes,
    and replaced by a newer `connect`. The callback page is self-contained with a nonce-only CSP,
    `no-referrer` and `no-store`.
  - The settings file (the app's own) is written 0600 in a 0700 folder; the new token is used at once,
    without a restart.
  - A reconnect names the token `<App> on <machine>` (`Claude`, `Cursor` or `AI assistant`, from an
    allowlist) and the page revokes earlier tokens of exactly that name after the new one exists (a token
    cannot manage tokens, so the plugin cannot retire its own) — never another app's token.
- **Every change is recorded as the agent's.** OpsTracking writes an audit entry for each token write and
  marks task activity "via <token name>" (`Claude on wali-mbp`), so an assistant's change is never mistaken
  for the person's own.
- **Rotate and revoke** in Settings → API tokens. Use one token per machine or tool, give it an expiry, and
  revoke it as soon as a laptop is lost or a tool is retired. A revoked or expired token fails with a clear
  `invalid_token` message.
- Requests go only to the saved OpsTracking address over HTTPS, with a 30-second timeout. Reads are retried once on a
  502/503/504; writes are never retried, so a slow response cannot log the same hours twice.

## Development

```sh
pnpm install
pnpm build      # tsc → dist/
pnpm test       # node:test with a mocked fetch
pnpm typecheck
```

`src/client.ts` is the HTTP layer (headers, timeout, retry, error mapping, redaction), `src/resolve.ts` turns
names into ids, `src/access.ts` decides which tools are listed, `src/tools/*` are the tools (`requests.ts` the
approval requests), and `test/` asserts the exact request each write tool sends, the tool list for each mix of
scopes and permissions, and that no request tool reports its act as done.
The request shapes follow the backend handlers and the frontend's RTK Query services
(`frontend/src/services/*Api.ts`).
