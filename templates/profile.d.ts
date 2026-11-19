import type { Effort } from './effort';

/** Big 5 personality facets - each rated 1-10 */
export interface Big5Profile {
	openness: number;
	conscientiousness: number;
	extraversion: number;
	agreeableness: number;
	neuroticism: number;
}

export interface MemberProfile {
	name: string; // PascalCased
	title: string;
	description: string;
	roles: string[];
	duties: string[];
	personality: Big5Profile;
	active: boolean;
	type: 'human' | 'ai';
	reportsTo?: string;
	/** Model for this member's cycles and chats (alias or full id), over the run-wide one. */
	model?: string;
	/** Effort for this member's cycles and chats, over the run-wide one; items may override it. */
	effort?: Effort;
}

/* embedded in profile.md frontmatter - see profile-template.md */
