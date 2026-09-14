interface ClipboardEnvironment {
  clipboard?: Pick<Clipboard, 'writeText'>;
  document?: Document;
}

/**
 * One clipboard contract for every onboarding surface. Embedded WebViews may expose
 * navigator.clipboard but reject writes, so selection-copy is a required fallback.
 */
export async function writeOnboardingClipboard(
  value: string,
  environment: ClipboardEnvironment = {},
): Promise<boolean> {
  const clipboard = environment.clipboard
    ?? (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(value);
      return true;
    }
  } catch {
    // Continue to the DOM selection fallback.
  }

  const targetDocument = environment.document
    ?? (typeof document !== 'undefined' ? document : undefined);
  if (!targetDocument?.body) return false;

  const textarea = targetDocument.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  targetDocument.body.appendChild(textarea);
  textarea.select();
  try {
    return targetDocument.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
