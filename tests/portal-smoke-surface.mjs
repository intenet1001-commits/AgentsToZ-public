export function classifyPortalSmokeSurface({
  hasPasswordPrompt = false,
  hasPasswordSubmit = false,
  hasGoogleIntro = false,
  hasGoogleLoginButton = false,
  hasAuthenticatedHeading = false,
  hasWorkspaceShell = false,
}) {
  if (hasPasswordPrompt && hasPasswordSubmit) return 'password-gate';
  if (hasGoogleIntro && hasGoogleLoginButton) return 'google-gate';
  if (hasAuthenticatedHeading) return 'authenticated-portal';
  if (hasWorkspaceShell) return 'workspace-shell';
  return 'unknown';
}
