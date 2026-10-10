/**
 * Frame limits shared by the LAN listener and the phone page it serves. Kept apart from both so the
 * page can embed them without importing the server (which imports the page).
 */

/** The LAN listener refuses a larger WebSocket message with MESSAGE_TOO_LARGE and a 1008 close, which ends the pairing. */
export const REMOTE_CONTROL_LAN_MAX_MESSAGE_BYTES = 16 * 1024;

/**
 * The phone page never puts a larger message on the wire (review H1, 2026-09-29): one oversized
 * request used to cost the phone its pairing, and only a new QR at the Mac brought it back.
 */
export const REMOTE_CONTROL_LAN_PAGE_MESSAGE_BUDGET_BYTES = REMOTE_CONTROL_LAN_MAX_MESSAGE_BYTES - 512;
