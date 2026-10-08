# OpsTracking for Cursor — installing the plugin

This lets Cursor's agent look things up in OpsTracking (projects, tasks, time,
clients, people, assets, invoices) and — only for what you allow when you
connect it — make changes: projects, departments and teams, clients, tasks,
your time, assets and invoice drafts. It always asks before changing anything.
Inviting people, changing who is on a project or their role, sending an
invoice, marking it paid and submitting your timesheet it can only **ask
for**: you approve each one in OpsTracking. It can never delete anything, void
an invoice or approve timesheets.

You need **Node.js 20 or newer** (`node -v` in a terminal to check) and
Cursor. You connect from your browser — there is no token to copy and no
settings file to edit.

## 1. Install the plugin

You were sent `opstracking-plugins.zip` — the same one Claude users get.
**Cursor does not install from a zip**: unzip it first. Unzipped, it is a
small **plugin marketplace**: a folder with `.cursor-plugin/marketplace.json`
(and Claude's `.claude-plugin/marketplace.json`) at the top, listing the
OpsTracking plugin in `plugins/opstracking/`. The plugin carries its own
Cursor manifest, which Cursor reads before anything meant for Claude.

1. **Unzip it somewhere permanent** — double-click the zip in Finder, then move
   the `opstracking-plugins` folder to where it will stay (e.g. your
   Documents folder). Cursor keeps using it from there, so don't delete or move
   it afterwards.
2. In Cursor, open **Settings → Plugins** and choose **add plugins from a
   folder**. Select the **`opstracking-plugins`** folder itself — the one
   with `.cursor-plugin` and `plugins` directly inside it, not a folder above
   or below it.
3. **OpsTracking** appears in the list — install / turn it on.
4. Restart Cursor if it asks (or run *Developer: Reload Window*).

If Cursor says *"No marketplace manifest found … (expected
.cursor-plugin/marketplace.json)"*, the folder you picked is one level off:
pick the folder that directly contains `.cursor-plugin` (a plain double-click
unzip can nest it once — open the folder and check).

**Alternative — copy it in yourself** (Cursor's documented way to load a
plugin that is not in a marketplace). Cursor loads plugins placed in
`~/.cursor/plugins/local/`. Copy the **`plugins/opstracking`** folder from the
unzipped zip to `~/.cursor/plugins/local/opstracking` (in Finder: **Go → Go to
Folder…** ⇧⌘G, type `~/.cursor/plugins`, create a `local` folder if there is
none), so that `~/.cursor/plugins/local/opstracking/.cursor-plugin/plugin.json`
exists, then restart Cursor.

## 2. Connect it — once

In the agent chat, ask **"connect to OpsTracking"** — or run the
**`/opstracking-setup`** command, or just ask something like *"What's on my
plate in OpsTracking today?"*.

1. The agent asks for **your OpsTracking address** — your organization's link,
   as you open it in the browser, e.g. `https://amento-tech.neoeasel.com`
   (`http://localhost:3000` for a local copy).
2. A **browser tab opens** on that address. Sign in if it asks. (Cursor may ask
   you to allow the tool call first — allow it.)
3. The page reads **"Connect Cursor to *your organization*"**. Tick what it
   may change — nothing is ticked to start with, and nothing ticked means it
   can only read:
   - **Changes it can make** — projects, departments and teams, clients,
     tasks, your time entries and timer, invoice drafts, assets. The agent
     still shows you each change and waits for your "yes" in the chat.
   - **Changes you approve in the app** — inviting people, project members
     and client sharing, workspace roles, sending invoices and marking them
     paid, submitting your timesheet. The agent only files a request; nothing
     happens until you open its link and approve it in OpsTracking.
     Connections that can file requests last 7 days.

   Choose how long it lasts (7, 30 or 90 days), enter your password, and
   click **Connect**.
4. The tab says **Connected** — close it, go back to Cursor and ask again.

Your password never goes to Cursor, and the connection's key goes straight
from the browser to your own computer — it never appears in the chat. It is
saved in `~/.opstracking/cursor.json`, readable only by you. It is separate
from Claude's: connecting Cursor never disconnects Claude on the same
computer, and the other way round.

**Never paste a token into the chat.** The agent will never ask for one.

## Setting up again, or a new address

