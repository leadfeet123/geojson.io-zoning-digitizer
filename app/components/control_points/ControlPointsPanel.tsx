import {
  defaultGeorefSuggestionSource,
  defaultGeorefSuggestionAdapter,
  type GeorefSuggestion
} from 'app/lib/georef_suggestion_adapter';
import { MapContext } from 'app/context/map_context';
import { useAtom } from 'jotai';
import { nanoid } from 'nanoid';
import { useContext, useMemo, useState } from 'react';
import {
  solveAffineTransform,
  type TransformControlPoint
} from 'app/lib/transform_engine';
import {
  activeControlPointIdAtom,
  controlPointPlacementModeAtom,
  controlPointsAtom,
  pendingPdfPointAtom,
  type ControlPointPair
} from 'state/control_points';
import { activePdfPageAtom } from 'state/digitizer';

function formatCoord(value: number): string {
  return value.toFixed(5);
}

function formatPixel(value: number): string {
  return value.toFixed(1);
}

function statusText(mode: string): string {
  if (mode === 'awaiting_pdf') {
    return 'Click a point on the PDF panel';
  }

  if (mode === 'awaiting_map') {
    return 'Now click the matching point on the map';
  }

  return 'Idle';
}

function sourceBadgeClass(source: string): string {
  if (source === 'Proxy') {
    return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
  }

  if (source === 'Gemini') {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
  }

  return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
}

function fallbackHintText(source: string): string {
  if (source === 'Proxy') {
    return 'Retry will call your configured proxy again. Automatic fallback is disabled while a proxy URL is configured.';
  }

  if (source === 'Gemini') {
    return 'Retry will call Gemini again. If Gemini is unavailable, suggestions fall back to the built-in heuristic adapter.';
  }

  return 'Using built-in heuristic suggestions because no AI endpoint is configured.';
}

/**
 * Step 1 control-point workflow UI: add pairs, review coordinates, and confirm points.
 */
