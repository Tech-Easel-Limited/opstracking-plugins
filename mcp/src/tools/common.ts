import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Access, ToolGate } from "../access.js";
import { ConfigError } from "../config.js";
import { NotConnectedError } from "../connection.js";
import { redact } from "../redact.js";
import type { Session } from "../session.js";

/**
 * What every tool module receives. `session()` throws `NotConnectedError`
 * while there is no usable address or token, so each tool answers with how to
 * connect instead of the server failing to start where nobody sees it.
 */
export type ToolContext = {
  server: McpServer;
  session: () => Session;
  /** The token, for redacting results — never sent anywhere but the API. */
  token: () => string | undefined;
  /** Shows each tool only while the token and its owner allow it. */
  gate: ToolGate;
};

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** The arguments every workspace-scoped tool takes. */
export const workspaceArg = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace uuid or exact name. Defaults to OPSTRACKING_WORKSPACE, else the first workspace."),
};

export const pagingArgs = {
  page: z.number().int().min(1).optional().describe("Page number, starting at 1. Default 1."),
  size: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(`Rows per page, 1–${MAX_PAGE_SIZE}. Default ${DEFAULT_PAGE_SIZE}.`),
};

export const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const writeHints = (idempotent: boolean): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: idempotent,
  openWorldHint: false,
});

/** Appended to every write tool's description. */
export const CONFIRM_FIRST =
  "WRITE ACTION: before calling, show the user exactly what will be created or changed and get their explicit " +
  "confirmation.";

/**
 * Appended to every approval-request tool's description. Filing is itself a
 * write — it puts a request in front of the person — so it is confirmed like
 * one; and the act it asks for happens only when they approve it in the app.
 */
export const REQUEST_FIRST =
  "APPROVAL REQUEST: this does NOT do the act. It files a request that the user approves or declines in the " +
  "OpsTracking app, and nothing happens until they do. Before calling, show the user exactly what will be " +
  "requested and get their explicit confirmation. Afterwards give them the approval link, and never say the act " +
  "is done — get_agent_request tells whether it was approved.";

export function result(text: string, structured: Record<string, unknown>, token?: string): CallToolResult {
  // Redacted as a whole: the structured copy is serialised text too.
  const safe = JSON.parse(redact(JSON.stringify(structured), token)) as Record<string, unknown>;
  return { content: [{ type: "text", text: redact(text, token) }], structuredContent: safe };
}

export function failure(err: unknown, token?: string): CallToolResult {
  let message: string;
  if (err instanceof NotConnectedError) {
    message = err.message;
  } else if (err instanceof ConfigError) {
    message = `OpsTracking is not configured: ${err.message}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { isError: true, content: [{ type: "text", text: redact(message, token) }] };
}

/** Runs a handler, turning anything it throws into an error result. */
export function guarded<A>(
  ctx: ToolContext,
  handler: (args: A, session: Session) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args, ctx.session());
    } catch (err) {
      return failure(err, ctx.token());
    }
  };
}

export type ToolSpec<S extends z.ZodRawShape> = {
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  /** When the tool is shown: the scope and the permission it needs (src/access.ts). */
  access: Access;
};

/** Registers one tool with its handler behind `guarded`, and hands it to the gate. */
export function defineTool<S extends z.ZodRawShape>(
  ctx: ToolContext,
  name: string,
  spec: ToolSpec<S>,
  handler: (args: z.infer<z.ZodObject<S>>, session: Session) => Promise<CallToolResult>,
): void {
  const run = guarded(ctx, handler);
  // Widened to the plain shape type: the SDK's callback typing is a
  // conditional type that TypeScript cannot resolve over a generic `S`. The
  // SDK has already validated `args` against `inputSchema` when this runs.
  const inputSchema: z.ZodRawShape = spec.inputSchema;
  const { title, description, annotations, access } = spec;
  const tool = ctx.server.registerTool(
    name,
    { title, description, inputSchema, annotations: { title, ...annotations } },
    (args) => run(args as z.infer<z.ZodObject<S>>),
  );
  ctx.gate.add(name, tool, access);
}

export const pageOf =(args: { page?: number; size?: number }) => ({
  page: args.page ?? 1,
  size: args.size ?? DEFAULT_PAGE_SIZE,
});
