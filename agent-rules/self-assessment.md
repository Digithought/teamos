# Weekly Self-Assessment

It's time for an honest review of your effectiveness over the past week. This is not a status update — it is a reflective evaluation of *how well* you are performing your role.  This isn't just generating a document though, it is primarily a chance to *make changes* to your state, tasks, events, etc. in order to affect positive change going forward.

The runner has already queued next week's self-assessment automatically — you do not need to call `update_event` to bump the `time` forward.

Save the assessment to `team/members/<your name>/archives/assessments/YYYY-MM-DD.md` (create the directory if needed).

## State budget check — mechanical, do this first

Run `wc -l -c team/members/<your name>/state.md` and compare against the 16 KB budget (`teamos/agent-rules/cycle.md` § Guidelines). Do this every week regardless of how the file looked last time — size creeps back up between assessments even after a clean rollup.

If it's over budget:

1. Archive the current file verbatim to `team/members/<your name>/archives/state-history/<YYYY-MM-DD>-pre-rollup.md`.
2. Write a new `state.md` under 16 KB holding only the current picture — recent work, open threads (with message ids), what you're waiting on, and a pointer to your doc index. Sort everything else rather than dropping it: reusable knowledge (procedures, past decisions and their reasons, recurring gotchas) goes into `team/docs/<topic>/` — create or extend a doc there, keep its folder's `index.md` current, and make sure the top-level `team/docs/index.md` lists the folder; finished narrative nothing needs again stays in the archive from step 1.
3. Do this before the ratings below. An assessment that finds `state.md` over budget and doesn't fix it in the same pass cannot score "State, Tasks & Schedule Hygiene" above 2 — the fold is the point of this assessment existing, not an optional action item for "next week."

## Assessment Format

Use the template below. Rate each area 1-5 (1 = poor, 5 = excellent) and provide a brief justification with specific examples. Be candid — the point is continuous improvement, not self-congratulation.

```markdown
# Self-Assessment — <Your Name> — YYYY-MM-DD

## Role Fulfillment (1-5)
Am I fulfilling my job description? Am I delivering on what my role demands?

## Strategic vs Tactical Balance (1-5)
Am I attending to both big-picture goals and day-to-day execution? Am I getting lost in minutiae or neglecting important details?

## Cycle Efficiency (1-5)
Am I making good use of each cycle? Am I doing right-sized units of work — not too little (wasting context overhead) and not too much (overrunning context)?

## Tool & Document Effectiveness (1-5)
Am I building reusable tools (scripts, libraries) where appropriate? Am I maintaining useful documentation in team/docs/ and team/data/? Am I referencing and improving existing tools rather than reinventing?

## State, Tasks & Schedule Hygiene (1-5)
- **State**: Start from the State budget check above — is `state.md` under 16 KB, and did anything moved out of it actually land in a `team/docs/<topic>/` doc (with its folder's `index.md` updated) rather than just get deleted? Beyond size: is it current and useful, or stale? Don't overly condense either — if something doesn't need to be remembered every cycle, the test is whether it's findable from the doc index, not whether it still fits in state.md.
- **Tasks**: Are my todos well-prioritized, correctly labeled, and kept clean? Am I using `update_todo` / `complete_todo` to keep the list actionable, not stale?
- **Schedule**: Am I using schedule events effectively for deferred work instead of leaving unactionable items at high priority?

## Communication Quality (1-5)
Am I communicating effectively with other members? Am I over- or under-communicating?

## Project Impact (1-5)
Am I making meaningful progress on assigned projects? Are my contributions moving the team closer to its goals?

## Key Accomplishments
- (list 3-5 concrete things completed this week)

## Areas for Improvement
- (list 1-3 specific, actionable improvements for next week)

## Action Items
- (concrete steps to address the improvements above)
```

From here, make whatever adjustments to state, tasks, events, or other docs or context are needed to try to affect improvement.  If a change to your profile would help, raise it with your manager.

## Guidelines

- **Be specific.**
- **Reference your archives.** Look at your recent state history and archives to ground the assessment in facts.
- **Track trends.** 
- **Keep it brief.** The assessment should take a single cycle. Don't over-analyze — identify and address the top signals and move on.
- **Send a summary.** After saving the full assessment, call `send_message` with your manager in `to`, a subject like `"Weekly self-assessment — YYYY-MM-DD"`, and a brief body listing your overall scores and planned improvements.
