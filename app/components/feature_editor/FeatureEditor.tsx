import { InlineError } from 'app/components/inline_error';
import type { DigitizerFeature, ValidationResult } from 'types/digitizer';

interface FeatureEditorProps {
  selectedFeature: DigitizerFeature | null;
  validationResults?: ValidationResult[];
  onFeatureChange: (feature: DigitizerFeature) => void;
}

function groupValidationResults(
  featureId: string,
  validationResults: ValidationResult[]
): Record<string, string[]> {
  return validationResults
    .filter((result) => result.featureId === featureId)
    .reduce<Record<string, string[]>>((acc, result) => {
      const field = result.field ?? 'general';
      if (!acc[field]) {
        acc[field] = [];
      }
      acc[field].push(result.message);
      return acc;
    }, {});
}

/**
 * Phase 1 digitizer feature editor for schema-required zoning fields.
 */
export function FeatureEditor({
  selectedFeature,
  validationResults = [],
  onFeatureChange
}: FeatureEditorProps) {
  if (!selectedFeature) {
    return (
      <section className="h-full w-full p-4 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Feature Editor
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          Select a polygon to edit zoning metadata.
        </p>
      </section>
    );
  }

  const feature = selectedFeature;

  const fieldErrors = groupValidationResults(feature.id, validationResults);

  function updateProperties(
    updates: Partial<DigitizerFeature['properties']>
  ): void {
    onFeatureChange({
      ...feature,
      properties: {
        ...feature.properties,
        ...updates
      }
    });
  }

  return (
    <section className="h-full w-full p-4 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Feature Editor
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          ID: {feature.id}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            Raw zoning label
          </span>
          <input
            type="text"
            value={feature.properties.raw_zoning_label}
            onChange={(event) =>
              updateProperties({ raw_zoning_label: event.target.value })
            }
            className="mt-1 w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
          {fieldErrors.raw_zoning_label && (
            <InlineError>{fieldErrors.raw_zoning_label}</InlineError>
          )}
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            Planning class
          </span>
          <input
            type="text"
            value={feature.properties.planning_class}
            onChange={(event) =>
              updateProperties({ planning_class: event.target.value })
            }
            className="mt-1 w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
          {fieldErrors.planning_class && (
            <InlineError>{fieldErrors.planning_class}</InlineError>
          )}
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            Notes
          </span>
          <textarea
            rows={4}
            value={feature.properties.notes ?? ''}
            onChange={(event) => updateProperties({ notes: event.target.value })}
            className="mt-1 w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
        </label>

        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            Confidence
          </span>
          <div className="mt-1 px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100">
            {feature.properties.confidence.toFixed(2)}
          </div>
          {fieldErrors.confidence && <InlineError>{fieldErrors.confidence}</InlineError>}
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={feature.properties.human_confirmed}
            onChange={(event) =>
              updateProperties({ human_confirmed: event.target.checked })
            }
            className="rounded border-gray-300 dark:border-gray-600"
          />
          <span className="text-sm text-gray-700 dark:text-gray-200">Confirm feature</span>
        </label>

        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            AI Assist
          </span>
          <button
            type="button"
            disabled
            className="mt-1 w-full rounded border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-500 dark:text-gray-400 cursor-not-allowed"
          >
            Detect label (coming in Phase 3)
          </button>
          {/* TODO(phase-3): Wire OCR and classification suggestions through adapters. */}
        </div>

        {fieldErrors.general && <InlineError>{fieldErrors.general}</InlineError>}
      </div>
    </section>
  );
}
