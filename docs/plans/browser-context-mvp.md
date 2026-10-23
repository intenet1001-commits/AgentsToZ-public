# AgentsToZ browser context MVP

This branch implements an AgentsToZ-owned, read-only browser-context workflow. It does not depend on Ego Lite, Aside, their CLI/MCP APIs, extensions, user browser profiles or remote CDP. Chromium and Playwright are reused as the rendering runtime; this is not a new browser engine.

## Contract and current scope

The UI/API contract is `docs/plans/browser-context-contract.json`. The exact local endpoint is `POST /api/agent-runtime/browser-context`. Installed Tauri UI uses the existing `agent_runtime_request` native proxy and its Agent Runtime capability. The page itself is rendered in a separate Chromium process/context and receives no IPC, app capability, token, profile, cookies or filesystem path.

Operations are `status`, `open`, `read`, and `close`; no arbitrary navigation, selector, script, CDP command or filesystem parameter is accepted. Each opaque session belongs to this host process. Sessions are ephemeral, at most two, expire after ten minutes, and close their contexts. The browser closes when the final session closes. API shutdown waits for pending opening work and closes contexts/browser. Opening is serialized and has a fifteen-second aggregate deadline (shorter than native/client transport limits); timeout aborts the document request and closes the owned context. If a browser protocol wait stalls before a context handle exists, deadline cleanup invalidates that owned browser and its old sessions; the user must reopen them. Admission remains held until the actual opening task finalizes, even if the deadline already answered the caller. Reads on a session are serialized with an eight-second absolute deadline covering DOM evaluation and screenshots. Timeout closes exactly that session/context. Its admission slot and busy state remain held until the underlying read actually settles and cleanup completes; shutdown also awaits these tracked reads. Closing contexts stay in a separate quota-counted registry until actual context/browser cleanup settles; duplicate close requests join that same cleanup. Closing sessions are omitted from the public session list.

A user explicitly supplies a URL, sees the returned title/text/link preview, selects the text/links to attach, and explicitly attaches reference data to their draft. Page content is untrusted reference data and must not be interpreted as agent instructions. Capturing does not send an AI request. Screenshots are optional JPEG previews (fixed 1100×760 viewport, at most 350 KB), not automatic screenshot attachments.

## Availability is evidence, not an installation promise

Development mode dynamically discovers the already-present Playwright package and its existing Chromium executable. No dependency or browser installation is attempted. Status reports unavailable if either is missing. Opening can still fail (for example platform sandbox restrictions); the error is reported.

**Packaged sidecars deliberately report unavailable.** Playwright is currently a development dependency and the repository has no approved Chromium packaging/update/signing contract. This implementation does not claim that a source fixture passing makes an installed app ready. Production support requires separate packaging, platform sandbox, code-signing, lifecycle and physical-device validation. No deployment or installation was performed for this work.

## Narrow security policy

- Only explicit HTTP(S) URLs of at most 2048 characters; no credentials, query or fragment. Public targets are restricted to ports 80/443, resolve to IPv4 only, and all returned addresses must be public. Special-use, private, link-local, multicast, IPv6 and mixed public/private DNS answers fail closed. DNS has a three-second deadline and cancels its resolver.
- Registered `localhost`/`127.0.0.1` project app ports are allowed; OPS entries and both static/default and actual current AgentsToZ API/UI management ports are excluded. Registration is reread for each opening. Other loopback ports are refused.
- The host performs a single anonymous document GET using a checked, pinned address and the original TLS hostname. It imports no ambient cookies, authorization, browser storage or proxy. Redirects and non-2xx responses are rejected. Only HTML/plain text is accepted, with an absolute ten-second deadline, eight-second socket inactivity timeout and 512 KB cap. No response headers, cookies or HTTP account output are exposed to the UI.
- Chromium is launched with its sandbox enabled. Its context disables JavaScript, service workers, downloads and granted permissions. The document is fulfilled from the host's bounded fetch; all subsequent requests, subresources, popups and navigation are blocked. A restrictive CSP also denies scripts, frames, images, forms and base URLs.
- A fixed host-owned DOM routine removes forms, inputs, textareas, selects, buttons, contenteditable content, frames, embedded objects, hidden/ARIA-hidden elements and metadata redirects before extraction or screenshots. It does not read field values, login information, cookies, local storage or network/account logs. DOM evaluation is fixed implementation code; callers cannot supply scripts. Static visible page text can still contain confidential material, so preview and explicit user selection remain necessary.
- Extraction is bounded to 12,000 visible-text characters, 40 credential/query/fragment-free HTTP(S) links and a 256-character title. A screenshot is only generated on explicit `screenshot: true`. Screenshot bytes and page text remain in memory; closing discards the session.
- Management requests require the existing exact local/Tauri origin policy; bundled requests additionally require the native runtime capability. Exact POST/no query is enforced by both Bun and Rust allowlists. JSON bodies have a 4096-byte cap and absolute two-second read deadline; responses are private/no-store. Remote/LAN/MCP paths do not expose this feature.

## Deliberate limitations

JavaScript applications, authenticated pages, external styles/images, cross-origin redirects, IPv6-only sites, query-string search pages, browser interaction and normal logged-in browsing are unsupported. This conservative static-document subset was chosen so isolation, SSRF constraints and lifecycle bounds could be reviewed and exercised within the requested implementation window. Text pages may look different from the live website. There is no claim to a complete Ego/Aside-equivalent product.

## Validation

Owned host tests use a temporary loopback HTML fixture and the existing real Chromium binary. They exercise title/text/link/screenshot extraction; JavaScript/subresource/form suppression; DNS/IP policy; actual transport lookup pinning; honest packaged unavailability; unknown caller fields; request-body deadlines; slow-drip document deadlines; opening concurrency; and shutdown during opening. API security coverage is independently owned in `tests/browser-context-security.test.ts` and checks exact route/origin/native capability boundaries without real-account data.

Targeted commands and exact final outcomes are written to `/tmp/agentstoz-browser-worker-host.json`. No full verify, dependency installation, package lock change, commit, push, deployment or app installation is part of this worker's scope.
