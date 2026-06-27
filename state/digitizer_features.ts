import { atom } from 'jotai';
import type { DigitizerFeature } from 'types/digitizer';
import { dataAtom } from './jotai';
import type { FeatureMap } from 'types';

/**
 * In-memory features being edited in digitizer mode before export.
 * This is now a derived atom bound to the main dataAtom's featureMap,
 * meaning features rendered/edited on the map automatically appear here.
 */
export const digitizerFeaturesAtom = atom<
  DigitizerFeature[],
  [DigitizerFeature[] | ((prev: DigitizerFeature[]) => DigitizerFeature[])],
  void
>(
  (get) => {
    const data = get(dataAtom);
    const features: DigitizerFeature[] = [];
    for (const wrapped of data.featureMap.values()) {
      features.push(wrapped.feature as unknown as DigitizerFeature);
    }
    return features;
  },
  (get, set, updater) => {
    const data = get(dataAtom);
    const prevFeatures: DigitizerFeature[] = [];
    for (const wrapped of data.featureMap.values()) {
      prevFeatures.push(wrapped.feature as unknown as DigitizerFeature);
    }

    const nextFeatures =
      typeof updater === 'function' ? updater(prevFeatures) : updater;

    const newMap: FeatureMap = new Map();
    newMap.version = (data.featureMap.version || 0) + 1;

    for (const feature of nextFeatures) {
      const existing = data.featureMap.get(feature.id as string);
      newMap.set(feature.id as string, {
        id: feature.id as string,
        at: existing?.at || new Date().toISOString(),
        feature: feature as any
      });
    }

    set(dataAtom, { ...data, featureMap: newMap });
  }
);
