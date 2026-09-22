# Chat Architecture

TeamOS members run in cycles. Between cycles a member is not running at all — its identity is entirely the files on disk. That makes "talk to a member right now" awkward: until chat, the only way to reach one was to drop a message in its inbox and wait hours for the next cycle to pick it up.

**Chat** closes that gap from the dashboard. Starting a chat spawns a fresh agent holding the member's manifest, state, todos, schedule and inbox — the same context a cycle prompt assembles, minus the instruction to go do work. Every turn spawns a new agent; the transcript carried in the prompt is the session's memory. When the chat ends, the whole conversation is filed as a message in the member's inbox, and the member's **next cycle** acts on it.

Chat is a dashboard feature, not an adapter. It adds nothing to the MCP surface and nothing to the runner.

## Design Principles

- **Always a fresh session; never attach to a running cycle.** A member mid-cycle is deep in a ticket. Injecting conversation into that context derails the work and pollutes the ticket's history. A freshly spawned instance given the manifest and state *is* the same member in every sense that matters — members are already stateless between cycles.
- **Chat never defers or blocks scheduled cycles.** The runner keeps its cadence while a chat is open; chat asks it for nothing and tells it nothing. This is the hard constraint, and the next principle follows from it.
- **Read everything, write narrowly.** The chat session may read anything — manifest, state, todos, inbox, schedule, the host repo. Its **only** write is appending its own transcript, as one message through the messaging adapter. It does not write `state.md`, todos, schedule events, triggers, watches, or anything else.
- **…because there is no locking anywhere.** `tasks/file.mjs`, `messaging/file.mjs` and `state.mjs` are all plain read-modify-write over JSON. That is safe today only because exactly one process touches a member at a time. Chat breaks that invariant by existing, so it writes as little as it possibly can, and never while a cycle could be rewriting the same structure it is editing.
- **Actions land one cycle late, on purpose.** If a conversation produces a decision, it lands in the transcript message, and the next cycle executes it. Chat feels "one cycle behind" on actions and that is the design, not a gap to paper over with a second write path. Making chat write directly would first require atomic writes (write-tmp-then-rename) in the adapters; until those exist, a direct write is a silent lost update.
- **Enforcement, not etiquette.** A chat spawn gets no teamos MCP servers (`mcp: false`) and denies the workspace-writing built-ins (`readOnly: true` → `--disallowed-tools Write,Edit,MultiEdit,NotebookEdit,Bash,KillShell`). The rule holds even if the member decides to be helpful.
- **One chat per member.** A second concurrent chat with the same member is rejected with 409. Two chats would mean two transcripts of one member diverging in parallel, two agents billing the account, and no merge story for either.
- **The dashboard is the trust boundary.** These routes spawn processes. They add no listener and no auth of their own; they inherit the dashboard's. See **Security** below.

## Session Lifecycle

```
POST /api/chat/sessions          → session created in the dashboard process (nothing on disk)
POST /api/chat/sessions/:id/turn → spawn agent, stream reply, append both turns to the transcript
   … repeat …
DELETE /api/chat/sessions/:id    → send the transcript to the member's inbox, drop the session
```

A session is a transcript plus at most one running agent. It lives in the dashboard process's memory: restart the dashboard and open chats are gone, unfiled. Sessions idle for **30 minutes** are ended and filed on the next chat request, so a human who walks away mid-conversation still leaves the member something to read.

Each turn:

1. `buildChatPrompt` assembles the member's context and the conversation so far (see below).
2. `runAgent` spawns the configured agent with that prompt as its appended system prompt and the human's new message as its prompt.
3. The agent's stream-json output is parsed into events (`text`, `tool`, `thinking`, `result`) and streamed to the browser over SSE.
4. The human's message is recorded before the spawn and the member's answer after it, so a turn that crashes still shows up in the filed transcript.

Every turn re-sends the whole conversation, because every turn is a new process. A long chat costs more per turn than a short one — end a chat when it is done rather than leaving it open all afternoon.

## Prompt Assembly

`scripts/lib/chat/prompt.mjs` reuses the cycle prompt's own section builders (`buildInboxSection`, `buildTodoSection`, `buildScheduleSections` in `scripts/lib/cycle.mjs`), so a member never sees a different picture of itself in chat than in a cycle:

| Section | Same as a cycle? |
|---|---|
| Organization, memos, projects, roster | yes |
| Profile, state | yes |
| Todos, due events, upcoming events | yes |
| Inbox (with one hop of thread context) | yes |
| Commit triggers / watches fired | **no** — those are wake signals for a cycle, and acknowledging them is a cycle's job |
| Agent Tools (MCP) section | **no** — a chat session has no tools to describe |
| Cycle rules, "execute a cycle at priority X" | **no** — replaced by `agent-rules/chat.md` |
| Conversation so far | chat only |

`agent-rules/chat.md` is the chat counterpart of `agent-rules/cycle.md`: it tells the member it may read anything, may write nothing, and that anything actionable must be said plainly in the reply because the next cycle reads its words, not its intentions.

## Transcript Persistence

Ending a chat calls `sendMessage` on the messaging adapter, from the **human** to the **member**:

```
from:    <the dashboard identity>
to:      [<member>]
subject: Chat with <human> — <YYYY-MM-DD HH:MM>
body:    a preamble saying nothing was applied, then the full transcript
```

The whole transcript goes in the body. The master store is already one markdown file per message with no size rule (`teamos/docs/messages.md`), and a body that pointed at some other file would be a reference the adapter doesn't know about — the retention sweep that prunes unreferenced messages would happily orphan it. One message, one copy, and the member's next cycle reads it through `list_inbox` / `read_message` like any other mail. Cost: a very long chat makes a very long next-cycle prompt.

