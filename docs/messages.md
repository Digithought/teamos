# Messaging Architecture

TeamOS messages behave like email: a message can target multiple parties, carry a subject, and reference a preceding message to form a thread. The protocol is designed so it could later be backed by real email (SMTP/IMAP) without changing the agent-facing contract.

Only one adapter ships today: the **file adapter**, which stores messages on the local filesystem inside the `team/` workspace. The messaging interface (see "MCP Tools" below) is the stable contract; future adapters implement the same surface.

## Design Principles

- **Email-like semantics** — a message has `from`, `to`, `cc`, `subject`, `body`, and an optional `replyTo` back-pointer. To and Cc are delivered identically; they differ in how recipients perceive their involvement and in the priority the runner gives the message (see Work Detection).
- **Subjects are required** on new threads. Replies auto-derive `Re: <subject>` from their parent.
- **Threads are backward chains, not containers.** There is no thread object — a thread is simply the transitive closure of `replyTo` pointers. This matches how email works and keeps the data model flat.
- **Single master store.** Every message lives in one file under `team/messages/`, addressed by a unique id. Per-member mailboxes are just lists of ids; content is never duplicated.
- **Agent-managed inbox.** There is no unread pointer. A message is either in a member's `inbox.json` or their `archives.json` — never both. Members maintain their inboxes as part of their cycle work.
- **One hop of context is free.** `read_message(id)` inlines the immediately preceding message as a real nested object (same shape, minus its own parent). Deeper history is reached by calling `read_message` again with `parent.id`.
- **Ids are opaque to agents.** The format is an implementation detail. Agents pass ids through — they do not parse them.
- **A new thread to a human says what it wants.** Humans can't read everything the team writes. A new thread to a human member carries `ask: decide` (one question, with a default that goes ahead on silence) or `ask: fyi` (no attention needed). See [Asks](#asks-messages-to-a-human).
- **Supersede over stack.** When a sender has more to say to the same audience on the same topic, they consolidate via `supersede_message` instead of stacking another message. The new message points back via `supersedes: [...]`; each predecessor is rewritten with `supersededBy` and silently removed from any recipient inbox where it was still unread. Recipients who already archived the predecessor keep it (audit trail) and see the new message arrive separately. Listings collapse a predecessor whenever the consolidated version is reachable in the same mailbox.

## On-Disk Layout

```
team/
├── messages/
│   └── <id>.md               # master store — one file per message
└── members/
    └── <name>/
        ├── inbox.json        # { "items": ["<id>", ...] }
        ├── sent.json         # { "items": ["<id>", ...] }
        └── archives.json     # { "items": ["<id>", ...] }
```

### Message ID format

```
<isoTimestamp>-<4charRand>
```

Example: `2026-04-13T10-30-45.123Z-a3f2`

- ISO-8601 timestamp with colons replaced by hyphens for filesystem safety
- Four random base-36 characters to disambiguate concurrent sends in the same millisecond
- Lexically sortable by send time, which makes inbox listings and store browsing natural
- Agents never construct or parse these — `send_message` returns the id it assigned

### Message file format

Each `team/messages/<id>.md` is a markdown file with YAML-style frontmatter followed by the body:

```markdown
---
id: 2026-04-13T10-30-45.123Z-a3f2
from: alice
to: [bob, carol]
cc: [dave]
subject: Auth module review
sentAt: 2026-04-13T10:30:45.123Z
replyTo: 2026-04-12T18-05-12.000Z-9c1b
projectCode: AUTH
---
The auth module is ready for review. I've addressed the feedback from
yesterday's thread — see the updated token rotation logic in `auth/rotate.ts`.
```

Field reference:

| Field | Required | Description |
|---|---|---|
| `id` | yes | The message id (matches the filename) |
| `from` | yes | Sender member name |
| `to` | yes | Array of primary recipient member names |
| `cc` | no | Array of Cc'd member names; omit if none |
| `subject` | yes | Thread subject; auto-derived as `Re: ...` for replies |
| `sentAt` | yes | ISO-8601 timestamp |
| `replyTo` | no | Id of the immediately preceding message; omit to start a new thread |
| `supersedes` | no | Array of prior message ids this message consolidates / replaces. Set when the message was created via `supersede_message`. |
| `supersededBy` | no | Id of a later message that supersedes this one. Written by the adapter when `supersede_message` runs; never set by the original sender. |
| `projectCode` | no | Optional project tag for filtering/grouping |
| `effort` | no | Human senders only — refused from an agent. Effort for the recipient cycle that handles this message (`low`…`max`). See README § *Model and effort* |
| `ask` | see [Asks](#asks-messages-to-a-human) | `decide` or `fyi`. Required on a new thread (no `replyTo`) with a human member in `to`/`cc`, unless the sender is human. Absent on replies and on mail from before the rule (untagged). |
| `default` | with `ask: decide` | One line: what the sender will do if there is no answer |
| `defaultBy` | with `ask: decide` | ISO date (or date-time) after which the default goes ahead. A bare date runs to the end of that day, UTC. |
| `resolves` | no | Id of a `decide` this message closes, sent by the question's sender after its `defaultBy` passed, to say the default was applied |
| `resolvedBy` / `resolvedAt` / `resolution` | no | Written by the adapter onto a `decide` when it closes. `resolution` is `answered` (a human replied) or `default-applied` (the sender's `resolves`). |

### Mailbox files

Each member has three json files, all with the same shape:

```json
{ "items": ["2026-04-13T10-30-45.123Z-a3f2", "2026-04-12T18-05-12.000Z-9c1b"] }
```

- `inbox.json` — messages the member has received but not yet archived. Populated on send; pruned on archive.
- `sent.json` — append-only history of messages the member has sent. Used to locate the original when a reply cites it.
- `archives.json` — messages the member has explicitly archived. Read-only long-term reference.

A single message id may appear in many members' mailbox files (once in the sender's `sent.json`, once in each recipient's `inbox.json` or later `archives.json`). The master store holds exactly one copy of the content.

## Asks: messages to a human

Human members (`type: "human"` in `members.json`) get far more mail than they can read, and most of it does not need them. So the adapter holds a new thread to a human to one of two shapes, and the dashboard shows each where it belongs.

### The rule

A message that **starts** a thread (no `replyTo`) with a human member in `to` or `cc` must carry `ask`:

- **`decide`**: the sender needs one decision. Exactly one question per message. Don't assume the human is up to speed: root the question in its context, so it can be answered cold, in isolation. The body says what the thing is, where it lives (ticket path, file, message id, commit), what has happened so far, why it matters now, and the options, with a recommendation. The message also carries `default` (one line, at most 300 characters: what happens if the human says nothing) and `defaultBy` (an ISO date in the future). **Silence means the default goes ahead**, so the team never waits on the human.
- **`fyi`**: nothing is needed. The adapter files it straight to each human recipient's **archives**, never their inbox, and the dashboard shows it in the FYI digest. Agent recipients get it in their inbox as usual. Send these sparingly; most status belongs in the sender's own docs or with teammates.

Only initiated messages are held to this, but **adding a human to an existing thread counts as starting one**: a reply whose `to`/`cc` names a human who wasn't on the parent (its `from`, `to` or `cc`, or any human if the parent can't be read) is checked as initiated for that human. Otherwise **replies may be conversational**: they need no `ask` (one may still carry one, and is then checked the same way). Messages **from** a human are never checked, and any `ask` on them is dropped. Mail between agents needs no `ask`, and `ask: decide` to no human is refused. Messages written before the rule load as untagged and display as before. A team without a readable `members.json` has no humans, so nothing is checked.

`send_message` and `supersede_message` refuse a message that breaks the rule, with an error that says how to fix it. The dashboard answers such a send with a 400.

### Closing a decide

A `decide` stays open (in the human's **Needs you** view) until one of:

1. **The human replies in its thread.** A message from a human whose `replyTo` chain reaches an open `decide` put to them (the nearest one, up to 32 hops) closes it with `resolution: answered`.
2. **The sender applies the default.** Once `defaultBy` has passed with no answer, the sender sends `send_message({ resolves: <id>, to: [<human>], body: "Applied the default: ..." })`. It threads under the question (`replyTo` defaults to the question), is filed to the human's archives rather than their inbox, and closes the question with `resolution: default-applied`. `resolves` is refused before `defaultBy`, from anyone but the question's sender, on a message that isn't a `decide`, and on one already closed.

On closing, the adapter writes `resolvedBy`, `resolvedAt` and `resolution` onto the question (as it writes `supersededBy`) and moves it from its human recipients' inboxes to their archives. A superseded `decide` drops out of **Needs you**; to withdraw a question that went moot, supersede it with an `ask: fyi` saying so.

## MCP Tools

These are the tools the messaging adapter exposes to the agent. The contract is designed to be portable to a real email backend — the shape maps cleanly onto SMTP send + IMAP fetch/move.

### `send_message`

```
send_message({
  to: string[],          // required — primary recipients
  subject: string,       // required
  body: string,          // required — markdown
  cc?: string[],         // optional
  replyTo?: string,      // optional — parent message id
  projectCode?: string,  // optional
  ask?: 'decide' | 'fyi',// required on a new thread to a human (see Asks)
  default?: string,      // ask: decide only, required there
  defaultBy?: string,    // ask: decide only, required there — ISO date
  resolves?: string,     // id of your overdue decide whose default you applied
}) → { id: string, sentAt: string }
```

Allocates a new id, writes the message to the master store, appends the id to each recipient's `inbox.json` (both To and Cc) and to the sender's `sent.json`. If `replyTo` is set and no explicit `subject` is provided, the adapter derives `Re: <parent.subject>` (stripping any existing `Re: ` prefix to avoid stacking). Explicit subjects are used verbatim. An `ask: fyi` (or a `resolves`) from an agent goes to each human recipient's `archives.json` instead of their inbox; see [Asks](#asks-messages-to-a-human).

### `supersede_message`

```
supersede_message({
  supersedes: string[],  // required — ids of prior messages YOU sent
  to: string[],          // required — must cover every predecessor recipient
  body: string,          // required — markdown; the standalone replacement
  subject?: string,      // optional — defaults to the latest predecessor's subject
  cc?: string[],         // optional
  replyTo?: string,      // optional — usually omit
  projectCode?: string,  // optional
  ask?, default?, defaultBy?, // as for send_message (no resolves)
}) → { id, sentAt, supersededIds, unreadRemoved, alreadyDelivered }
```

Sends a new message that consolidates / replaces one or more earlier messages from the same sender. The adapter:

1. Validates every predecessor exists, was sent by the caller, and is not already superseded.
2. Validates the new `to`+`cc` covers every recipient any predecessor reached. (To narrow the audience, send a regular message instead.)
3. Allocates a new id and writes the consolidated message with `supersedes: [...]`.
4. Rewrites each predecessor's frontmatter to add `supersededBy: <newId>` (body untouched — the audit trail is preserved).
5. For every recipient of every predecessor: if the predecessor id is still in their `inbox.json`, removes it. If they already archived (or otherwise dropped) it, leaves their archives alone; their `list_archives` entry will surface `supersededBy` so they know.
6. Delivers the new message normally — appends to each recipient's `inbox.json` and to the sender's `sent.json`.

Return fields:

- `unreadRemoved` — number of `(predecessor, recipient)` pairs the adapter removed from inboxes (i.e. the recipient had not yet read the predecessor).
- `alreadyDelivered` — number of pairs where the predecessor was no longer in the inbox (already read or archived); those recipients see both messages with the supersede markers connecting them.

Recipients whose AI cycle had already fired between the original send and the supersede will already have processed the predecessor; they re-read the consolidated version on next cycle. The supersede is still strictly cheaper than another stacked message — the inbox holds one item, not two.

### `read_message`

```
read_message(id: string) → Message
```

Returns the full message plus its immediate parent inlined:

```
{
  id, from, to, cc, subject, sentAt, replyTo, projectCode, body,
  parent?: {
    id, from, to, cc, subject, sentAt, replyTo, projectCode, body
  }
}
```

`parent` is present whenever `replyTo` resolves to a message still in the store. To walk further back, the agent calls `read_message(parent.replyTo)`.

`read_message` is id-scoped, not mailbox-scoped: it will resolve any id in the master store, whether the caller has it in their inbox, sent, archives, or none of the above. Cross-mailbox lookups are how a sender retrieves a message from a reply whose parent they sent weeks ago.

### `list_inbox`

```
list_inbox() → InboxEntry[]
```

Returns summaries for every id in the caller's `inbox.json`, newest first:

```
{ id, from, to, cc, subject, sentAt, projectCode, hasParent, supersedes?, supersededBy?,
  ask?, default?, defaultBy?, resolves?, resolvedBy?, resolution? }
```

`hasParent` is `true` when `replyTo` is set, so the UI or agent can indicate "this is part of a thread" without fetching the full message. `supersedes` (when present) lists the predecessor ids that this message consolidates; `supersededBy` (when present) is the id of a later message that consolidates this one.

**Collapse rule:** an entry whose `supersededBy` target is reachable in the caller's inbox or archives is omitted from the listing — the consolidated version is the canonical one. If the consolidated version isn't reachable, the predecessor stays visible so the recipient never silently loses a message.

### `list_sent`

```
list_sent({ to?: string[] }) → SentEntry[]
```

Same shape as `list_inbox`, reading from `sent.json`. Pass an optional `to` filter to restrict to messages whose `to`+`cc` includes at least one of the named members — agents call this before composing to a recipient set they have already messaged this cycle, so they can spot threads that should be consolidated via `supersede_message` instead of stacked. Sent listings do **not** apply the supersede collapse — the sender sees their full history with `supersedes` / `supersededBy` markers.

### `list_archives`

```
list_archives() → InboxEntry[]
```

Same shape as `list_inbox`, reading from `archives.json`. Same collapse rule as `list_inbox`: an archived predecessor is hidden when the consolidated version is reachable in the same mailbox.

### `archive_message`

```
archive_message(id: string) → void
```

Moves `id` from `inbox.json` to `archives.json` atomically. No-op if the id is already archived. Errors if the id is not in the caller's inbox (to avoid silently archiving unrelated messages).

### `unarchive_message`

```
unarchive_message(id: string) → void
```

Inverse of `archive_message`. Useful when an agent archives prematurely and needs to put a message back in play.

## Cycle Integration

When the runner builds a cycle prompt for a member, it:

1. Calls `list_inbox(member)` to get inbox summaries (already collapse-aware — superseded predecessors are hidden when the consolidated version is reachable)
2. Calls `read_message(id)` for each entry to get the message with parent inlined
3. Embeds those messages in the prompt under an "Inbox" section — To-addressed mail first, then mail that only Cc's the member under its own lower-priority heading
4. Passes the MCP tools through so the agent can call `send_message`, `supersede_message`, `archive_message`, etc. during the cycle

The agent is expected to process each inbox message and then `archive_message` it if fully handled. Messages left in the inbox carry forward to the next cycle — this is the intended way to defer work ("I'll handle this later, keep it in my inbox"). Before composing a new message to a recipient set the agent has already messaged this cycle, the agent calls `list_sent({ to: [...] })` and prefers `supersede_message` over stacking another message on the same topic.

## Work Detection

A member has messaging work when their inbox listing (after the supersede collapse) holds a message at or above the priority being scanned. A message on which the member is in `to` is `pressing`; one on which they are only in `cc` is `today` (`CC_PRIORITY` in `scripts/lib/work-detection.mjs`), so Cc-only mail is served like a `today` todo — on that priority's weight and cadence — rather than waking the member for a pressing cycle. The collapse step requires reading each candidate's frontmatter, but inboxes are bounded and the cost is paid once per scheduling pass per member — not in a hot loop.

## Sender Semantics

When alice sends to `[bob]` with `cc: [carol]`:

1. A new id is allocated
2. The message file is written to `team/messages/<id>.md` with `to: [bob]` and `cc: [carol]`
3. `<id>` is appended to `bob/inbox.json` and `carol/inbox.json`
4. `<id>` is appended to `alice/sent.json`

Bob and Carol both receive the message through their inbox; neither can tell from the delivery path alone whether they were in To or Cc — they must inspect the message's `to` and `cc` fields to see their role. This matches email. The runner does read the role: bob's copy is pressing work, carol's waits as `today` work.

## Dashboard View

The agent contract above is flat on purpose — a thread is the transitive closure
of `replyTo`, and a mailbox is a list of ids. People cannot read that directly,
so the web dashboard reconstructs threads at read time over the same adapter:

- `GET /api/members/:name/threads` — walks each mailbox id back through the
  master store (pulling in ancestors that live in none of that member's
  mailboxes, flagged as context), then folds chains sharing a root subject into
  one conversation. Returns per-message `boxes` and `depth` so the UI can render
  the reply tree and say which mailbox each message came from.
- `POST /api/messages/batch` — bodies for a whole conversation in one request.
- `GET /api/members/:name/attention` — what a human member needs to see:
  `needs` (open `decide` messages put to them, from their inbox and archives,
  soonest `defaultBy` first, with `overdue` set once it has passed) and `fyi`
  (`ask: fyi` mail from the last 14 days, newest first). The **Needs you** page
  renders it: the open questions with sender, default and date (overdue ones
  highlighted), and the FYI digest grouped by day, collapsed. Messages in the
  mailbox carry `decide` / `fyi` badges, and a decide shows its default.

These are dashboard-only views. They add nothing to the MCP surface, the
supersede-collapse rule is applied exactly as `list_inbox` applies it, and an
adapter that implements the tools above gets the threaded view for free.

## Retention and Cleanup

The master store grows unbounded in v1. A later clerk pass will handle retention, likely as:

> Delete `team/messages/<id>.md` when `<id>` is absent from every member's `inbox.json`, `sent.json`, and `archives.json`.

This policy is safe by construction: a message is only reachable through a mailbox reference, so an id that no member references is unreachable and can be pruned. Timed retention (e.g. "delete archived messages older than 90 days") layers on top by first removing old ids from `archives.json` and then letting the reference-count sweep reclaim the store files.

Retention is deliberately deferred — the protocol works correctly without it, and teams can add pruning at whatever cadence fits their volume.

## Future Adapters

The MCP contract above is the stable surface. A future SMTP/IMAP adapter would:

- Map `send_message` → SMTP `MAIL FROM` / `RCPT TO` / `DATA`, using a hidden `X-TeamOS-Id` header to carry the TeamOS message id across the wire
- Map `list_inbox` → IMAP `SEARCH` / `FETCH` against the inbox folder
- Map `archive_message` → IMAP `MOVE` to an Archives folder
- Map `read_message(id)` → IMAP search on `X-TeamOS-Id`, falling back to `Message-ID` for inbound mail from outside the team
- Derive `replyTo` from `In-Reply-To` / `References` headers

Because the adapter contract is id-based and mailbox-operations are explicit, swapping the storage backend does not change the agent's mental model, the cycle prompt shape, or the runner's work-detection logic.