Run **`/opstracking-setup`** again, or say *"connect OpsTracking to
https://new-address"*. The agent shows the saved address — say *"same"* to
keep it or give a new one — and opens the browser for a fresh approval. The
new connection replaces the old one, and the page retires this computer's
previous Cursor connection for you ("Cursor on *your computer*" in
**Settings → Password & security → API tokens**).

## When the agent asks for your approval

For an invite, a project-membership or role change, sending an invoice,
marking one paid or submitting your timesheet, the agent files a **request** and
gives you a link. Nothing has happened yet: open the link (or find it under
pending approvals in **Settings → API tokens**), check what OpsTracking says
will happen — it shows the real recipient, role, project, invoice and amount,
not the agent's summary — and **Approve** or **Decline**. Sending an invoice, and
any role that includes Workspace Admin, asks for your password. A request you
leave expires after 24 hours. Ask the agent afterwards and it can tell you what
you decided.

To change what the agent may do, run **`/opstracking-setup`** again and tick
different boxes; *"what can you change in OpsTracking?"* shows the current
connection's permissions.

## Check it works

- Ask: *"Who am I in OpsTracking, and which workspaces can I see?"*
- Try **`/opstracking-standup`** for a summary of your tasks, or
  **`/opstracking-new-task`** to turn a description into a task.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "No marketplace manifest found" when adding the folder | Select the folder that directly contains `.cursor-plugin` and `plugins` (not the one above it, not `plugins/opstracking`). |
| No OpsTracking tools in Cursor | Check the plugin is turned on under **Settings → Plugins**, then restart Cursor. If you copied it in yourself, check `~/.cursor/plugins/local/opstracking/.cursor-plugin/plugin.json` exists. On Enterprise, local plugins need **Allow Local Plugin Imports** switched on by an admin (Dashboard → Settings → Security & Identity → Marketplace and Plugins). |
| Cursor won't take the zip | Expected — unzip it and add the folder, as in step 1. |
| The plugin's server fails to start | Check `node -v` is 20 or newer. |
| No browser tab opened | The agent also shows the link — open it yourself on this computer. It works for 10 minutes. |
| "This connection link isn't valid" | The link was changed or is not from Cursor. Ask the agent to connect again. |
| "Not connected: … Nothing was saved" in the tab | Ask the agent to connect again. The link is single-use and lasts 10 minutes. |
| "You're not in *organization*" | You gave another organization's address. Run `/opstracking-setup` with yours. |
| `This API token is invalid, expired or revoked.` | The connection expired or was revoked. Run `/opstracking-setup`. |
| `This token is read-only.` or `This token can't do that. …` | The connection wasn't allowed that kind of change. Run `/opstracking-setup` and tick it on the page. |
| `This token has made too many changes for now.` | A safety limit on how fast a connection can change things. Wait a little and ask again. |
| "Filed for approval — nothing has changed yet" | Working as intended: open the link the agent gives you (or **Settings → API tokens** in OpsTracking) and approve or decline it there. |
| `API tokens can't do this — sign in to the app instead.` | That action (deleting, voiding invoices, approving timesheets, role permissions, billing) is deliberately kept to people in the app. |

## Updating

Unzip the newer `opstracking-plugins.zip` over the same `opstracking-plugins` folder (or
replace `~/.cursor/plugins/local/opstracking` if you copied it in yourself),
then restart Cursor. Your connection is kept.

## Removing

Remove the plugin (and the marketplace) under **Settings → Plugins**, delete
the `opstracking-plugins` folder (or `~/.cursor/plugins/local/opstracking`
if you copied it in), restart Cursor; delete
`~/.opstracking/cursor.json`; and revoke the connection in **Settings →
Password & security → API tokens** (it is named "Cursor on *your
computer*").

## For a team: a private marketplace

On Cursor's Teams and Enterprise plans an admin can publish the plugin to the
whole team instead of everyone copying a folder: the unzipped folder already is
a marketplace, so push its contents to a private Git repository as they are,
then in **Dashboard →
Plugins & MCPs → Team Marketplaces** choose **Add Marketplace → Import from
Repo** and paste the repository's URL. Team members then install *OpsTracking*
from Cursor's plugin list. Each person still connects once from their own
browser, as above — nothing about the connection is shared.
