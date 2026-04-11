/** Brief member entry for members.json */
export interface MemberEntry {
  name: string;
  title: string;
  roles: string[];
  active: boolean;
  type: 'human' | 'ai';
  /** Optional notes — e.g. "talk to this person about X" */
  notes?: string;
}

/** Root members.json structure */
export interface MembersManifest {
  members: MemberEntry[];
}
