import { describe, expect, it } from 'vitest';
import { assembleZoningGeoJSON, type OptimizedPolygon, type ZoningMetadata } from '../app/lib/geojson_assembly';
import type { AffineTransform } from '../app/lib/transform_engine';

describe('geojson_assembly', () => {
  const mockTransform: AffineTransform = {
    lon: { a: 1, b: 0, c: 0 }, // x -> lon
    lat: { d: 0, e: 1, f: 0 }  // y -> lat
  };

  it('transforms and closes geometries correctly, and maps metadata', () => {
    const polygons: OptimizedPolygon[] = [
      {
        zoning_id: 'zone-1',
        coordinates: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 }
          // intentionally unclosed
        ]
      },
      {
        zoning_id: 'zone-2',
        coordinates: [
          { x: 20, y: 20 },
          { x: 30, y: 20 },
          { x: 30, y: 30 },
          { x: 20, y: 20 }
          // intentionally already closed
        ]
      }
    ];

    const metadata: ZoningMetadata = {
      'zone-1': {
        zone_code: 'R1',
        color: '#ff0000',
        description: 'Residential 1'
      },
      'zone-2': {
        zone_code: 'C1',
        color: '#00ff00',
        description: 'Commercial 1'
      }
    };

    const geojson = assembleZoningGeoJSON(polygons, mockTransform, metadata);

    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features).toHaveLength(2);

    const feature1 = geojson.features[0];
    expect(feature1.geometry.type).toBe('Polygon');
    expect(feature1.geometry.coordinates[0]).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0] // closed automatically
    ]);
    expect(feature1.properties).toEqual({
      zoning_id: 'zone-1',
      zone_code: 'R1',
      color: '#ff0000',
      description: 'Residential 1'
    });

    const feature2 = geojson.features[1];
    expect(feature2.geometry.type).toBe('Polygon');
    expect(feature2.geometry.coordinates[0]).toEqual([
      [20, 20],
      [30, 20],
      [30, 30],
      [20, 20] // remained closed without duplicate
    ]);
    expect(feature2.properties).toEqual({
      zoning_id: 'zone-2',
      zone_code: 'C1',
      color: '#00ff00',
      description: 'Commercial 1'
    });
  });

  it('handles empty coordinates array', () => {
    const polygons: OptimizedPolygon[] = [
      {
        zoning_id: 'zone-empty',
        coordinates: []
      }
    ];

    const geojson = assembleZoningGeoJSON(polygons, mockTransform, {});
    expect(geojson.features[0].geometry.coordinates[0]).toEqual([]);
  });

  it('handles missing metadata gracefully', () => {
    const polygons: OptimizedPolygon[] = [
      {
        zoning_id: 'unknown-zone',
        coordinates: [{ x: 1, y: 1 }, { x: 2, y: 2 }]
      }
    ];

    const geojson = assembleZoningGeoJSON(polygons, mockTransform, {});
    expect(geojson.features[0].properties).toEqual({ zoning_id: 'unknown-zone' });
  });
});
