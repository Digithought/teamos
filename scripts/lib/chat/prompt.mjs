import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInboxSection, buildScheduleSections, buildTodoSection } from '../cycle.mjs';
import { buildToolsPromptSection, formatTimestamp, readTextOrEmpty } from '../util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMOS_ROOT = join(__dirname, '..', '..', '..');

/**
 * Build the system prompt for one chat turn.
 *
 * Deliberately the cycle prompt minus the cycle: same organization, profile,
 * state, todos, events and inbox (assembled by the same helpers in cycle.mjs,
 * so a member never sees a different picture of itself in chat than in a
 * cycle), and the same MCP tools — minus only the "do a unit of work now"
 * framing. A chat instance can act on what the conversation decides; see
 * teamos/docs/chat.md for why that is now safe enough.
 *
 * The conversation so far is appended, and the human's new turn is passed to
 * the agent as its prompt. Every turn spawns a fresh agent, so the transcript
 * carried here *is* the session's memory — and the only part of this prompt
 * that can be stale, which is what `changedFiles` is for.
 *
 * @param {{ name: string, title?: string }} member
 * @param {string} teamDir
 * @param {Object} adapters - messaging / tasks / schedule (same objects the runner uses)
 * @param {Object} opts
 * @param {string} opts.human - Name of the human on the other end
 * @param {Array<{ role: 'human'|'member', text: string, at: string }>} [opts.transcript]
 * @param {Array<{ index: number, at: string, wrappedUp: boolean }>} [opts.breaks] - Where a continued chat resumed
 * @param {string[]} [opts.changedFiles] - Member files written since the chat opened
 */
export async function buildChatPrompt(member, teamDir, adapters = {}, opts = {}) {
	const memberDir = join(teamDir, 'members', member.name);
	const rulesFile = join(TEAMOS_ROOT, 'agent-rules', 'chat.md');

	const [rules, orgDoc, memosDoc, projectsDoc, membersDoc, profile, state, todosText, scheduleSections] =
		await Promise.all([
			readTextOrEmpty(rulesFile),
			readTextOrEmpty(join(teamDir, 'org.md')),
			readTextOrEmpty(join(teamDir, 'memos.json')),
			readTextOrEmpty(join(teamDir, 'projects.json')),
			readTextOrEmpty(join(teamDir, 'members.json')),
			readTextOrEmpty(join(memberDir, 'profile.md')),
			readTextOrEmpty(join(memberDir, 'state.md')),
			buildTodoSection(member.name, adapters.tasks),
			buildScheduleSections(member.name, adapters.schedule),
		]);

	const parts = [
		`# TeamOS Chat: ${member.name}${member.title ? ` (${member.title})` : ''}`,
		`# Talking with: ${opts.human}`,
		`# Time: ${formatTimestamp()}`,
		'# Team directory: team/',
		`# Member directory: team/members/${member.name}/`,
		'',
		'## Organization',
		'',
		orgDoc,
		'',
		'## Memos',
		'',
		memosDoc,
		'',
		'## Projects',
		'',
		projectsDoc,
		'',
		'## Team Members',
		'',
		membersDoc,
		'',
		'---',
		'',
		`## Your Profile (${member.name})`,
		'',
		profile || '_No profile found._',
		'',
		'## Your Current State',
		'',
		state || '_No state file found._',
		'',
		'## Your TODOs',
		'',
		todosText,
		'',
		'## Due Events',
		'',
		scheduleSections.due,
		'',
		'## Upcoming Events',
		'',
		scheduleSections.upcoming,
	];

	parts.push(...(await buildInboxSection(member.name, adapters.messaging)));

	parts.push(...buildToolsPromptSection('cycle'));

	parts.push('', '## Chat Rules', '', rules);
	parts.push(...buildChangedFilesSection(opts.changedFiles ?? []));
	parts.push('', '## Conversation So Far', '');
	parts.push(
		...renderTranscript(opts.transcript ?? [], { human: opts.human, member: member.name, breaks: opts.breaks ?? [] }),
	);

	parts.push(
		'',
		'----',
		'',
		`Reply to ${opts.human}'s latest message, as **${member.name}**. Read before you write, and say what you did.`,
	);

	return parts.join('\n');
}

/**
 * Tell the instance which of its own files moved since the chat opened.
 *
 * Everything above this line in the prompt was read a moment ago and is
 * current; the conversation below it was not. So the list is framed as a
 * warning about the transcript, not about the sections — what it means in
 * practice is "an answer you gave earlier may no longer hold, and the other
 * instance of you is why".
 */
function buildChangedFilesSection(changedFiles) {
	if (changedFiles.length === 0) return [];
	return [
		'',
		'## Changed Since This Chat Opened',
		'',
		'Another instance of you — a scheduled cycle — wrote these while this conversation was running:',
		'',
		...changedFiles.map((f) => `- \`${f}\``),
		'',
		'The sections above were rebuilt just now, so they are current. What may not be is anything **you** said earlier in this conversation about those files. Re-read before you repeat an earlier answer or act on one.',
	];
}

