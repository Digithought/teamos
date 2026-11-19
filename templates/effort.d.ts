/**
 * Reasoning effort for an agent spawn, lowest first — the Claude CLI's `--effort` values.
 * Precedence and how a cycle combines item efforts: README § Model and effort.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
