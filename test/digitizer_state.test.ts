import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
  clampDigitizerPdfPaneWidth,
  DIGITIZER_MIN_PANE_WIDTH,
  digitizerWorkspaceViewAtom
} from 'state/digitizer';

describe('digitizer workspace view', () => {
  it('defaults to the split workspace and supports PDF-only view', () => {
    const store = createStore();

    expect(store.get(digitizerWorkspaceViewAtom)).toBe('split');

    store.set(digitizerWorkspaceViewAtom, 'pdf');
    expect(store.get(digitizerWorkspaceViewAtom)).toBe('pdf');

    store.set(digitizerWorkspaceViewAtom, 'split');
    expect(store.get(digitizerWorkspaceViewAtom)).toBe('split');
  });

  it('keeps both workspace panes wide enough while resizing', () => {
    expect(clampDigitizerPdfPaneWidth(100, 1000)).toBe(
      DIGITIZER_MIN_PANE_WIDTH
    );
    expect(clampDigitizerPdfPaneWidth(500, 1000)).toBe(500);
    expect(clampDigitizerPdfPaneWidth(900, 1000)).toBe(672);
  });
});