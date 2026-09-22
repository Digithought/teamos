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
	parts.push(...renderTranscript(opts.transcript ?? [], { human: opts.human, member: member.name }));

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
 *
 * This is the record of the conversation, not a work queue. The chat instance
 * had the same tools a cycle has, so anything agreed may already be done — the
 * next cycle reads this to know what was said and to finish what was left.
 */
export function buildTranscriptMessage({ member, human, transcript, startedAt, endedAt }) {
	const body = [
		`Chat session with **${human}** on the dashboard, ${startedAt} → ${endedAt}.`,
		'',
		'This is the record of the conversation. The instance you were in it had your full toolset, so some of what was agreed may already be done — the transcript says which. Anything it left for later is yours to finish **this cycle**, and re-read the files before you trust what either of you said about them.',
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
