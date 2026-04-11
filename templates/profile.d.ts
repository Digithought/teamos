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
}

/* embedded in profile.md frontmatter - see profile-template.md */
