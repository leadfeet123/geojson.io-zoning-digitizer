import type { FeatureCollection } from 'types';
import type { DigitizerFeature } from './validation_engine';

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
