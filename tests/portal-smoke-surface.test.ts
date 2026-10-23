import { describe, expect, test } from 'bun:test';
import { classifyPortalSmokeSurface } from './portal-smoke-surface.mjs';

describe('portal smoke surface classification', () => {
  test('a public workspace home does not prove Google authentication', () => {
    expect(classifyPortalSmokeSurface({hasWorkspaceShell:true,hasAuthenticatedHeading:false})).toBe('workspace-shell');
    expect(classifyPortalSmokeSurface({hasWorkspaceShell:true,hasGoogleIntro:true,hasGoogleLoginButton:true})).toBe('google-gate');
  });
  test('recognizes the current Google OAuth copy only with its actual login control', () => {
    expect(classifyPortalSmokeSurface({
      hasPasswordPrompt: false,
      hasPasswordSubmit: false,
      hasGoogleIntro: true,
      hasGoogleLoginButton: true,
      hasAuthenticatedHeading: false,
    })).toBe('google-gate');
  });

  test('does not mistake feature-list bookmark text for an authenticated portal', () => {
    expect(classifyPortalSmokeSurface({
      hasPasswordPrompt: false,
      hasPasswordSubmit: false,
      hasGoogleIntro: true,
      hasGoogleLoginButton: false,
      hasAuthenticatedHeading: false,
    })).toBe('unknown');
  });

  test('requires the management portal heading for an authenticated surface', () => {
    expect(classifyPortalSmokeSurface({
      hasPasswordPrompt: false,
      hasPasswordSubmit: false,
      hasGoogleIntro: false,
      hasGoogleLoginButton: false,
      hasAuthenticatedHeading: true,
    })).toBe('authenticated-portal');
  });
});
