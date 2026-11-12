# Memos

Memos (`team/memos.json`, typed in `teamos/templates/memos.d.ts`) are team-wide notices: every unexpired memo is in every member's cycle and chat prompt. Because the same memos reappear cycle after cycle, the runner tells each member which ones it has not yet seen, so a member never has to work out from its own history whether it already acted on one. Implementation: `teamos/scripts/lib/memos.mjs`.

## Seen tracking

Each member has a mark at `team/.logs/memos/<name>.json` (`{ "seenThrough": "<ISO>" }`), outside the synced tree like watch observations. A memo's time is `revisedAt ?? postedAt`.

- **NEW** — `postedAt` is after the mark, or the member has no mark yet.
- **REVISED** — posted before the mark, `revisedAt` after it.
- **Seen** — everything else, plus any memo whose `authorName` is the member itself, plus any memo with no parseable time (nothing could ever acknowledge it).

The prompt shows NEW and REVISED memos in full and seen ones as a title line; the full text stays in `memos.json`.

**Acknowledgement.** After a cycle exits cleanly, the mark advances to the latest memo time *that cycle's prompt showed* — not to "now", so a memo posted mid-cycle is still NEW next time. A failed cycle leaves the mark where it was, and the same memos are marked again (at-least-once, as with watches). A chat reads the mark but never advances it: a chat is not a cycle, and its wrap-up does not stand in for one.

Because the mark is a single time rather than a per-memo ledger, a memo added with a `postedAt` earlier than the mark — backdated, or written by hand with a stale time — is treated as seen. Write `postedAt` as the actual time of posting.

## Revisions

The dashboard stamps `revisedAt` when an edit changes a memo's title, content or importance; changing only its expiry or projects does not, so housekeeping does not re-surface a memo. Agents editing `memos.json` directly should do the same.

## Waking

An unseen memo at `importance: "critical"` counts as `pressing` work and one at `"high"` as `today` work for every member (work detection, `memberHasWork`), so it reaches members with nothing else queued instead of waiting for their next daily check-in. `medium` and `low` memos wake no one; they are marked NEW in whatever cycle the member next runs.
