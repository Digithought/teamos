import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PRIORITY_ORDER } from './scheduler.mjs';

/**
 * Memos are team-wide and pasted into every cycle prompt, so a member needs to
 * be told which ones it has not seen — otherwise it has to reconstruct from its
 * own history whether it already acted on one. See teamos/docs/memos.md.
 *
 * Per member, the runner keeps a mark at team/.logs/memos/<name>.json: the
 * latest memo time (`revisedAt ?? postedAt`) shown in a cycle that exited
 * cleanly. A memo later than the mark is unseen. The mark advances only to what
 * the prompt actually showed, so a memo posted mid-cycle stays unseen, and a
 * failed cycle shows the same memos again (at-least-once, like watches).
 */

/** Unseen memos at these importances wake the member; the rest wait for its next cycle. */
const WAKE_PRIORITY = { critical: 'pressing', high: 'today' };

function parseTime(value) {
	const t = Date.parse(value ?? '');
	return Number.isNaN(t) ? null : t;
}

/** The time a memo last changed — what the mark is compared against. */
export function memoTime(memo) {
	return parseTime(memo.revisedAt) ?? parseTime(memo.postedAt);
}

export async function readMemos(teamDir) {
	try {
		const data = JSON.parse(await readFile(join(teamDir, 'memos.json'), 'utf-8'));
		return Array.isArray(data.items) ? data.items : [];
	} catch {
		return [];
	}
}

function markPath(teamDir, member) {
	return join(teamDir, '.logs', 'memos', `${member}.json`);
}

/** The member's mark in ms, or null when it has never acknowledged a memo. */
export async function readMemoMark(teamDir, member) {
	try {
		const data = JSON.parse(await readFile(markPath(teamDir, member), 'utf-8'));
		return parseTime(data.seenThrough);
	} catch {
		return null;
	}
}

/** Advance the member's mark to `through` (ms). Never moves it backwards. */
export async function acknowledgeMemos(teamDir, member, through) {
	if (through == null) return;
	const current = await readMemoMark(teamDir, member);
	if (current != null && current >= through) return;
	const path = markPath(teamDir, member);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ seenThrough: new Date(through).toISOString() }, null, '\t')}\n`, 'utf-8');
}

/**
 * 'new' (posted after the mark), 'revised' (posted before, edited after) or
 * 'seen'. A member's own memo is always seen; a memo with no parseable time is
 * treated as seen, since nothing could ever acknowledge it.
 */
export function classifyMemo(memo, mark, member) {
	if (memo.authorName && memo.authorName.toLowerCase() === member.toLowerCase()) return 'seen';
	const posted = parseTime(memo.postedAt);
	const changed = memoTime(memo);
	if (changed == null) return 'seen';
	if (mark == null || (posted ?? changed) > mark) return 'new';
	return changed > mark ? 'revised' : 'seen';
}

/** True when an unseen memo's importance warrants a cycle at `priority` or lower. */
export async function hasUnseenMemos(teamDir, member, priority) {
	const memos = await readMemos(teamDir);
	if (memos.length === 0) return false;
	const mark = await readMemoMark(teamDir, member);
	const priorityIdx = PRIORITY_ORDER.indexOf(priority);
	return memos.some((m) => {
		const wake = WAKE_PRIORITY[m.importance];
		return wake && PRIORITY_ORDER.indexOf(wake) <= priorityIdx && classifyMemo(m, mark, member) !== 'seen';
	});
}

function memoMeta(memo) {
	const parts = [`posted ${memo.postedAt}${memo.authorName ? ` by ${memo.authorName}` : ''}`];
	if (memo.revisedAt) parts.push(`revised ${memo.revisedAt}`);
	if (memo.expiresAt) parts.push(`expires ${memo.expiresAt}`);
	if (memo.projectCodes?.length) parts.push(`projects: ${memo.projectCodes.join(', ')}`);
	return parts.join(' · ');
}

/**
 * The prompt's Memos section. Unseen memos are shown in full; seen ones as a
 * title line only. Returns `through`: the latest memo time shown, which is what
 * a clean exit acknowledges.
 */
export async function buildMemosSection(teamDir, member) {
	const memos = await readMemos(teamDir);
	if (memos.length === 0) return { text: '_No current memos._', through: null };
	const mark = await readMemoMark(teamDir, member);

	const unseen = [];
	const seen = [];
	for (const memo of memos) {
		const kind = classifyMemo(memo, mark, member);
		(kind === 'seen' ? seen : unseen).push({ memo, kind });
	}

	const lines = [];
	if (unseen.length > 0) {
		lines.push(
			`**${unseen.length} memo(s) you have not seen.** Act on them if they concern you; they will not be marked NEW again once this cycle succeeds.`,
			'',
		);
		for (const { memo, kind } of unseen) {
			lines.push(`### [${kind.toUpperCase()}] ${memo.title || '(untitled)'}  (importance: ${memo.importance ?? 'medium'})`);
			lines.push(`_${memoMeta(memo)}_`, '');
			lines.push(memo.content ?? '', '');
		}
	} else {
		lines.push('_No memos you have not already seen._', '');
	}
	if (seen.length > 0) {
		lines.push('**Already seen** — background; full text in `team/memos.json`:', '');
		for (const { memo } of seen) {
			lines.push(`- ${memo.title || '(untitled)'} (${memo.importance ?? 'medium'}; ${memoMeta(memo)})`);
		}
	}

	const times = memos.map(memoTime).filter((t) => t != null);
	return { text: lines.join('\n').trimEnd(), through: times.length ? Math.max(...times) : null };
}
