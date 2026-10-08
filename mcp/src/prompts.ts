import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Two prompts, both for work people repeat daily. Each ends in a proposal the
 * user confirms — neither writes on its own.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "triage-bug-report",
    {
      title: "Triage a bug report into a task",
      description: "Turns a pasted bug report into a proposed OpsTracking Bug task, then creates it once confirmed.",
      argsSchema: {
        report: z.string().describe("The bug report text: a message, email, ticket or log excerpt."),
        project: z.string().optional().describe("Project name, key or uuid, if known."),
      },
    },
    ({ report, project }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Triage this bug report into an OpsTracking task.",
              "",
              "1. " +
                (project
                  ? `Use the project "${project}". Call get_project to confirm it and read its statuses and members.`
                  : "Work out which project it belongs to (list_projects); if it is not clear, ask me."),
              "2. Check for an existing task on the same problem (list_tasks with a short q). If one exists, suggest a comment on it instead.",
              "3. Draft the task: a short imperative title; a markdown description with Summary, Steps to reproduce, " +
                "Expected, Actual and Environment (only what the report supports — write 'Unknown' rather than inventing); " +
                "type Bug; a priority with a one-line reason; no assignee unless the report names one.",
              "4. Show me the draft exactly as it would be created and wait for my confirmation.",
              "5. Only after I confirm, call create_task. Then give me the new task's handle.",
              "",
              "Bug report:",
              "<<<",
              report,
              ">>>",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "daily-standup",
    {
      title: "Daily standup summary",
      description: "Summarises yesterday's logged time and today's open tasks into a standup update. Read-only.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Write my standup update from OpsTracking. Read only — do not change anything.",
              "",
              "- Yesterday: list_time_entries for this week (and last week if today is Monday); use entries from my previous working day.",
              "- Today: list_tasks with assignee 'me', sorted by due; skip done tasks.",
              "- Blockers: my overdue tasks (list_tasks assignee 'me', overdue true).",
              "",
              "Format: three short sections (Yesterday / Today / Blockers), task handles in front of titles, hours per item.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