/**
 * Render a transcript as markdown. Used both for the prompt's "Conversation So
 * Far" section and for the message body the chat is persisted as, so the
 * member's next cycle reads the conversation in the shape it was held in.
 *
 * `breaks` mark where a continued chat picked up an earlier one (see
 * ChatSessions.create). A break after a wrap-up tells the member everything
 * above it is already recorded; one without (the session was lost, or the
 * earlier part discarded) says it isn't. `from` skips entries an earlier
 * archived record already holds.
 */
export function renderTranscript(transcript, { human, member, breaks = [], from = 0 }) {
	if (transcript.length === 0) return ['_Nothing said yet — this is the first turn._'];
	const lines = [];
	transcript.forEach((entry, i) => {
		if (i < from) return;
		for (const b of breaks) if (b.index === i && i > from) lines.push(breakLine(b, human), '');
		lines.push(`### ${entry.role === 'human' ? human : member} — ${entry.at}`, '', entry.text.trim(), '');
	});
	for (const b of breaks) if (b.index >= transcript.length) lines.push(breakLine(b, human), '');
	return lines;
}

function breakLine(b, human) {
	return b.wrappedUp
		? `_— The chat ended here and was wrapped up into your state and todos. ${human} continued it at ${b.at}; everything above this line is already recorded. —_`
		: `_— The chat stopped here without a wrap-up. ${human} continued it at ${b.at}; nothing above this line (back to any earlier mark) has been recorded yet. —_`;
}

/**
 * How much of a transcript an earlier wrap-up already recorded: everything
 * before the last break that followed one.
 */
export function recordedThrough(breaks = []) {
	return breaks.reduce((n, b) => (b.wrappedUp && b.index > n ? b.index : n), 0);
}

/**
 * The last turn of a chat: wrap up the way a cycle does. The transcript is archived, not
 * delivered, so what this turn writes into state and todos is all the next cycle will know.
 * `leftovers` are checkout paths this chat changed and hasn't committed (leftovers.mjs claims).
 */
export function buildWrapUpPrompt({ human, leftovers = [], continued = false }) {
	const lines = [
		`[TeamOS] ${human} has ended the chat. Wrap up the way you would at the end of a cycle, then stop:`,
	];
	if (continued) {
		lines.push(
			'- This chat continued one you already wrapped up. Everything above the marked line in the conversation is recorded; record only what was said after it.',
		);
	}
	lines.push(
		'- `state.md`: record what was decided or learned that your future self needs. Re-read it first and append; keep it concise.',
		'- Todos: add what was agreed and is still open; update or complete what this chat settled.',
		'- Anything you said you would do or send: do it now, or make it a todo.',
	);
	if (leftovers.length > 0) {
		lines.push(
			'- You left these uncommitted in the shared checkout. Commit what is finished and verified, `git stash push -u -m "<member>: <what and why>" -- <paths>` what is worth keeping (and note the stash in a todo), revert the rest. Touch only these paths:',
			...leftovers.map((l) => `    ${l.status} ${l.path}`),
		);
	}
	lines.push(
		'',
		'The transcript is archived as a record, not sent to your inbox: your next cycle will know only what you put in your state and todos now. Do not start new work. Finish with one line saying what you recorded.',
	);
	return lines.join('\n');
}

/**
 * The cleanup-only last turn of a discarded chat: nothing is recorded, but edits it made to
 * the checkout still need an owner.
 */
export function buildDiscardCleanupPrompt({ human, leftovers }) {
	return [
		`[TeamOS] ${human} has ended and discarded the chat — record nothing from it in your state or todos.`,
		'You did leave these uncommitted in the shared checkout; revert them unless they are finished work worth committing, and touch nothing else:',
		...leftovers.map((l) => `    ${l.status} ${l.path}`),
		'Finish with one line saying what you did.',
	].join('\n');
}

/**
 * The message a finished chat is filed as. The whole transcript goes in the
 * body: the master store is already one markdown file per message with no size
 * rule, and a reference to a file the messaging adapter doesn't know about
 * would be dropped by the retention sweep described in teamos/docs/messages.md.
 *
 * This is the record of the conversation, not a work queue. The chat instance
 * had the same tools a cycle has, so anything agreed may already be done — the
 * next cycle reads this to know what was said and to finish what was left.
 *
 * A continued chat archives only what an earlier record doesn't already hold,
 * as a reply to that record so the two read as one thread in Messages.
 */
export function buildTranscriptMessage({ member, human, transcript, startedAt, endedAt, breaks = [], replyTo }) {
	const from = replyTo ? recordedThrough(breaks) : 0;
	const body = [
		`Chat session with **${human}** on the dashboard, ${startedAt} → ${endedAt}.`,
		'',
		'This is the archived record of the conversation, not a request: the chat instance had your full toolset, and its last turn wrapped up into your state and todos. Re-read the files before you trust what either of you said about them.',
		...(from > 0 ? ['', `It continues the chat archived as ${replyTo}; only what was said after that is here.`] : []),
		'',
		'---',
		'',
		...renderTranscript(transcript, { human, member, breaks, from }),
	].join('\n');

	return {
		from: human,
		to: [member],
		subject: `Chat with ${human} — ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')}`,
		body,
		...(replyTo ? { replyTo } : {}),
	};
}
