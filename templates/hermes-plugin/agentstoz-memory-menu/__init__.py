"""Menu-only metadata for AgentsToZ project-memory skills.

Hermes renders plugin commands ahead of alphabetically sorted skill commands.
Telegram sends BotCommand names with underscores even when the canonical skill
slug contains hyphens.  Register that wire form so gateway command recognition,
access control, hooks, and skill dispatch all agree on the same invocation.

A ``None`` handler is intentional: gateway dispatch then falls through to the
existing skill command, so the full conversation-aware skill still runs.
"""

# AgentsToZ memory-agent-version:15

_COMMANDS = {
    "remember-session": "Save this conversation into the bound project memory.",
    "memory-link": "Bind this Telegram topic to registered project memory.",
    "memory-start": "Create standalone memory for this Telegram topic.",
    "project-start": "Create a project folder in a workspace root and bind it.",
    "project-clone": "Clone GitHub, initialize memory, and bind this topic.",
    "project-from-memory": "Restore an existing memory ID into a new project.",
    "memory-status": "Show the memory binding and synchronization state.",
    "memory-sync": "Safely reconcile the bound local and remote memory.",
    "memory-unlink": "Disconnect this Telegram topic from project memory.",
    "hermes-open": "Open the bound project folder in Hermes Desktop.",
}


def register(ctx) -> None:
    for name, description in _COMMANDS.items():
        wire_name = name.replace("-", "_")
        ctx.register_command(wire_name, handler=None, description=description)
