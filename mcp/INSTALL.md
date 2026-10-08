# OpsTracking for Claude — installing the plugin

This lets Claude look things up in OpsTracking (projects, tasks, time, clients,
people, assets, invoices) and — only for what you allow when you connect it —
make changes: projects, departments and teams, clients, tasks, your time,
assets and invoice drafts. It always asks before changing anything. Inviting
people, changing who is on a project or their role, sending an invoice,
marking it paid and submitting your timesheet it can only **ask for**: you
approve each one in OpsTracking. It can never delete anything, void an
invoice or approve timesheets.

You need **Node.js 20 or newer** (`node -v` to check) and the Claude desktop
app or Claude Code. There is nothing to copy and no terminal step: you connect
from your browser.

## 1. Install the plugin

**Claude desktop app** — in **Customize → Plugins**, choose **Add → Upload
plugin** and pick `opstracking-plugin.zip` (or its unzipped folder), then turn
it on.

**Claude Code** — you were sent `opstracking-plugins.zip`; the same folder
works for Cursor. Claude Code does not install from a zip, so unzip it first,
somewhere permanent: it runs the plugin from that folder, so don't move or
delete it afterwards. Then add the **`opstracking-plugins`** folder — the one
with `.claude-plugin` and `plugins` directly inside it:

```text
/plugin marketplace add ~/Documents/opstracking-plugins
/plugin install opstracking@amento-tech
```

(In the desktop app's Code tab: **+ → Plugins → Add plugin** once the
marketplace is added.)

If Claude Code asks for the plugin's settings, you can leave them all empty.

## 2. Connect it — once

Run **`/opstracking:setup`**, or just ask Claude anything about OpsTracking
(*"What's on my plate in OpsTracking today?"*).

1. Claude asks for **your OpsTracking address** — your organization's link, as
   you open it in the browser, e.g. `https://amento-tech.neoeasel.com`
   (`http://localhost:3000` for a local copy).
2. A **browser tab opens** on that address. Sign in if it asks.
3. The page reads **"Connect Claude to *your organization*"**. Tick what it
   may change — nothing is ticked to start with, and nothing ticked means it
   can only read:
   - **Changes it can make** — projects, departments and teams, clients,
     tasks, your time entries and timer, invoice drafts, assets. Claude
     still shows you each change and waits for your "yes" in the chat.
   - **Changes you approve in the app** — inviting people, project members
     and client sharing, workspace roles, sending invoices and marking them
     paid, submitting your timesheet. Claude only files a request; nothing
     happens until you open its link and approve it in OpsTracking.
     Connections that can file requests last 7 days.

   Choose how long it lasts (7, 30 or 90 days), enter your password, and
   click **Connect**.
4. The tab says **Connected** — close it, go back to Claude and ask again.

That's it. Your password never goes to Claude, and the connection's key goes
straight from the browser to your own computer — it never appears in the chat.
It is saved in `~/.opstracking/claude.json`, readable only by you (a
connection made before this version stays in `~/.opstracking/config.json` and
keeps working until you connect again). Cursor on the same computer keeps its
own connection, so connecting one never disconnects the other.

**Never paste a token into the chat.** Claude will never ask for one.

## Setting up again, or a new address

Run **`/opstracking:setup`** again. Claude shows the saved address — say
*"same"* to keep it or give a new one — and opens the browser for a fresh
approval. The new connection replaces the old one (and the page retires this
computer's previous connection for you). Saying *"connect OpsTracking to
https://new-address"* does the same.

## When Claude asks for your approval

For an invite, a project-membership or role change, sending an invoice,
marking one paid or submitting your timesheet, Claude files a **request** and
gives you a link. Nothing has happened yet: open the link (or find it under
pending approvals in **Settings → API tokens**), check what OpsTracking says
will happen — it shows the real recipient, role, project, invoice and amount,
not Claude's summary — and **Approve** or **Decline**. Sending an invoice, and
any role that includes Workspace Admin, asks for your password. A request you
leave expires after 24 hours. Ask Claude afterwards and it can tell you what
you decided.

To change what Claude may do, run **`/opstracking:setup`** again and tick
different boxes; *"what can you change in OpsTracking?"* shows the current
connection's permissions.

## Check it works

- Ask: *"Who am I in OpsTracking, and which workspaces can I see?"*
- Try `/opstracking:standup` for a summary of your tasks, or
  `/opstracking:new-task` to turn a description into a task.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No browser tab opened | Claude also shows the link — open it yourself on this computer. It works for 10 minutes. |
| "This connection link isn't valid" | The link was changed or is not from Claude. Ask Claude to connect again. |
| "Not connected: … Nothing was saved" in the tab | Ask Claude to connect again. The link is single-use and lasts 10 minutes. |
| "You're not in *organization*" | You gave another organization's address. Run `/opstracking:setup` with yours. |
| `This API token is invalid, expired or revoked.` | The connection expired or was revoked. Run `/opstracking:setup`. |
| `This token is read-only.` or `This token can't do that. …` | The connection wasn't allowed that kind of change. Run `/opstracking:setup` and tick it on the page. |
| `This token has made too many changes for now.` | A safety limit on how fast a connection can change things. Wait a little and ask again. |
| "Filed for approval — nothing has changed yet" | Working as intended: open the link Claude gives you (or **Settings → API tokens** in OpsTracking) and approve or decline it there. |
| `API tokens can't do this — sign in to the app instead.` | That action (deleting, voiding invoices, approving timesheets, role permissions, billing) is deliberately kept to people in the app. |
| The plugin fails to start | Check `node -v` is 20 or newer. |

## Fallback: connecting from a terminal

Only for a computer where no browser can be opened. Create a token in
OpsTracking (**Settings → Password & security → API tokens**), then run the
`opstracking-mcp.mjs` file you were sent (it is also inside the plugin, under
`server/`):

```sh
node ~/Downloads/opstracking-mcp.mjs setup --app claude                     # address, token (hidden), workspace
node ~/Downloads/opstracking-mcp.mjs config --app claude                    # see what is saved (token masked)
node ~/Downloads/opstracking-mcp.mjs config --app claude set workspace "Delivery"
```

It checks the token with OpsTracking before saving it.

## Updating

**Desktop app**: upload the newer `opstracking-plugin.zip`. **Claude Code**:
unzip the newer `opstracking-plugins.zip` over the same folder, run
`/plugin marketplace update amento-tech` and restart. Your connection is kept.

## Removing

Remove the plugin (`/plugin uninstall opstracking@amento-tech` in Claude Code),
delete `~/.opstracking/claude.json` (and `config.json` there, from an older
version — or the whole `~/.opstracking/` folder if Cursor doesn't use it
either), and revoke the connection in **Settings → Password & security → API
tokens** (it is named "Claude on *your computer*").

## Not using Claude?

**Cursor** installs the same `opstracking-plugins` folder; its steps are in
`INSTALL-CURSOR.md`, inside that folder. Other MCP clients can run the same
server file (`plugins/opstracking/server/opstracking-mcp.mjs`) — see the
project's `mcp/README.md` for ready-made configs.
