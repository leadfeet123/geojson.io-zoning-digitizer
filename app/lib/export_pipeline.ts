import type { FeatureCollection } from 'types';
import type { DigitizerFeature } from './validation_engine';
import { repairOverlaps } from './overlap_repair_engine';

export interface ExportGuardError {
  featureId: string;
  message: string;
}

export interface ExportGuardResult {
  ok: boolean;
  errors: ExportGuardError[];
}

/**
 * Checks that every feature meets export pre-conditions.
 * Returns { ok: false, errors } if any feature with confidence < 0.5
 * is not human-confirmed. Callers can navigate to featureId for each error.
 */
export function guardExport(features: DigitizerFeature[]): ExportGuardResult {
  const errors: ExportGuardError[] = features
    .filter(
      (feature) =>
        feature.properties.confidence < 0.5 &&
        !feature.properties.human_confirmed
    )
    .map((feature) => ({
      featureId: feature.id,
      message: `Feature "${feature.properties.raw_zoning_label || feature.id}" has confidence ${(feature.properties.confidence * 100).toFixed(0)}% and is not yet confirmed by a human.`
    }));

  return { ok: errors.length === 0, errors };
}

/**
 * Checks for unresolved polygon overlaps that must be resolved before export.
 *
 * Slivers and same-label duplicates can be auto-repaired by `repairOverlaps()`.
 * This guard only blocks overlaps that require human judgment:
 * `containment`, `significant`, and cross-label `duplicate` conflicts.
 *
 * Call after `guardExport` so per-feature errors are reported first.
 */
export function guardExportOverlaps(
  features: DigitizerFeature[]
): ExportGuardResult {
  const { unresolvedIssues } = repairOverlaps(features);

  const errors: ExportGuardError[] = unresolvedIssues.map((issue) => ({
    featureId: issue.featureAId,
    message: issue.description
  }));

  return { ok: errors.length === 0, errors };
}

/**
 * Converts in-memory digitizer features into a GeoJSON FeatureCollection
 * using the frozen Phase 1 planning schema.
 */
export function toGeoJSON(
  features: DigitizerFeature[],
  sourceName: string,
  now: Date = new Date()
): FeatureCollection {
  const digitizedAt = now.toISOString();

  return {
    type: 'FeatureCollection',
    features: features.map((feature) => {
      return {
        type: 'Feature',
        geometry: feature.geometry,
        properties: {
          planning_class: feature.properties.planning_class,
          raw_zoning_label: feature.properties.raw_zoning_label,
          confidence: feature.properties.confidence,
          source_type: 'digitized',
          source_name: sourceName,
          human_confirmed: feature.properties.human_confirmed,
          notes: feature.properties.notes,
          digitized_at: digitizedAt,
          digitized_by: feature.properties.digitized_by
        }
      };
    })
  };
}
