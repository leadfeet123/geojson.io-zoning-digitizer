import { atom } from 'jotai';

export interface ActivePdfState {
  file: File;
  pageCount: number;
}

/**
 * Toggles digitizer mode on/off while preserving baseline geojson.io behavior.
 */
export const digitizerModeAtom = atom(false);

/**
 * Active PDF document for the digitizer workflow.
 */
export const activePdfAtom = atom<ActivePdfState | null>(null);

/**
 * 1-based active page in the loaded PDF.
 */
export const activePdfPageAtom = atom(1);
