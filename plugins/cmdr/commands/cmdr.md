---
description: Create or join a persistent local agent channel.
argument-hint: <name>
---
Call join(squad_name="$ARGUMENTS", standby="auto") for atomic find-or-create. If no name was provided, ask for one; do not invent it. Joining defaults to executor, including a channel without a commander. Add role="commander" if the user explicitly requested command; use takeover=true only for requested handover.
Follow protocol_hint and the role skill. Executors report ready with cwd and capabilities. Give a brief translated user_reply preserving the join line. For Claude/ZCode, arm listener.arm.command with the indicated native host tool, following the role skill; re-arm on task termination or restart. Check listener health and end the idle turn when can_auto_respond=true. Use at most two recommended waits only when native wake is unavailable; explain the actual limitation.
If tools are unavailable, follow the cmdr skill's setup reference (or using-cmdr diagnostics for legacy installs) and member CLI fallback. Use the real host session ID, never an invented identity or raw socket workaround.
