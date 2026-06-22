import { describe, it, expect } from 'vitest';
import { optimizeGeoJSON } from '../app/lib/map_operations/optimize_geojson';

describe('optimizeGeoJSON', () => {
  it('should merge adjacent polygons with the same zone_code', () => {
    const input: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { zone_code: 'A' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
          }
        },
        {
          type: 'Feature',
          properties: { zone_code: 'A' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[1, 0], [1, 1], [2, 1], [2, 0], [1, 0]]]
          }
        }
      ]
    };

    const result = optimizeGeoJSON(input);
    expect(result.features.length).toBe(1);
    expect(result.features[0].properties?.zone_code).toBe('A');
  });

  it('should not merge polygons with different zone_codes', () => {
    const input: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { zone_code: 'A' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
          }
        },
        {
          type: 'Feature',
          properties: { zone_code: 'B' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[1, 0], [1, 1], [2, 1], [2, 0], [1, 0]]]
          }
        }
      ]
    };

    const result = optimizeGeoJSON(input);
    expect(result.features.length).toBe(2);
  });
});
