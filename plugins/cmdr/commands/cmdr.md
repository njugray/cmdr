---
description: Create or join a named local agent squad.
argument-hint: <name>
---
Call the cmdr join tool with squad_name="$ARGUMENTS". This is an atomic find-or-create operation; do not list then create. If no name was provided, ask for one. Do not invent a name.
If the squad is orphaned, ask whether to take over as commander or join as executor and then use explicit role and squad ID.
Follow the returned protocol_hint. An executor reports ready with cwd, capabilities and context before replying. Translate user_reply into the user's language, keep the join line unchanged, and reply with only that text. Then use read(wait=me.recommended_wait) to participate.
