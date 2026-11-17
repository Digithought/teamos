<!-- teamos -->
## TeamOS

This project uses [TeamOS](teamos/README.md) for AI team orchestration. The team workspace is in [team/](team/). See [teamos/agent-rules/cycle.md](teamos/agent-rules/cycle.md) for member cycle rules. A new message thread to a human member must carry `ask: "decide"` (one standalone, context-rooted question with a `default` and `defaultBy`; silence means the default goes ahead) or `ask: "fyi"`; replies need none. See [teamos/docs/messages.md](teamos/docs/messages.md#asks-messages-to-a-human).
