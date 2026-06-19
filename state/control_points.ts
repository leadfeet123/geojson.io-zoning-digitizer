import { atom } from 'jotai';

export interface PdfPoint {
  x: number;
  y: number;
  page: number;
}

export interface MapPoint {
  lon: number;
  lat: number;
}

export interface ControlPointPair {
  id: string;
  pdf: PdfPoint;
  map: MapPoint;
  confirmed: boolean;
}

export type ControlPointPlacementMode =
  | 'idle'
  | 'awaiting_pdf'
  | 'awaiting_map';

/**
 * Stores matched control points (PDF coordinates to WGS-84 coordinates).
 */
export const controlPointsAtom = atom<ControlPointPair[]>([]);

/**
 * Placement workflow state for adding a new control point pair.
 */
export const controlPointPlacementModeAtom =
  atom<ControlPointPlacementMode>('idle');

/**
 * Temporary PDF point waiting for map coordinate pairing.
 */
export const pendingPdfPointAtom = atom<PdfPoint | null>(null);

/**
 * Currently focused control point for cross-panel highlight/sync behavior.
 */
export const activeControlPointIdAtom = atom<string | null>(null);
