import dissolve from '@turf/dissolve';

import type { FeatureCollection } from 'geojson';

/**
 * Optimizes a GeoJSON FeatureCollection by merging adjacent or overlapping
 * polygons that share the same zoning code.
 *
 * @param geojson - A valid GeoJSON FeatureCollection generated from the OpenCV contour extraction.
 *                  Each feature should have a property called 'zone_code'.
 * @returns The optimized GeoJSON FeatureCollection.
 */
export function optimizeGeoJSON(geojson: FeatureCollection): FeatureCollection {
  if (geojson.type !== 'FeatureCollection') {
    throw new Error('Input must be a FeatureCollection');
  }

  // Ensure every feature has a zone_code
  geojson.features.forEach((feature) => {
    if (!feature.properties || feature.properties.zone_code === undefined) {
      throw new Error("Each feature must have a 'zone_code' property.");
    }
  });

  // dissolve groups by the specified property and merges touching/overlapping geometries
  const dissolved = dissolve(geojson, { propertyName: 'zone_code' });
  return dissolved;
}
