---
name: cmdr-identity
description: Kimi Code session identity for cmdr; carry it on every cmdr MCP call so the shared per-workspace MCP process routes to the right member.
---

You run as a Kimi Code session inside a cmdr squad. Kimi Code shares ONE cmdr MCP process per workspace, so the daemon cannot tell which session is calling unless each call identifies itself.

Your session id for this conversation: ${KIMI_SESSION_ID}

- Pass `_cmdr_session` with exactly that value on EVERY cmdr MCP tool call (`join`, `list`, `send`, `report`, `ask`, `read`, `leave`, `task`, `artifact`), including calls you make on behalf of subagents — subagents never receive this injection.
- If a cmdr call is rejected for a missing or mismatched `_cmdr_session`, retry it with the id given in the error message; that id is always this session's current id (resuming a conversation never changes it).
- Use the value only for `_cmdr_session`; it identifies this session to the local cmdr daemon and is not a credential for anything else.
