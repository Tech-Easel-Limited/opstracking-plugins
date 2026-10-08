---
name: opstracking-new-task
description: Draft an OpsTracking task from a short description or a pasted bug report, then create it after you confirm
---

Create an OpsTracking task from this request:

$ARGUMENTS

Follow the opstracking skill's rules. Work out the project (ask if unclear), check for a duplicate with
`list_tasks`, and draft the task — title, markdown description, type, priority, status, assignees,
dates and effort, leaving out anything the request does not support. If it reads like a bug report, use
the bug template (Summary, Steps to reproduce, Expected, Actual, Environment) and type Bug.

Show the draft exactly as it will be created and wait for my confirmation before calling `create_task`.

If nothing was filled in above, use what the user typed after the command in the chat.
