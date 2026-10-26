// The push relay endpoint for AgentsToZ Screen's notifications and remote stop (DESIGN 「알림·원격 차단」).
// OFF unless AGENTSTOZ_SCREEN_PUSH_URL is set: then build-screen-app.ts writes it into Info.plist
// (`AgentsToZScreenPushURL`) and the app notifies and polls. The same rules as Swift's `PushEndpoint`, stricter:
// https, a host name, an optional port and a plain path; no credentials, query or fragment.
const shape = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;

/** The endpoint to build in, or null for none. Throws when one is set but unusable, so a build never turns it off by a typo. */
export function screenPushEndpoint(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.length > 512 || !shape.test(text)) throw Error(`AGENTSTOZ_SCREEN_PUSH_URL must be a plain https URL: ${text}`);
  return text;
}

/** The Info.plist line, or nothing. */
export function screenPushPlistEntry(value: string | undefined): string {
  const endpoint = screenPushEndpoint(value);
  return endpoint ? `  <key>AgentsToZScreenPushURL</key><string>${endpoint}</string>\n` : '';
}
