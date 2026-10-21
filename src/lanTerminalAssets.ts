// Bun embeds these exact installed assets into the sidecar; no CDN or localhost API is exposed.
import javascript from '@xterm/xterm/lib/xterm.js' with {type:'text'};
import stylesheet from '@xterm/xterm/css/xterm.css' with {type:'text'};
export const LAN_XTERM_JS = javascript as unknown as string;
export const LAN_XTERM_CSS = stylesheet as unknown as string;
