/**
 * A context reading the lists may show as a number.
 *
 * Claude's statusline reports `current_usage` 0 tokens — and so `used_percentage` 0 — until its first reply after it
 * starts, resumes or compacts (measured 2026-10-31: an Orca Claude whose transcript held ~46.7K tokens showed
 * 「컨텍스트 0%」 for over half an hour). No real conversation is at 0%: Claude Code's own system prompt alone is
 * thousands of tokens. A zero reading therefore means 「not measured yet」, never 0%.
 */
export function measuredContextPercent(reading:{usedPercent?:number|null;usedTokens?:number|null}):number|null{
  const percent=reading.usedPercent,tokens=reading.usedTokens;
  if(typeof percent!=='number'||!Number.isFinite(percent))return null;
  if(typeof tokens==='number'&&tokens<=0)return null;
  if(percent<=0&&!(typeof tokens==='number'&&tokens>0))return null;
  return Math.max(0,Math.min(100,percent));
}

/** The context tokens of a Claude statusline capture (`contextWindow.current_usage`), or null when it carries none. */
export function claudeSnapshotUsedTokens(contextWindow:unknown):number|null{
  const usage=contextWindow&&typeof contextWindow==='object'?(contextWindow as {current_usage?:unknown}).current_usage:null;
  if(!usage||typeof usage!=='object')return null;
  const u=usage as Record<string,unknown>,n=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:0;
  return n(u.input_tokens)+n(u.cache_creation_input_tokens)+n(u.cache_read_input_tokens);
}
