import { defaultClassificationAdapter } from 'app/lib/classification_adapter';
import { recordSuggestionDecision } from 'app/lib/ai_suggestion_helpers';
import { InlineError } from 'app/components/inline_error';
import { useAtom } from 'jotai';
import { useEffect, useState } from 'react';
import { extractedLegendAtom } from 'state/digitizer';
import type {
  AiSuggestion,
  DigitizerFeature,
  ValidationResult
} from 'types/digitizer';

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
  const [isSuggestingClass, setIsSuggestingClass] = useState(false);
  const [classSuggestionError, setClassSuggestionError] = useState<
    string | null
  >(null);
  const [classSuggestions, setClassSuggestions] = useState<
    Array<{ planning_class: string; confidence: number; rationale: string }>
  >([]);
  const [municipalityContext, setMunicipalityContext] = useState('');
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

  useEffect(() => {
    setMunicipalityContext('');
    setClassSuggestions([]);
    setClassSuggestionError(null);
  }, [feature.id]);

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

  async function suggestPlanningClass(): Promise<void> {
    const label = feature.properties.raw_zoning_label.trim();
    if (!label) {
      setClassSuggestionError(
        'Enter a raw zoning label before requesting AI classification'
      );
      setClassSuggestions([]);
      return;
    }

    setIsSuggestingClass(true);
    setClassSuggestionError(null);

    try {
      const suggestions =
        await defaultClassificationAdapter.suggestPlanningClass({
          rawZoningLabel: label,
          municipality: municipalityContext.trim() || undefined
        });

      setClassSuggestions(suggestions);

      if (suggestions.length === 0) {
        setClassSuggestionError(
          'No planning class suggestions available for this zoning label yet'
        );
      }
    } catch (error) {
      setClassSuggestionError(
        error instanceof Error
          ? error.message
          : 'Failed to generate planning class suggestions'
      );
      setClassSuggestions([]);
    } finally {
      setIsSuggestingClass(false);
    }
  }

  function applyPlanningClassSuggestion(
    suggestion: { planning_class: string; confidence: number },
    selectedIndex: number
  ): void {
    const currentSuggestions = feature.properties.ai_suggestions ?? [];
    const nonPlanningClassSuggestions = currentSuggestions.filter(
      (item) => item.field !== 'planning_class'
    );
    const existingPlanningClassByValue = new Map(
      currentSuggestions
        .filter((item) => item.field === 'planning_class')
        .map((item) => [item.value, item])
    );

    const nextPlanningClassSuggestions: AiSuggestion[] = classSuggestions.map(
      (item, index) => {
        const existing = existingPlanningClassByValue.get(item.planning_class);
        const base: AiSuggestion = existing ?? {
          field: 'planning_class',
          value: item.planning_class,
          confidence: item.confidence,
          accepted: null
        };

        if (index === selectedIndex) {
          return recordSuggestionDecision(
            { ...base, accepted: true },
            'accepted'
          );
        }

        return { ...base, accepted: base.accepted };
      }
    );

    updateProperties({
      planning_class: suggestion.planning_class,
      confidence: suggestion.confidence,
      human_confirmed: false,
      ai_suggestions: [
        ...nonPlanningClassSuggestions,
        ...nextPlanningClassSuggestions
      ]
    });
  }

  function rejectPlanningClassSuggestion(suggestion: {
    planning_class: string;
    confidence: number;
  }): void {
    const currentSuggestions = feature.properties.ai_suggestions ?? [];
    const nonPlanningClassSuggestions = currentSuggestions.filter(
      (item) => item.field !== 'planning_class'
    );
    const existingPlanningClassByValue = new Map(
      currentSuggestions
        .filter((item) => item.field === 'planning_class')
        .map((item) => [item.value, item])
    );

    const nextPlanningClassSuggestions: AiSuggestion[] = classSuggestions.map(
      (item) => {
        const existing = existingPlanningClassByValue.get(item.planning_class);
        const base: AiSuggestion = existing ?? {
          field: 'planning_class',
          value: item.planning_class,
          confidence: item.confidence,
          accepted: null
        };

        if (item.planning_class === suggestion.planning_class) {
          return recordSuggestionDecision(
            { ...base, accepted: false },
            'rejected'
          );
        }

        return { ...base, accepted: base.accepted };
      }
    );

    updateProperties({
      human_confirmed: false,
      ai_suggestions: [
        ...nonPlanningClassSuggestions,
        ...nextPlanningClassSuggestions
      ]
    });
  }

  function overridePlanningClassSuggestions(): void {
    const currentSuggestions = feature.properties.ai_suggestions ?? [];
    const nonPlanningClassSuggestions = currentSuggestions.filter(
      (item) => item.field !== 'planning_class'
    );

    const nextPlanningClassSuggestions: AiSuggestion[] = classSuggestions.map(
      (item) => {
        const existing = feature.properties.ai_suggestions?.find(
          (s) => s.field === 'planning_class' && s.value === item.planning_class
        );
        const base: AiSuggestion = existing ?? {
          field: 'planning_class',
          value: item.planning_class,
          confidence: item.confidence,
          accepted: null
        };

        return recordSuggestionDecision(
          { ...base, accepted: false },
          'overridden'
        );
      }
    );

    updateProperties({
      human_confirmed: false,
      ai_suggestions: [
        ...nonPlanningClassSuggestions,
        ...nextPlanningClassSuggestions
      ]
    });
  }

  function isPlanningClassOverridden(): boolean {
    const planningSuggestions = feature.properties.ai_suggestions?.filter(
      (entry) => entry.field === 'planning_class'
    );

    if (!planningSuggestions || planningSuggestions.length === 0) {
      return false;
    }

    return planningSuggestions.every((entry) => entry.accepted === false);
  }

  function getPlanningSuggestionDecision(
    planningClass: string
  ): boolean | null {
    const item = feature.properties.ai_suggestions?.find(
      (entry) =>
        entry.field === 'planning_class' && entry.value === planningClass
    );

    return item?.accepted ?? null;
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

          <div className="mt-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
              Municipality context (optional)
            </span>
            <input
              type="text"
              value={municipalityContext}
              onChange={(event) => setMunicipalityContext(event.target.value)}
              placeholder="e.g., San Jose, CA"
              className="mt-1 w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            />
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void suggestPlanningClass();
              }}
              disabled={isSuggestingClass}
              className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
            >
              {isSuggestingClass ? 'Suggesting...' : 'Suggest Planning Class'}
            </button>
          </div>

          {classSuggestionError && (
            <InlineError>{classSuggestionError}</InlineError>
          )}

          {classSuggestions.length > 0 && (
            <div className="mt-2 space-y-2">
              {classSuggestions.map((suggestion, index) => (
                <div
                  key={`${suggestion.planning_class}-${index}`}
                  className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-600 dark:text-gray-300">
                      {getPlanningSuggestionDecision(
                        suggestion.planning_class
                      ) === true
                        ? 'Accepted'
                        : getPlanningSuggestionDecision(
                              suggestion.planning_class
                            ) === false
                          ? isPlanningClassOverridden()
                            ? 'Overridden'
                            : 'Rejected'
                          : 'Pending'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {suggestion.planning_class}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          applyPlanningClassSuggestion(suggestion, index)
                        }
                        className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          rejectPlanningClassSuggestion(suggestion)
                        }
                        className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600"
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        onClick={overridePlanningClassSuggestions}
                        className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600"
                      >
                        Override
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                    Confidence: {(suggestion.confidence * 100).toFixed(0)}%
                  </div>
                  <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                    {suggestion.rationale}
                  </div>
                </div>
              ))}
            </div>
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
          <div
            className={`mt-1 px-3 py-2 rounded border text-sm ${
              feature.properties.confidence < 0.5 &&
              !feature.properties.human_confirmed
                ? 'border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-300'
                : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-100'
            }`}
          >
            {feature.properties.confidence.toFixed(2)}
            {feature.properties.confidence < 0.5 &&
              !feature.properties.human_confirmed && (
                <span className="ml-2 text-[10px] font-medium">
                  Low confidence — confirm before export
                </span>
              )}
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
