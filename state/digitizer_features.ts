import { atom } from 'jotai';
import type { DigitizerFeature } from 'types/digitizer';

/**
 * In-memory features being edited in digitizer mode before export.
 */
export const digitizerFeaturesAtom = atom<DigitizerFeature[]>([]);
