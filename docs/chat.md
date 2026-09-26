# Chat Architecture

TeamOS members run in cycles. Between cycles a member is not running at all — its identity is entirely the files on disk. That makes "talk to a member right now" awkward: until chat, the only way to reach one was to drop a message in its inbox and wait hours for the next cycle to pick it up.

**Chat** closes that gap from the dashboard. Starting a chat spawns a fresh agent holding the member's manifest, state, todos, schedule and inbox — the same context a cycle prompt assembles, and the same tools — minus the instruction to go do work. Every turn spawns a new agent; the transcript carried in the prompt is the session's memory. A chat instance can act on what the conversation decides, there and then. When the chat ends, a last wrap-up turn records what was decided in the member's state and todos, as a cycle would, and the conversation is archived as the record.

Chat is a dashboard feature, not an adapter. It adds nothing to the MCP surface and nothing to the runner.

## Design Principles

- **Always a fresh session; never attach to a running cycle.** A member mid-cycle is deep in a ticket. Injecting conversation into that context derails the work and pollutes the ticket's history. A freshly spawned instance given the manifest and state *is* the same member in every sense that matters — members are already stateless between cycles.
- **Chat neither defers nor blocks scheduled cycles.** The runner keeps its cadence while a chat is open; chat asks it for nothing and tells it nothing. A chat may open, run and finish entirely inside a cycle of the same member. There is no lease, no lock and no pause — see **Two Instances, One Member** below for why none is needed and what is left uncovered.
- **Same context, same tools.** A chat spawn gets the project's MCP servers and the built-in file tools exactly as a cycle does. A member that cannot act has to narrate its intentions to its next self, which is a worse failure mode than the race it was avoiding.
- **One chat per member.** A second concurrent chat with the same member is rejected with 409. Two chats would mean two transcripts of one member diverging in parallel, two agents billing the account, and no merge story for either. Note the asymmetry: chat-beside-cycle is allowed, chat-beside-chat is not — a cycle and a chat have different jobs and different records, two chats have the same job and two records.
- **A chat ends like a cycle.** Its last turn writes what was decided into state and todos. The transcript is archived as the record, not delivered, so the next cycle isn't spent re-reading a conversation the member already had.
- **The dashboard is the trust boundary.** These routes spawn processes. They add no listener and no auth of their own; they inherit the dashboard's. See **Security** below.

## Two Instances, One Member

A chat and a scheduled cycle for the same member can be running at the same moment. Both are Claude instances, both hold the same profile and state, and both can write. There is no lock anywhere in teamos. This section is the whole argument for why that is acceptable.

### What the tools already guarantee

Claude Code's own file tools implement optimistic concurrency, and they do it across processes because the check is against the filesystem, not against in-process bookkeeping:

- `Edit` requires the file to have been read first, and fails when `old_string` no longer matches what is on disk.
- `Write` refuses to overwrite a file the instance has not read.
- The harness notices when a file has changed on disk since it was read, and rejects the write.

`state.md` and `profile.md` — the files a chat is most likely to touch and the ones whose loss would hurt most — are edited exclusively through those tools. A second instance that tries to stomp the first instance's change is stopped, without a lease, a lock or a compare-and-swap. The loser is told the file moved, which is exactly the signal it needs.

This was true before chat existed. The read-only design was written on the assumption that the only protection was "exactly one process touches a member at a time", and that assumption was wrong in the direction of caution.

### What the tools do not cover

The JSON collections — `todo.json`, `schedule.json`, `inbox.json` / `sent.json` / `archives.json` — are never touched with `Edit` or `Write`. They are reached only through the teamos MCP tools, which read the file, modify a list in memory and write it back whole. Claude's read-before-write protection never sees them, and nothing else checks.

Almost every operation on them is additive: add a todo, add an event, deliver a message. For those, re-reading immediately before writing is enough — a concurrent add is lost only if the two writes interleave inside a single tick. So `addTodo`, `addEvent` and `_appendToMailbox` now validate, create the directory, then read and write back-to-back with **no `await` in between**. That is the whole fix. It is three functions and no new abstraction.

The non-additive operations — `updateTodo`, `completeTodo`, `archiveMessage`, `unarchiveMessage`, `acknowledgeDue` — are not protected, and deliberately so. Closing them honestly means a real compare-and-swap, which is a layer this codebase does not have and does not want for the sake of a race whose realistic outcome is one member archiving a message twice.

### What is left: semantics

No locking scheme prevents the actual remaining risk, which is that two instances of the same member each make a reasonable but conflicting decision. The chat instance drops a todo the cycle instance is halfway through; the cycle records "shipped the parser" in state while the chat records "parser blocked on review". Both writes succeed. Both are individually correct. Together they are nonsense.

