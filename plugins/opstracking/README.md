# OpsTracking plugin for Claude Code and Cursor

Work with OpsTracking
from your AI assistant: look up projects, board tasks, logged time, clients,
people, assets and invoices, and — only for what you allow when you connect —
create and update projects, teams, clients, tasks, time entries, assets and
invoice drafts. The assistant shows every change and waits for your "yes"
before making it.

Inviting people, changing project members or roles, sending an invoice,
marking it paid and submitting a timesheet are only ever **requests**: the
assistant files one and gives you a link, and nothing happens until you
approve it in OpsTracking. Nothing can be deleted through the plugin.

## Requirements

- An OpsTracking account
- Node.js 20 or newer (`node -v`)
- Claude Code (CLI, desktop app Code tab or IDE extension) or Cursor

## Connect

Run `/opstracking:setup` in Claude Code or `/opstracking-setup` in Cursor —
or just ask something about OpsTracking.

1. Give your organization's OpsTracking address, as you open it in the
   browser (for example `https://your-company.neoeasel.com`).
2. A browser tab opens. Sign in if asked, tick what the connection may
   change (nothing ticked means read-only), choose how long it lasts and
   approve with your password.
3. Go back to the assistant and ask again.

The token goes straight from the browser to your computer and never appears
in the chat. **Never paste a token into the chat.**

## Example prompts

- "What's on my plate in OpsTracking today?"
- "Turn this bug report into a task in the WEB project: …"
- "Log 2h 30m on WEB-12 for yesterday and show me this week's total."
- "Draft an invoice for Acme from last month's logged hours and preview it."
- "Invite sam@example.com to the Delivery workspace as a Member." (filed for your approval)

## Commands

| Claude Code | Cursor | What it does |
| --- | --- | --- |
| `/opstracking:setup` | `/opstracking-setup` | Connect, reconnect or move to a new address |
| `/opstracking:standup` | `/opstracking-standup` | Yesterday / Today / Blockers from your time and tasks (read-only) |
| `/opstracking:new-task` | `/opstracking-new-task` | Draft a task from a description or bug report, create it after you confirm |

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No OpsTracking tools | Check the plugin is enabled and restart the app; check `node -v` is 20 or newer. |
| No browser tab opened | The assistant also shows the link — open it on this computer within 10 minutes. |
| `This API token is invalid, expired or revoked.` | Run setup again. |
| `This token can't do that.` | The connection wasn't allowed that change. Run setup again and tick it. |
| "Filed for approval — nothing has changed yet" | Working as intended: approve or decline it in OpsTracking. |

## Privacy and removal

The plugin talks only to your OpsTracking address and sends no telemetry —
see [PRIVACY.md](https://github.com/Tech-Easel-Limited/opstracking-plugins/blob/main/PRIVACY.md).
To remove it, uninstall the plugin, delete `~/.opstracking/`, and revoke the
connection in OpsTracking under **Settings → Password & security → API tokens**.

Support: [GitHub issues](https://github.com/Tech-Easel-Limited/opstracking-plugins/issues).
