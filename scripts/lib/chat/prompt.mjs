import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInboxSection, buildScheduleSections, buildTodoSection } from '../cycle.mjs';
import { formatTimestamp, readTextOrEmpty } from '../util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMOS_ROOT = join(__dirname, '..', '..', '..');

/**
 * Build the system prompt for one chat turn.
 *
 * Deliberately the cycle prompt minus the cycle: same organization, profile,
 * state, todos, events and inbox (assembled by the same helpers in cycle.mjs,
 * so a member never sees a different picture of itself in chat than in a
 * cycle), minus the "do a unit of work now" framing, minus the MCP tool
 * section — a chat session has no tools to describe, which is the whole point
 * of the write-narrow rule in teamos/docs/chat.md.
 *
 * The conversation so far is appended, and the human's new turn is passed to
 * the agent as its prompt. Every turn spawns a fresh agent, so the transcript
 * carried here *is* the session's memory.
 *
 * @param {{ name: string, title?: string }} member
 * @param {string} teamDir
 * @param {Object} adapters - messaging / tasks / schedule (same objects the runner uses)
 * @param {Object} opts
 * @param {string} opts.human - Name of the human on the other end
 * @param {Array<{ role: 'human'|'member', text: string, at: string }>} [opts.transcript]
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

	parts.push('', '## Chat Rules', '', rules, '', '## Conversation So Far', '');
	parts.push(...renderTranscript(opts.transcript ?? [], { human: opts.human, member: member.name }));

	parts.push(
		'',
		'----',
		'',
		`Reply to ${opts.human}'s latest message, as **${member.name}**. Read whatever you need; write nothing.`,
	);

	return parts.join('\n');
}

/**
 * Render a transcript as markdown. Used both for the prompt's "Conversation So
 * Far" section and for the message body the chat is persisted as, so the
 * member's next cycle reads the conversation in the shape it was held in.
 */
export function renderTranscript(transcript, { human, member }) {
	if (transcript.length === 0) return ['_Nothing said yet — this is the first turn._'];
	const lines = [];
	for (const entry of transcript) {
		lines.push(`### ${entry.role === 'human' ? human : member} — ${entry.at}`, '', entry.text.trim(), '');
	}
	return lines;
}

/**
 * The message a finished chat is filed as. The whole transcript goes in the
 * body: the master store is already one markdown file per message with no size
 * rule, and a reference to a file the messaging adapter doesn't know about
 * would be dropped by the retention sweep described in teamos/docs/messages.md.
 */
export function buildTranscriptMessage({ member, human, transcript, startedAt, endedAt }) {
	const body = [
		`Chat session with **${human}** on the dashboard, ${startedAt} → ${endedAt}.`,
		'',
		'This conversation had no write access — nothing in it has been applied. Anything agreed here is yours to act on **this cycle**: add the todos, record the state, send the messages.',
		'',
		'---',
		'',
		...renderTranscript(transcript, { human, member }),
	].join('\n');

	return {
		from: human,
		to: [member],
		subject: `Chat with ${human} — ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')}`,
		body,
	};
}
