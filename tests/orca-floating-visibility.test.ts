import { describe, expect, test } from 'bun:test';
import { inspectOrcaFloatingVisibility } from '../src/orcaFloatingVisibility';

describe('Orca floating workspace visibility', () => {
  test('finds a closed floating workspace toggle in an accessibility snapshot envelope', () => {
    expect(inspectOrcaFloatingVisibility({
      result: { text: '177 toggle button Description: Show floating workspace, Value: 0' },
    })).toEqual({ open: false, toggleElementIndex: 177 });
  });

  test('does not click again when the floating workspace is already open', () => {
    expect(inspectOrcaFloatingVisibility({
      result: { text: '177 toggle button Description: Minimize floating workspace, Value: 1' },
    })).toEqual({ open: true, toggleElementIndex: null });
  });

  test('handles unknown Orca response shapes without inventing an element', () => {
    expect(inspectOrcaFloatingVisibility({ result: { status: 'ready' } })).toEqual({
      open: false,
      toggleElementIndex: null,
    });
  });
});
