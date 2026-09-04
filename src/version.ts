/**
 * The single source of truth for this package's version.
 *
 * server.ts reports it over the MCP handshake and the CLI prints it for
 * `--version`. Both read THIS constant rather than each declaring their own,
 * because two hand-maintained copies drift and a version that disagrees with
 * itself is worse than none — a test pins it to package.json.
 */
export const VERSION = '0.2.0';
