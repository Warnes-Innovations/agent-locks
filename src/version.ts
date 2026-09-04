/**
 * The build identity every surface reports.
 *
 * WHY THIS IS NOT COSMETIC. An MCP server is a long-lived process: it is started once
 * per session and does NOT reload because `dist/` changed. So a fix can be committed,
 * tested, documented, and still absent from every session running on the machine — and
 * for two review rounds that is exactly what happened here, with sessions calling a
 * server days older than the code while the docs described the code.
 *
 * That was undetectable, because this constant sat at '0.1.0' through every hardening
 * round: no client could compare what it was talking to against what was installed.
 * A version that never changes is worse than none, because it looks like an answer.
 *
 * SO: bump this whenever the MCP surface or a documented behaviour changes, in the
 * same commit. `agent-locks --version` prints the INSTALLED build; the MCP handshake
 * reports the RUNNING one. If they differ, the session is holding a stale server and
 * must be restarted before any guarantee in the docs can be relied on.
 */
export const VERSION = '0.2.0';
