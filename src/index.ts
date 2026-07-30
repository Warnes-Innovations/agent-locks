#!/usr/bin/env node
/**
 * Module: agent-locks entrypoint — dispatches between the stdio MCP server
 * and the human-facing CLI (cli.ts) based on argv.
 *
 * An MCP client (e.g. Claude Code) spawns this exactly as documented in
 * README ("args": ["dist/index.js"]) — with NO extra arguments. That is the
 * signal used to distinguish the two modes: no arguments (or the explicit
 * "serve" alias) starts the MCP server over stdin/stdout; any other first
 * argument is treated as a CLI subcommand. This keeps every existing MCP
 * client config working unchanged while adding `agent-locks status`,
 * `agent-locks claim`, etc. for a human at a terminal or a harness that
 * shells out instead of speaking MCP.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { runCli } from './cli.js';

async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isServerMode = argv.length === 0 || argv[0] === 'serve';
  if (isServerMode) {
    await runServer();
    return;
  }
  const exitCode = await runCli(argv);
  process.exitCode = exitCode;
}

main().catch((error) => {
  // stdout is reserved for the MCP JSON-RPC channel when in server mode;
  // stderr is safe in both modes and is what Claude Code surfaces for a
  // stdio server's diagnostic output.
  process.stderr.write(`agent-locks: fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
