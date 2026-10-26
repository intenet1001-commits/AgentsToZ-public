/** Stable, local browser failure vocabulary. English messages remain available to agents and logs. */
export const BROWSER_ERROR_CODES=[
 'workspace-not-found','session-ended','chrome-disconnected','queue-full','observe-failed',
 'approval-pending','profile-mismatch','tab-limit','tab-not-in-set','stale-observation',
 'take-control-first','popup-open','invalid-address','profile-timeout','still-closing',
 'profile-in-use','workroom-limit','other-window','embedded-unavailable','workspace-changed',
 'grant-unavailable','reload-would-resubmit','target-lost',
 'load-refused','load-timeout','load-name-not-resolved','load-offline','load-certificate','generic',
] as const;
export type BrowserErrorCode=typeof BROWSER_ERROR_CODES[number];
export class WorkroomBrowserError extends Error {
 constructor(public readonly code:BrowserErrorCode,message:string){super(message);this.name='WorkroomBrowserError';}
}

/** Exact messages only: neither a page title nor an arbitrary exception containing these words is a refusal.
 * Native Rust errors arrive from Tauri as strings; JS callers may wrap the same message in Error. */
const MESSAGE_CODES:Readonly<Record<string,BrowserErrorCode>>={
 'Embedded Chromium framework is missing from this app bundle.':'embedded-unavailable',
 'Chromium initialization failed.':'embedded-unavailable',
 'Chromium unavailable':'embedded-unavailable',
 'Browser profile unavailable':'profile-mismatch',
 'Browser host unavailable':'target-lost',
 'Browser observer unavailable':'observe-failed',
 'Invalid browser tab.':'tab-not-in-set',
 'Invalid Workroom session.':'session-ended',
 'Invalid browser profile key.':'profile-mismatch',
 'This browser belongs to another Workroom window.':'other-window',
 'Open the embedded browser first':'workspace-not-found',
 'Close the login popup before handing control to AI.':'popup-open',
 'Close the current browser before restoring another profile.':'profile-mismatch',
 'This Workroom already has 6 tabs.':'tab-limit',
 'Four embedded Workroom pages are already open.':'workroom-limit',
 'This saved browser profile is already open in another Workroom.':'profile-in-use',
 'This saved browser profile is preparing in another Workroom.':'profile-in-use',
 'Browser creation failed':'embedded-unavailable',
 'Browser rectangle required':'workspace-changed',
 'Invalid browser rectangle':'workspace-changed',
 'Trusted Workroom viewport unavailable.':'other-window',
 'Take control before navigating.':'take-control-first',
 'URL required':'invalid-address',
 'HTTP(S) URL required':'invalid-address',
 'Unknown native browser operation':'workspace-changed',
 // C2b's human navigation: the native refusal for a POST entry is the code itself.
 'Browser is closing.':'still-closing',
 'Navigation history unavailable':'workspace-changed',
 'reload-would-resubmit':'reload-would-resubmit',
 // The Tauri command wrapper and the UI's profile/close loops are outside the native engine.
 'Trusted local Workroom required.':'other-window',
 'This app was built without embedded Chromium.':'embedded-unavailable',
 'Browser is still closing.':'still-closing',
 'Chromium profile initialization timed out.':'profile-timeout',
 'Chromium renderer initialization timed out.':'profile-timeout',
 'Invalid browser response.':'workspace-changed',
 'Browser workspace changed.':'workspace-changed',
 'Browser session changed.':'workspace-changed',
 'Browser workspace unavailable.':'workspace-not-found',
 'HTTP(S) address required.':'invalid-address',
 'HTTP(S) page required.':'invalid-address',
 '이 창에서는 해당 런타임 요청을 사용할 수 없습니다.':'other-window',
 '에이전트 런타임 보안 연결을 준비하지 못했습니다.':'embedded-unavailable',
 '허용되지 않은 에이전트 런타임 요청입니다.':'workspace-changed',
 '에이전트 런타임 요청 본문이 올바르지 않습니다.':'workspace-changed',
 '에이전트 런타임 요청이 너무 큽니다.':'workspace-changed',
 '에이전트 런타임 보안 nonce를 만들지 못했습니다.':'embedded-unavailable',
 '에이전트 런타임 보안 확인 요청을 만들지 못했습니다.':'embedded-unavailable',
 // Existing Chrome transport failures keep their original messages as well.
 'Chrome disconnected.':'chrome-disconnected',
 'Chrome connection lost; mutation outcome may be unknown.':'chrome-disconnected',
 'Browser queue full.':'queue-full',
 'The page did not answer in time.':'observe-failed',
 'Chrome 연결 승인이 완료되지 않았습니다.':'approval-pending',
 'Chrome 연결을 확인해 주세요.':'chrome-disconnected',
 'Chrome 연결이 종료됐습니다.':'chrome-disconnected',
 'Chrome에서 chrome://inspect/#remote-debugging을 열어 연결을 켜고, 연결 요청을 허용해 주세요.':'approval-pending',
};
export function classifyWorkroomBrowserError(e:unknown):BrowserErrorCode {
 if(e instanceof WorkroomBrowserError)return e.code;
 const message=typeof e==='string'?e:e instanceof Error?e.message:undefined;
 return message!==undefined&&Object.hasOwn(MESSAGE_CODES,message)?MESSAGE_CODES[message]!:'generic';
}
