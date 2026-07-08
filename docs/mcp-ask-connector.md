# MCP Ask Connector

> Status: retired. This page is kept only to prevent old links from pointing
> at an implementation that no longer exists.

The MCP Ask connector belonged to the legacy chat architecture. It exposed a
separate "ask Alice" MCP server where outside agents could send messages into
Alice's in-process AI loop. That architecture has been removed:

- `AgentCenter`, `ProviderRouter`, `AgentWork`, and the in-process model loop
  are gone.
- `src/connectors/**`, Telegram/Web connector routing, and the old
  `notify_user`/MCP-Ask path are gone.
- `askMcpPort`, `McpAskPlugin`, `askWithSession`, `listSessions`, and
  `getSessionHistory` are not supported configuration or tools.

Current OpenAlice agent integration goes through workspaces:

- Native agent CLIs (`claude`, `codex`, `opencode`, `pi`, `shell`) run inside
  managed workspace sessions.
- Workspace agents get context and tools through workspace files, injected
  instructions/skills, `alice*` CLI shims, and workspace-scoped MCP where the
  adapter supports it.
- Agent-to-user push goes through Inbox (`alice-workspace inbox push`), not
  legacy chat connectors.
- Autonomous short tasks use headless workspace runs; the target trading
  steward behavior is a persistent workspace session with wake envelopes and a
  decision ledger.

For the current surfaces, start with:

- [openalice-agent-support.zh.md](openalice-agent-support.zh.md)
- [steward-workspace-behavior-contract.zh.md](steward-workspace-behavior-contract.zh.md)
- [../ANATOMY.md](../ANATOMY.md)
- [../src/ANATOMY.md](../src/ANATOMY.md)
