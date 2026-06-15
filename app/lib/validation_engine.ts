import { getIssues } from '@placemarkio/check-geojson';
import type {
  DigitizerFeature,
  ValidationResult
} from 'types/digitizer';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateGeometry(feature: DigitizerFeature): ValidationResult[] {
  const issues = getIssues(
    JSON.stringify({
      type: 'Feature',
      geometry: feature.geometry,
      properties: feature.properties
    })
  );

  return issues.map((issue) => ({
    featureId: feature.id ?? null,
    severity: 'error' as const,
    message: issue.message,
    field: 'geometry' as const
  }));
}

/**
 * Validates a single digitizer feature against Phase 1 schema and geometry rules.
 */
export function validateFeature(feature: DigitizerFeature): ValidationResult[] {
  const errors: ValidationResult[] = [];

  if (!isNonEmptyString(feature.properties.planning_class)) {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'planning_class',
      message: 'planning_class is required'
    });
  }

  if (!isNonEmptyString(feature.properties.raw_zoning_label)) {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'raw_zoning_label',
      message: 'raw_zoning_label is required'
    });
  }

  if (!isNonEmptyString(feature.properties.source_name)) {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'source_name',
      message: 'source_name is required'
    });
  }

  if (feature.properties.source_type !== 'digitized') {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'source_type',
      message: 'source_type must be "digitized"'
    });
  }

  if (typeof feature.properties.human_confirmed !== 'boolean') {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'human_confirmed',
      message: 'human_confirmed must be a boolean'
    });
  }

  if (
    typeof feature.properties.confidence !== 'number' ||
    Number.isNaN(feature.properties.confidence) ||
    feature.properties.confidence < 0 ||
    feature.properties.confidence > 1
  ) {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'confidence',
      message: 'confidence must be a number between 0.0 and 1.0'
    });
  }

  if (
    feature.properties.confidence < 0.5 &&
    feature.properties.human_confirmed === false
  ) {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'confidence',
      message:
        'features with confidence < 0.5 must be human-confirmed before export'
    });
  }

  if (
    feature.geometry.type !== 'Polygon' &&
    feature.geometry.type !== 'MultiPolygon'
  ) {
    errors.push({
      featureId: feature.id ?? null,
      severity: 'error',
      field: 'geometry',
      message: 'geometry must be Polygon or MultiPolygon'
    });
  } else {
    errors.push(...validateGeometry(feature));
  }

  return errors;
}

/**
 * Validates all digitizer features and flattens errors into a single list.
 */
export function validateFeatureCollection(
  features: DigitizerFeature[]
): ValidationResult[] {
  return features.flatMap((feature) => validateFeature(feature));
}

export type { DigitizerFeature, ValidationResult };