export function ControlPointsPanel({
  onControlPointClick
}: {
  onControlPointClick?: (controlPointId: string) => void;
}) {
  const map = useContext(MapContext)?.map;
  const [controlPoints, setControlPoints] = useAtom(controlPointsAtom);
  const [activeControlPointId, setActiveControlPointId] = useAtom(
    activeControlPointIdAtom
  );
  const [placementMode, setPlacementMode] = useAtom(
    controlPointPlacementModeAtom
  );
  const [pendingPdfPoint, setPendingPdfPoint] = useAtom(pendingPdfPointAtom);
  const [activePdfPage] = useAtom(activePdfPageAtom);
  const [suggestions, setSuggestions] = useState<GeorefSuggestion[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const sortedSuggestions = useMemo(
    () => [...suggestions].sort((a, b) => b.confidence - a.confidence),
    [suggestions]
  );
  const lowConfidenceCount = useMemo(
    () =>
      sortedSuggestions.filter((suggestion) => suggestion.confidence < 0.5)
        .length,
    [sortedSuggestions]
  );

  const confirmedCount = controlPoints.filter(
    (point) => point.confirmed
  ).length;
  const confirmedPoints = useMemo(
    () =>
      controlPoints
        .filter((point) => point.confirmed)
        .map(
          (point) =>
            ({
              pdf: point.pdf,
              map: point.map
            }) satisfies TransformControlPoint
        ),
    [controlPoints]
  );

  const transformStatus = useMemo(() => {
    if (confirmedPoints.length < 3) {
      return {
        canSolve: false,
        message: 'Need at least 3 confirmed points to solve transform'
      } as const;
    }

    try {
      const solution = solveAffineTransform(confirmedPoints);
      return {
        canSolve: true,
        solution
      } as const;
    } catch (error) {
      return {
        canSolve: false,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to solve transform from confirmed control points'
      } as const;
    }
  }, [confirmedPoints]);

  function updatePoint(id: string, updates: Partial<ControlPointPair>): void {
    setControlPoints((current) =>
      current.map((point) =>
        point.id === id
          ? {
              ...point,
              ...updates
            }
          : point
      )
    );
  }

  function removePoint(id: string): void {
    setControlPoints((current) => current.filter((point) => point.id !== id));
    setActiveControlPointId((current) => (current === id ? null : current));
  }

  function cancelPlacement(): void {
    setPlacementMode('idle');
    setPendingPdfPoint(null);
  }

  function startPlacement(): void {
    setPlacementMode('awaiting_pdf');
    setPendingPdfPoint(null);
  }

  async function requestSuggestions(): Promise<void> {
    if (!map) {
      setSuggestionError('Map is not ready for suggestions yet');
      return;
    }

    try {
      setIsSuggesting(true);
      setSuggestionError(null);

      const center = map.getCenter();
      const bounds = map.getBounds();

      const nextSuggestions =
        await defaultGeorefSuggestionAdapter.suggestPoints({
          page: activePdfPage,
          mapCenter: {
            lon: center.lng,
            lat: center.lat
          },
          mapBounds: {
            west: bounds.getWest(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            north: bounds.getNorth()
          }
        });

      setSuggestions(nextSuggestions);
    } catch (error) {
      setSuggestionError(
        error instanceof Error
          ? error.message
          : 'Failed to generate AI suggestions'
      );
    } finally {
      setIsSuggesting(false);
    }
  }

  function patchSuggestion(
    id: string,
    patch: Partial<GeorefSuggestion['map']>
  ): void {
    setSuggestions((current) =>
      current.map((suggestion) =>
        suggestion.id === id
          ? {
              ...suggestion,
              map: {
                ...suggestion.map,
                ...patch
              }
            }
          : suggestion
      )
    );
  }

  function acceptSuggestion(suggestion: GeorefSuggestion): void {
    setControlPoints((current) => [
      ...current,
      {
        id: nanoid(10),
        pdf: suggestion.pdf,
        map: suggestion.map,
        confirmed: false
      }
    ]);
  }

  return (
    <section className="h-[280px] border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden flex flex-col">
      <header className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Control Points
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {confirmedCount} confirmed / {controlPoints.length} total
        </span>
        <span className="ml-auto text-xs text-gray-600 dark:text-gray-300">
          {statusText(placementMode)}
        </span>
      </header>

      <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={startPlacement}
          disabled={placementMode !== 'idle'}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
        >
          Add Control Point
        </button>
        <button
          type="button"
          onClick={cancelPlacement}
          disabled={placementMode === 'idle'}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            setControlPoints([]);
            setActiveControlPointId(null);
          }}
          disabled={controlPoints.length === 0}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
        >
          Clear All
        </button>
        <button
          type="button"
          onClick={() => {
            void requestSuggestions();
          }}
          disabled={isSuggesting || !map}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
        >
          {isSuggesting ? 'Suggesting...' : 'Suggest 4 Points'}
        </button>
        {pendingPdfPoint && (
          <span className="text-xs text-gray-600 dark:text-gray-300">
            PDF: ({formatPixel(pendingPdfPoint.x)},{' '}
            {formatPixel(pendingPdfPoint.y)}) p{pendingPdfPoint.page}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            AI suggestions (experimental)
          </p>
          <div className="mt-1">
            <span
              className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${sourceBadgeClass(defaultGeorefSuggestionSource)}`}
            >
              Source: {defaultGeorefSuggestionSource}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
            Review each suggestion, edit lon/lat if needed, then add to control
            points.
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {fallbackHintText(defaultGeorefSuggestionSource)}
          </p>
          {suggestionError && (
            <div className="mt-1 flex items-center gap-2">
              <p className="text-xs text-red-600">{suggestionError}</p>
              <button
                type="button"
                onClick={() => {
                  void requestSuggestions();
                }}
                disabled={isSuggesting || !map}
                className="px-2 py-1 text-[10px] rounded border border-red-300 text-red-700 dark:border-red-700 dark:text-red-300 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          )}
          {sortedSuggestions.length > 0 && (
            <div className="mt-2 space-y-2">
              {lowConfidenceCount > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {lowConfidenceCount} low-confidence suggestion
                  {lowConfidenceCount === 1 ? '' : 's'} below 50% are flagged.
                </p>
              )}
              {sortedSuggestions.map((suggestion) => (
                <div
                  key={suggestion.id}
                  className={
                    suggestion.confidence < 0.5
                      ? 'border border-amber-300 dark:border-amber-700 rounded p-2 bg-amber-50/50 dark:bg-amber-900/10'
                      : 'border border-gray-200 dark:border-gray-700 rounded p-2'
                  }
                >
                  <p className="text-xs text-gray-700 dark:text-gray-200">
                    PDF ({formatPixel(suggestion.pdf.x)},{' '}
                    {formatPixel(suggestion.pdf.y)}) p{suggestion.pdf.page}
                  </p>
                  {suggestion.confidence < 0.5 && (
                    <p className="mt-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      Low confidence: review carefully before adding.
                    </p>
                  )}
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    Confidence {(suggestion.confidence * 100).toFixed(0)}%:{' '}
                    {suggestion.rationale}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-gray-700 dark:text-gray-200">
                      Lon
                      <input
                        type="number"
                        value={suggestion.map.lon}
                        onChange={(event) => {
                          const nextValue = Number(event.target.value);
                          if (!Number.isNaN(nextValue)) {
                            patchSuggestion(suggestion.id, { lon: nextValue });
                          }
                        }}
                        className="ml-1 w-28 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                      />
                    </label>
                    <label className="text-xs text-gray-700 dark:text-gray-200">
                      Lat
                      <input
                        type="number"
                        value={suggestion.map.lat}
                        onChange={(event) => {
                          const nextValue = Number(event.target.value);
                          if (!Number.isNaN(nextValue)) {
                            patchSuggestion(suggestion.id, { lat: nextValue });
                          }
                        }}
                        className="ml-1 w-28 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => acceptSuggestion(suggestion)}
                      className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600"
                    >
                      Add as Control Point
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            Transform status
          </p>
          {transformStatus.canSolve ? (
            <div className="mt-1 text-xs text-gray-700 dark:text-gray-200 space-y-1">
              <p>Solved from {confirmedPoints.length} confirmed points</p>
              <p>
                RMS residual:{' '}
                {transformStatus.solution.rmsErrorMeters.toFixed(2)} m
              </p>
            </div>
          ) : (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {transformStatus.message}
            </p>
          )}
        </div>

        {transformStatus.canSolve && (
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
              Residuals by point
            </p>
            <div className="mt-1 text-xs text-gray-700 dark:text-gray-200">
              {transformStatus.solution.residuals.map((residual) => (
                <p key={residual.index}>
                  Point {residual.index + 1}: {residual.errorMeters.toFixed(2)}{' '}
                  m
                </p>
              ))}
            </div>
          </div>
        )}

        {controlPoints.length === 0 ? (
          <p className="p-3 text-sm text-gray-600 dark:text-gray-300">
            No control points yet. Add at least 3 before running georeference in
            Step 2.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
              <tr>
                <th className="text-left px-3 py-2 font-medium">
                  PDF (x, y, page)
                </th>
                <th className="text-left px-3 py-2 font-medium">
                  Map (lon, lat)
                </th>
                <th className="text-left px-3 py-2 font-medium">Confirmed</th>
                <th className="text-left px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {controlPoints.map((point) => (
                <tr
                  key={point.id}
                  className={
                    point.id === activeControlPointId
                      ? 'border-t border-amber-300 bg-amber-50/60 dark:border-amber-500 dark:bg-amber-900/20'
                      : 'border-t border-gray-100 dark:border-gray-800'
                  }
                >
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                    {formatPixel(point.pdf.x)}, {formatPixel(point.pdf.y)} (p
                    {point.pdf.page})
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                    {formatCoord(point.map.lon)}, {formatCoord(point.map.lat)}
                  </td>
                  <td className="px-3 py-2">
                    <label className="inline-flex items-center gap-2 text-gray-700 dark:text-gray-200">
                      <input
                        type="checkbox"
                        checked={point.confirmed}
                        onChange={(event) =>
                          updatePoint(point.id, {
                            confirmed: event.target.checked
                          })
                        }
                      />
                      Confirmed
                    </label>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveControlPointId(point.id);
                        onControlPointClick?.(point.id);
                      }}
                      className="mr-2 px-2 py-1 rounded border border-gray-300 dark:border-gray-600"
                    >
                      Locate
                    </button>
                    <button
                      type="button"
                      onClick={() => removePoint(point.id)}
                      className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