The human sees it in their `sent.json`, and the conversation shows up in the dashboard's threaded Messages view. It is an ordinary message, not a side channel.

Two ways nothing is filed: a chat with no turns, and **Discard** (`?persist=0`), which drops the session without writing.

**This one append is a read-modify-write**, like every other mailbox operation: it reads `inbox.json`, appends an id, writes it back. A cycle archiving a message in the same few milliseconds can lose one of the two edits. The window is small and the fix is not local to chat — it is atomic writes in the adapters. Until then this is the single race chat accepts, and it accepts exactly one.

## Which Account Pays

Credentials are not a teamos concept: the Claude CLI reads its own env (`CLAUDE_CODE_OAUTH_TOKEN`, falling back to `ANTHROPIC_API_KEY`) and the runner simply inherits whatever the process was started with. Chat follows the same rule, plus one override so conversation tokens need not land on the account the automated cycles are burning:

```json
{
  "chat": {
    "agent": "claude",
    "env": { "CLAUDE_CODE_OAUTH_TOKEN": "$TEAMOS_CHAT_OAUTH_TOKEN" }
  }
}
```

- `chat.agent` — agent adapter for chat spawns. Defaults to the top-level `agent`.
- `chat.env` — env vars layered over the inherited environment, for chat spawns only. `$VAR` values are resolved from the environment like everywhere else in `teamos.config.json`; a `$VAR` that is unset is dropped with a warning rather than exported literally, because a token whose value is the string `"$FOO"` fails in a way that reads like a CLI bug. Secrets go in env vars, never in the config file.

The default shipped config is `{ "agent": "claude", "env": {} }` — chat bills the same account as the cycles, which is the least surprising behaviour for a single-account install.

## Mid-Cycle Indicator

The chat pane shows whether a scheduled cycle is in flight for the member. There is no runner-side registry to ask and chat deliberately opens no channel to the runner, so `detectMidCycle` reads a side effect instead: `runAgent` writes `<member>.<priority>.<ts>.prompt.md` next to the cycle log before spawning and unlinks it in a `finally`. Present and recent (< 1 hour) means "a cycle is running"; older means a runner was killed without cleaning up.

This is an indicator for the human, not a lock. **Nothing branches on it** — chat starts, turns and files exactly the same either way. Chat's own logs live in `team/.logs/chat/` so they can never be mistaken for a cycle.

## HTTP Surface

All dashboard-only, all under `/api/chat`. None of it is visible to agents.

| Route | Purpose |
|---|---|
| `GET /api/chat/status?member=<name>` | `{ midCycle, since?, session }` — drives the pane's banners; also runs the idle sweep |
| `POST /api/chat/sessions` | `{ member, human }` → the new session. `404` unknown member, `409` a chat is already open, `400` no identity |
| `POST /api/chat/sessions/:id/turn` | `{ text }` → SSE stream of `{ kind: 'text' \| 'tool' \| 'thinking' \| 'result' \| 'done' \| 'error' }` |
| `GET /api/chat/sessions/:id` | the session and its transcript (how a reloaded tab re-adopts a chat) |
| `DELETE /api/chat/sessions/:id[?persist=0]` | end the chat; files the transcript unless `persist=0` |

The turn is a POST because it carries the human's text, which rules out `EventSource`; the client reads the SSE frames off the response body directly. If the client disconnects mid-stream — tab closed, navigation, Stop — the server aborts the turn and tree-kills the agent rather than leaving it running to bill out the 10-minute idle timeout.

## Security

The chat routes spawn agent processes with `--dangerously-skip-permissions`, exactly as cycles do. That makes the dashboard a remote-code-execution surface for anyone who can reach its port.

Chat adds **no** new listener, binds nothing, and changes nothing about `auth` handling in `teamos.config.json`. It relies entirely on the existing deployment rule (`teamos/docs/auth.md`): the dashboard listens only on an interface reachable through the auth proxy or the tailnet, never `0.0.0.0` on a public host.

**That binding is now load-bearing.** Before chat, reaching the dashboard port meant reading team state and sending messages. With chat, it means starting processes on the host. Same rule as before, higher stakes: keep it on the tailnet, and keep `trustProxy` honest about what actually sits in front of the port.

Within that boundary, a chat session is still the narrowest thing that can hold a conversation: no MCP servers, no file-writing tools, and one append to one mailbox at the end.

## Failure Modes

| What happens | What you see |
|---|---|
| Member not in `members.json` | `404` on start; nothing spawned |
| Agent binary missing / spawn fails | the turn rejects; the session stays open, not busy, and the human's message is already in the transcript |
| Agent exits non-zero with no output | `done` with the exit code, and the pane says the member ended the turn without saying anything |
| Client disconnects mid-turn | agent tree-killed; the human's message is kept, the partial answer is not |
| Second chat with the same member | `409`, with the start time of the one already open |
| Second turn while one is running | `409` — one turn at a time per session |
| Dashboard restarted mid-chat | the session is gone and unfiled; the member never hears about it |
| Chat left open | filed automatically after 30 idle minutes |

## Future Work

Not built, deliberately:

- **Direct writes from chat** (adding a todo mid-conversation) need atomic writes in `tasks/file.mjs`, `messaging/file.mjs` and `state.mjs` first — write-tmp-then-rename at minimum, and a real answer for the read-modify-write window at best. Until then the transcript is the only write.
- **Resuming a chat across a dashboard restart** would mean persisting sessions, which means a second on-disk shape for conversation state next to the one messages already have.
- **Joining a running cycle** stays off the table for the reason at the top of this document.
