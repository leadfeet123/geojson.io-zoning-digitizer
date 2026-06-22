import { InlineError } from 'app/components/inline_error';
import { useAtom } from 'jotai';
import { extractedLegendAtom } from 'state/digitizer';
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
  const [extractedLegend] = useAtom(extractedLegendAtom);
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
            onChange={(event) =>
              updateProperties({ notes: event.target.value })
            }
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
          {fieldErrors.confidence && (
            <InlineError>{fieldErrors.confidence}</InlineError>
          )}
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
          <span className="text-sm text-gray-700 dark:text-gray-200">
            Confirm feature
          </span>
        </label>

        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            Extracted Legend Rules
          </span>
          {extractedLegend && extractedLegend.zones.length > 0 ? (
            <div className="mt-2 space-y-2 max-h-48 overflow-y-auto">
              <table className="min-w-full text-xs text-left text-gray-600 dark:text-gray-300">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th className="px-2 py-1 font-semibold border-b border-gray-200 dark:border-gray-700">
                      Color
                    </th>
                    <th className="px-2 py-1 font-semibold border-b border-gray-200 dark:border-gray-700">
                      Code
                    </th>
                    <th className="px-2 py-1 font-semibold border-b border-gray-200 dark:border-gray-700">
                      Zone
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {extractedLegend.zones.map((item, i) => (
                    <tr
                      key={i}
                      className="border-b border-gray-100 dark:border-gray-800"
                    >
                      <td className="px-2 py-1">
                        <div
                          className="w-4 h-4 rounded-full border border-gray-300"
                          style={{ backgroundColor: item.color }}
                          title={item.color}
                        />
                      </td>
                      <td className="px-2 py-1">{item.code}</td>
                      <td
                        className="px-2 py-1 truncate max-w-[100px]"
                        title={item.description}
                      >
                        {item.description}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-1 px-3 py-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded">
              No legend extracted yet. Use the "Crop Legend" tool in the PDF
              Viewer.
            </div>
          )}
        </div>

        {fieldErrors.general && (
          <InlineError>{fieldErrors.general}</InlineError>
        )}
      </div>
    </section>
  );
}
