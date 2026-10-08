---
name: opstracking-standup
description: Write today's standup update from your OpsTracking time and tasks (read-only)
---

Write my standup update from OpsTracking. This is read-only — do not create or change anything.

- Yesterday: `list_time_entries` for this week (and last week when today is Monday); use my previous
  working day's entries.
- Today: `list_tasks` with assignee `me`, sorted by due date, leaving out done tasks.
- Blockers: `list_tasks` with assignee `me` and `overdue: true`.

Three short sections — Yesterday / Today / Blockers — with task handles in front of titles and hours per item.
