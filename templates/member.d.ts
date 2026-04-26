/** Brief member entry for members.json */
export interface MemberEntry {
	name: string;
	title: string;
	roles: string[];
	active: boolean;
	type: 'human' | 'ai';
	/** Optional notes — e.g. "talk to this person about X" */
	notes?: string;
	/** Optional email — used by the dashboard to map proxy/SSO identity headers to this member. */
	email?: string;
}

/** Root members.json structure */
export interface MembersManifest {
	members: MemberEntry[];
}
