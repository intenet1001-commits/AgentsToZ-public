# Native confirmation replies

The installed Mac's `tauri-plugin-dialog` 2.4.2 replaces `window.confirm` with an
async function. Treating its returned promise as a boolean performed a Workroom
restart while the native Cancel/OK sheet was still unanswered. Both an AX action
and a pointer click reproduced it in the signed v1153 app; cancelling the sheet
could not undo that restart.

React desktop and portal actions use `await confirmAction(message)`. It accepts
only an explicit `true`, declines concurrent prompts, and declines unavailable or
rejected dialogs. It also accepts the ordinary synchronous browser result.
Callback-based draft take-back and Workroom routing await the same decision before
deleting a kept draft, starting a receiver, or sending terminal input. This does
not replace server-side grants, revision checks or idempotency receipts.

A restart answer is valid only for the still-mounted panel and its unchanged
selection, entry and runtime state. A delayed answer cannot restart a conversation
after the user selected another one. Native prompts block user interaction with
their window, but they do not stop JavaScript or background refreshes.

The separate `workroom-*` windows require their own `dialog:allow-confirm`
capability. The main window's dialog permissions do not apply to them. Without
that permission, the bridge rejects confirmation and the action stays blocked.
Pop-outs receive only that dialog command and their existing title command;
they receive no file-dialog, filesystem or window-creation permission.

`native-confirmation-contracts` checks synchronous/native replies, failure and
concurrency, retained drafts and handoff admission. `native-confirmation-screen`
renders the actual Workroom and external memory-key components in Chromium and
WebKit with deferred native replies and mocked transports. It checks pending,
cancelled, failed, approved and changed-selection cases. These tests perform no
live deletion, grant change or AI call. The legacy standalone mobile page's inline
script runs in a browser without the Tauri dialog override.

For an installed Mac recheck, use only an owned QA runtime in normal approval mode:
leave the restart sheet unanswered and verify the original runtime is still
running; cancel and verify no replacement; then explicitly approve once and verify
exactly one replacement with the same provider conversation and permission mode.
Keep draft preservation and full core-journey counts separate from this targeted
check. Never test an irreversible production action to verify cancellation.
