import { memoryAgentVersionMarker } from './projectMemoryVersion';

export const AGENTSTOZ_OUTPUT_STYLE_START = '<!-- AgentsToZ shared-output-style:start -->';
export const AGENTSTOZ_OUTPUT_STYLE_END = '<!-- AgentsToZ shared-output-style:end -->';

/**
 * One product-owned response contract shared by every supported agent surface.
 * Keep this text product-neutral: it is injected into Claude, Codex,
 * Antigravity, and Hermes instruction files verbatim.
 */
export const SHARED_OUTPUT_STYLE_PROMPT = `# Shared output style

- For every user request, first provide a single faithful and concise English translation of the user's request under the label \`English translation:\`.
- Then proceed with the requested work.
- Write the actual response in the user's language unless the user asks for another language.
- Do not translate code, file paths, URLs, proper nouns, or quoted text unless needed for clarity.`;

export function sharedOutputStyleBlock(): string {
  return `${AGENTSTOZ_OUTPUT_STYLE_START}
${memoryAgentVersionMarker()}
${SHARED_OUTPUT_STYLE_PROMPT}
${AGENTSTOZ_OUTPUT_STYLE_END}`;
}

export function withSharedOutputStyle(existing: string): string {
  const block = sharedOutputStyleBlock();
  const markerPattern = new RegExp(
    `${escapeRegExp(AGENTSTOZ_OUTPUT_STYLE_START)}[\\s\\S]*?${escapeRegExp(AGENTSTOZ_OUTPUT_STYLE_END)}`,
  );
  const withoutManagedBlock = existing.replace(markerPattern, '').replace(/^\s*\n/, '');
  const frontmatter = withoutManagedBlock.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
  if (frontmatter) {
    const rest = withoutManagedBlock.slice(frontmatter.length).replace(/^\s*\n/, '');
    return `${frontmatter.trimEnd()}\n\n${block}${rest.trim() ? `\n\n${rest}` : '\n'}`;
  }
  return `${block}${withoutManagedBlock.trim() ? `\n\n${withoutManagedBlock.trimStart()}` : '\n'}`;
}

export function hasCurrentSharedOutputStyle(content: string | null | undefined): boolean {
  if (!content) return false;
  return content.includes(sharedOutputStyleBlock());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
