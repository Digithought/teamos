export interface InboxMessage {
  from: string; // Member name
  content: string;
  sentAt: string; // ISO
  requestResponse?: boolean;
  projectCode?: string;
}

/*
  Inbox messages are markdown files with YAML frontmatter.

  Example: inbox/new-website-page-needed.md:

  ---
  from: MarketingMeg
  sentAt: 2024-01-01T12:00:00Z
  requestResponse: false
  projectCode: newWebsite
  ---

  As part of a new marketing campaign...
*/