That is a coordination problem, not a concurrency-control problem, and the defences against it are:

- `agent-rules/chat.md` tells the instance plainly that it is the second one, and how to behave: re-read before writing, append rather than rewrite a section someone else may have touched, and treat a rejected write as the other instance rather than as an obstacle.
- The mid-cycle indicator tells the human the same thing.
- The cycle-completion event and the changed-file list stop the chat instance answering from a picture that has gone stale.

None of this is enforcement. It is the honest position: the structural races are closed, the semantic one is managed, and a member that is bad at sharing a desk with itself will still occasionally make a mess.

## Session Lifecycle

```
POST /api/chat/sessions          → session created in the dashboard process (nothing on disk)
POST /api/chat/sessions/:id/turn → spawn agent, stream reply, append both turns to the transcript
   … repeat …
DELETE /api/chat/sessions/:id    → start the wrap-up turn, archive the transcript as the record, drop the session
```

A session is a transcript plus at most one running agent. It lives in the dashboard process's memory: restart the dashboard and open chats are gone, unfiled. Sessions idle for **30 minutes** are ended and filed on the next chat request, so a human who walks away mid-conversation still leaves the member something to read.

Each turn:

1. `buildChatPrompt` assembles the member's context and the conversation so far (see below).
2. `runAgent` spawns the configured agent with that prompt as its appended system prompt and the human's new message as its prompt.
3. The agent's stream-json output is parsed into events (`text`, `tool`, `thinking`, `result`) and streamed to the browser over SSE.
4. The human's message is recorded before the spawn and the member's answer after it, so a turn that crashes still shows up in the filed transcript.

Every turn re-sends the whole conversation, because every turn is a new process. A long chat costs more per turn than a short one — end a chat when it is done rather than leaving it open all afternoon.

## Leaving the Checkout Clean

A chat edits the same checkout the cycles do, often while one is running. The runner's leftover
check (`scripts/lib/leftovers.mjs`) resumes a member whose cycle left uncommitted changes. Without
help it would blame a concurrent chat's edits on whichever member's cycle was running.

So every turn snapshots the working tree before and after, and **claims** what it changed in
`team/.logs/leftover-claims.json`. A claim records the path and the signature the chat left it
with. The runner leaves claimed paths out of a cycle's leftovers for as long as they still carry
that signature. Once anyone changes such a path again, it's theirs.

When a chat ends, its wrap-up turn (see **Ending a Chat**) is told which claimed paths are still
uncommitted and asked to commit, stash or revert each one, the same rule a cycle follows. The
claims are then released, and anything still left is logged. Attribution is best-effort: a cycle edit that lands during a chat turn reads as the chat's.

## Prompt Assembly

`scripts/lib/chat/prompt.mjs` reuses the cycle prompt's own section builders (`buildInboxSection`, `buildTodoSection`, `buildScheduleSections` in `scripts/lib/cycle.mjs`), so a member never sees a different picture of itself in chat than in a cycle:

| Section | Same as a cycle? |
|---|---|
| Organization, memos, projects, roster | yes |
| Profile, state | yes |
| Todos, due events, upcoming events | yes |
| Inbox (with one hop of thread context) | yes |
| Commit triggers / watches fired | **no** — those are wake signals for a cycle, and acknowledging them is a cycle's job |
| Agent Tools (MCP) section | yes — the chat instance has the tools, so it is told about them |
| Cycle rules, "execute a cycle at priority X" | **no** — replaced by `agent-rules/chat.md` |
| Conversation so far | chat only |
| Files changed since the chat opened | chat only — see below |

`agent-rules/chat.md` is the chat counterpart of `agent-rules/cycle.md`. It tells the member it is a *second instance* of itself, that another instance may be working right now, to re-read before writing, to prefer appending over rewriting, and to treat a rejected write as the other instance rather than as something to force through.

## Ending a Chat

A chat is a session of the member, so it ends like one. Ending it (by the human, or by the idle
sweep) starts a **wrap-up turn** in the background: the same prompt as any turn, with the task
"wrap up the way you would at the end of a cycle". That means recording what was decided in
`state.md`, adding or updating todos for what's still open, and doing, or making a todo of,
anything promised. If the chat still claims uncommitted paths in the checkout (see **Leaving the
Checkout Clean**), the same turn lists them to commit, stash or revert. Its output goes to the
chat's log. The dashboard doesn't wait for it.

An earlier design delivered the transcript to the member's inbox instead. That was the wrong
mechanism. The member had already absorbed the conversation, and a message from the human would
cost another cycle to re-read what it already knew, and to act on whatever the chat left undone.
The wrap-up turn does that work while the context is still loaded.

## Transcript Record

The transcript is still filed as the record, as a message from the **human** to the **member**:

