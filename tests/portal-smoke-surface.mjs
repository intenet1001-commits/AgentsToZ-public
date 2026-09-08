export function classifyPortalSmokeSurface({
  hasPasswordPrompt,
  hasPasswordSubmit,
  hasGoogleIntro,
  hasGoogleLoginButton,
  hasAuthenticatedHeading,
}) {
  if (hasPasswordPrompt && hasPasswordSubmit) return 'password-gate';
  if (hasGoogleIntro && hasGoogleLoginButton) return 'google-gate';
  if (hasAuthenticatedHeading) return 'authenticated-portal';
  return 'unknown';
}
