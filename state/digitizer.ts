import { atom } from 'jotai';
import type { LegendResult } from 'app/lib/ocr_adapter';

export interface ActivePdfState {
  file: File;
  pageCount: number;
}

export type DigitizerWorkspaceView = 'split' | 'pdf';

export const DIGITIZER_MIN_PANE_WIDTH = 320;
export const DIGITIZER_SPLIT_RESIZER_WIDTH = 8;

/**
 * Keeps both digitizer workspaces usable while the split divider moves.
 */
export function clampDigitizerPdfPaneWidth(
  requestedWidth: number,
  workspaceWidth: number
): number {
  const largestAllowedWidth = Math.max(
    DIGITIZER_MIN_PANE_WIDTH,
    workspaceWidth -
      DIGITIZER_MIN_PANE_WIDTH -
      DIGITIZER_SPLIT_RESIZER_WIDTH
  );

  return Math.min(
    Math.max(requestedWidth, DIGITIZER_MIN_PANE_WIDTH),
    largestAllowedWidth
  );
}

/**
 * Toggles digitizer mode on/off while preserving baseline geojson.io behavior.
 */
export const digitizerModeAtom = atom(false);

/**
 * Chooses whether digitizer mode shows both workspaces or the PDF workspace alone.
 */
export const digitizerWorkspaceViewAtom = atom<DigitizerWorkspaceView>('split');

/**
 * Width of the PDF pane in a split workspace; null uses the responsive default.
 */
export const digitizerPdfPaneWidthAtom = atom<number | null>(null);

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
