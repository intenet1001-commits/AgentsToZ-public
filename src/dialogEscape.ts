/**
 * Whether a keydown should dismiss an aria-modal dialog.
 *
 * Escape pressed while an IME is composing (Korean jamo, Japanese kana …) cancels the
 * composition; it must not also throw away the dialog and everything typed into it.
 * An Escape another handler already consumed (defaultPrevented) is not ours either.
 */
export function isDialogDismissKey(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing'> & { keyCode?: number }): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  // WebKit reports keyCode 229 for keys that belong to an active composition.
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}

/**
 * Whether a pointer press landed on a modal layer: inside an aria-modal dialog, or on the scrim
 * whose direct child is one. Such a press belongs to that dialog, not to a disclosure beneath it,
 * so it must not count as an "outside click" for that disclosure.
 */
export function isModalLayerTarget(target: Pick<Element, 'closest' | 'querySelector'>): boolean {
  return !!target.closest('[aria-modal="true"]') || !!target.querySelector(':scope > [aria-modal="true"]');
}
