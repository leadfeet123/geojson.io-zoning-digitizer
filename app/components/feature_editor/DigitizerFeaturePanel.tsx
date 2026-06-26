import { FeatureEditor as DigitizerFeatureEditor } from 'app/components/feature_editor/FeatureEditor';
import { validateFeatureCollection } from 'app/lib/validation_engine';
import { useAtom } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { digitizerFeaturesAtom } from 'state/digitizer_features';
import type { DigitizerFeature } from 'types/digitizer';

/**
 * Hosts the digitizer feature selector and metadata editor in digitizer mode.
 */
export function DigitizerFeaturePanel() {
  const [features, setFeatures] = useAtom(digitizerFeaturesAtom);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (features.length === 0) {
      setSelectedFeatureId(null);
      return;
    }

    if (
      !selectedFeatureId ||
      !features.some((f) => f.id === selectedFeatureId)
    ) {
      setSelectedFeatureId(features[0].id);
    }
  }, [features, selectedFeatureId]);

  const selectedFeature = useMemo(
    () => features.find((feature) => feature.id === selectedFeatureId) ?? null,
    [features, selectedFeatureId]
  );

  const validationResults = useMemo(
    () => validateFeatureCollection(features),
    [features]
  );

  function updateFeature(nextFeature: DigitizerFeature): void {
    setFeatures((current) =>
      current.map((feature) =>
        feature.id === nextFeature.id ? nextFeature : feature
      )
    );
  }

  return (
    <section className="h-[320px] border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden flex flex-col">
      <header className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Digitizer Features
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {features.length} total
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label
            className="text-xs text-gray-600 dark:text-gray-300"
            htmlFor="digitizer-feature-select"
          >
            Active feature
          </label>
          <select
            id="digitizer-feature-select"
            value={selectedFeatureId ?? ''}
            onChange={(event) =>
              setSelectedFeatureId(event.target.value || null)
            }
            className="text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1"
            disabled={features.length === 0}
          >
            {features.length === 0 ? (
              <option value="">No features</option>
            ) : (
              features.map((feature, index) => (
                <option key={feature.id} value={feature.id}>
                  {`Feature ${index + 1} (${feature.properties.raw_zoning_label || feature.id})`}
                </option>
              ))
            )}
          </select>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <DigitizerFeatureEditor
          selectedFeature={selectedFeature}
          validationResults={validationResults}
          onFeatureChange={updateFeature}
        />
      </div>
    </section>
  );
}
