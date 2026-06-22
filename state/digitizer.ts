import { atom } from 'jotai';
import type { LegendResult } from 'app/lib/ocr_adapter';

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

/**
 * Structured legend extracted via AI (Phase 3).
 */
export const extractedLegendAtom = atom<LegendResult | null>(null);