```
from:    <the dashboard identity>
to:      [<member>]
subject: Chat with <human> — <YYYY-MM-DD HH:MM>
body:    a preamble saying this is the archived record, then the full transcript
```

The member's copy is **archived at once** (`archiveMessage`), so it never wakes a cycle. The human
sees it in `sent.json`, and the conversation appears in the dashboard's threaded Messages view.
The whole transcript goes in the body. The master store is one markdown file per message, and a
body that pointed at another file would be a reference the retention sweep doesn't know about.

Two ways nothing is filed: a chat with no turns, and **Discard** (`?persist=0`). A discarded chat
records nothing in the member's state either, but if it left uncommitted edits in the checkout, its
last turn is asked to revert them, or to commit them if they're finished work.

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

This is an indicator for the human, not a lock, and it always was. **Nothing branches on it** — chat starts, turns and files exactly the same either way. It is worth reading as "the other you is awake", not as "you are waiting". The pane's copy says so. Chat's own logs live in `team/.logs/chat/` so they can never be mistaken for a cycle.

### Cycle completion, and what changed

The same prompt file is also the completion signal. `ChatSessions` records which of the member's cycle prompt files were live when the chat opened and polls every 5s; one that disappears means that cycle's `runAgent` reached its `finally`. Its sibling `.log` is then checked for `runAgent`'s closing line:

```
[runner] Agent exited with code <n>
```

That marker is written in the same `settle()` that resolves the run, so it means the cycle is genuinely over — a prompt file removed by hand or by a log sweep produces no marker and no event. When it fires:

- a `{ kind: 'cycle', event: 'completed', exitCode, at }` event goes out on the chat's SSE stream, which is the turn stream, so a human watching a reply in progress sees it immediately. When no turn is running, the pane's 15s status poll picks it up from `session.cycleCompletions` instead.
- the **next turn's prompt** gets a "Changed Since This Chat Opened" section listing the member's files written since the chat started.

A cycle that both starts and ends between two polls produces no event. That is deliberate rather than tolerated: the banner is a courtesy, while the changed-file list — the part that actually matters — is computed from mtimes, not from these events, so it is correct regardless of whether the banner fired.

**Why mtimes.** The question the next turn needs answered is "is what I said ten minutes ago still true?". Comparing each file in `team/members/<name>/` against the chat's start time answers that for one `stat` per file, with no journal to keep and nothing to keep in sync. It is coarse in both directions — a rewrite to identical bytes counts as a change, and a change irrelevant to this conversation counts too — and that is the right way to be wrong, because the remedy it prompts is a re-read, which is cheap. Content hashing would cost more and buy precision nobody needs. Only the member's own directory is walked: the team-wide files (org, memos, projects, roster) are reassembled into every turn's prompt anyway, so the instance already sees them fresh.

The section is framed as a warning about the *transcript*, not about the prompt. Everything above it was rebuilt moments ago and is current; the conversation below it was not.

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

Within that boundary, a chat session has the same reach a cycle does. That is a widening: before, the worst a reachable dashboard could do through chat was burn tokens reading. Now it can write the member's files. The mitigation is unchanged and unglamorous — the port is not reachable.

## Failure Modes

| What happens | What you see |
|---|---|
| Member not in `members.json` | `404` on start; nothing spawned |
| Agent binary missing / spawn fails | the turn rejects; the session stays open, not busy, and the human's message is already in the transcript |
| Agent exits non-zero with no output | `done` with the exit code, and the pane says the member ended the turn without saying anything |
| Client disconnects mid-turn | agent tree-killed; the human's message is kept, the partial answer is not |
| Second chat with the same member | `409`, with the start time of the one already open |
| A cycle for the member starts or finishes mid-chat | nothing blocks; a banner, and the next turn's prompt lists what changed |
| Chat and cycle edit the same file | the second writer's tool call is rejected (changed since read); the instance re-reads and reconciles |
| Second turn while one is running | `409` — one turn at a time per session |
| Dashboard restarted mid-chat | the session is gone and unfiled; the member never hears about it |
| Chat left open | filed automatically after 30 idle minutes |

## Future Work

Not built, deliberately:

- **A lease, lock or compare-and-swap layer.** See **Two Instances, One Member**: the built-in tools cover the files that matter, the JSON collections are cheap to make additively safe, and the residual risk is semantic — which no locking scheme addresses.
- **Atomic writes (write-tmp-then-rename) in the adapters.** Still worth doing on its own merits — it removes the torn-file window on a crash — but it is not what makes chat safe and it was not needed to get here.
- **Resuming a chat across a dashboard restart** would mean persisting sessions, which means a second on-disk shape for conversation state next to the one messages already have.
- **Joining a running cycle** stays off the table for the reason at the top of this document.
