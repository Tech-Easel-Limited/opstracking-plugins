#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redact } from "./redact.js";
import { createServer } from "./server.js";
import { printUsage, runConfig, runSetup } from "./setup.js";

// stdout is the protocol channel; anything human goes to stderr, and nothing
// that goes there ever includes the token.
async function main(): Promise<void> {
  const { server, configError } = createServer();
  if (configError) {
    process.stderr.write(
      `opstracking-mcp: not connected yet (${configError.message}) Ask your AI assistant anything about OpsTracking to connect from the browser.\n`,
    );
  }
  await server.connect(new StdioServerTransport());
}

const command = process.argv[2];
if (command === "setup") {
  void runSetup(process.argv.slice(3));
} else if (command === "config") {
  void runConfig(process.argv.slice(3));
} else if (command === "help" || command === "--help" || command === "-h") {
  printUsage();
} else {
  main().catch(fail);
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`opstracking-mcp: ${redact(message, process.env.OPSTRACKING_TOKEN)}\n`);
  process.exit(1);
}
