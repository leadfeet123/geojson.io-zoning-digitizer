import {
  createParcelBoundaryIndex,
  createLocalParcelBoundaryIndex,
  snapPolygonToParcelBoundaries
} from './parcel_snapping';
import { describe, expect, it } from 'vitest';

const parcelCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0.001, 0],
            [0.001, 0.001],
            [0, 0.001],
            [0, 0]
          ]
        ]
      }
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0.001, 0],
            [0.002, 0],
            [0.002, 0.001],
            [0.001, 0.001],
            [0.001, 0]
          ]
        ]
      }
    }
  ]
};

const insetPdfZone: [number, number][] = [
  [0.00004, 0.00004],
  [0.00196, 0.00004],
  [0.00196, 0.00096],
  [0.00004, 0.00096],
  [0.00004, 0.00004]
];

describe('parcel-assisted boundary snapping', () => {
  it('snaps a zone spanning parcels to its outer parcel edges, not the shared edge', () => {
    const index = createParcelBoundaryIndex(parcelCollection);

    const result = snapPolygonToParcelBoundaries(insetPdfZone, index, 5);

    expect(result.applied).toBe(true);
    expect(result.alignmentRatio).toBeGreaterThanOrEqual(0.5);
    expect(result.snappedVertexCount).toBeGreaterThan(0);
    expect(result.coordinates[result.coordinates.length - 1]).toEqual(
      result.coordinates[0]
    );
    expect(
      result.coordinates.every(([lon]) => Math.abs(lon - 0.001) > 0.0001)
    ).toBe(true);
  });

  it('keeps the PDF outline when parcel edges do not sufficiently align', () => {
    const index = createParcelBoundaryIndex(parcelCollection);
    const unrelatedPdfZone: [number, number][] = [
      [0.01, 0.01],
      [0.011, 0.01],
      [0.011, 0.011],
      [0.01, 0.011],
      [0.01, 0.01]
    ];

    const result = snapPolygonToParcelBoundaries(unrelatedPdfZone, index, 5);

    expect(result.applied).toBe(false);
    expect(result.alignmentRatio).toBe(0);
    expect(result.coordinates).toEqual(unrelatedPdfZone);
  });

  it('honors the user-selected distance tolerance', () => {
    const index = createParcelBoundaryIndex(parcelCollection);

    const strictResult = snapPolygonToParcelBoundaries(insetPdfZone, index, 3);
    const defaultResult = snapPolygonToParcelBoundaries(insetPdfZone, index, 5);

    expect(strictResult.applied).toBe(false);
    expect(defaultResult.applied).toBe(true);
  });

  it('rejects non-polygon parcel collections rather than silently ignoring them', () => {
    expect(() =>
      createParcelBoundaryIndex({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] }
          }
        ]
      })
    ).toThrow(
      'Every parcel feature must have Polygon or MultiPolygon geometry.'
    );
  });

  it('streams only parcel edges within buffered extracted-shape bounds', async () => {
    const farParcel = {
      ...parcelCollection.features[0],
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 10],
            [11, 10],
            [11, 11],
            [10, 11],
            [10, 10]
          ]
        ]
      }
    };
    const file = new Blob([
      JSON.stringify({
        features: [...parcelCollection.features, farParcel],
        type: 'FeatureCollection'
      })
    ]);

    const result = await createLocalParcelBoundaryIndex(
      file,
      [insetPdfZone],
      5
    );

    expect(result.scannedParcelCount).toBe(3);
    expect(result.parcelIndex?.parcelCount).toBe(2);
    expect(result.parcelIndex?.edges.every((edge) => edge.maxX < 1)).toBe(true);
    expect(
      snapPolygonToParcelBoundaries(insetPdfZone, result.parcelIndex!, 5)
        .applied
    ).toBe(true);
  });

  it('includes an edge crossing the search area even when both endpoints are outside', async () => {
    const file = new Blob([
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-1, 0],
                  [1, 0],
                  [1, 1],
                  [-1, 1],
                  [-1, 0]
                ]
              ]
            }
          }
        ]
      })
    ]);
    const result = await createLocalParcelBoundaryIndex(
      file,
      [insetPdfZone],
      5
    );
    expect(result.parcelIndex?.parcelCount).toBe(1);
    expect(result.parcelIndex?.edges).toHaveLength(1);
  });

  it('returns no index when all parcels are far away', async () => {
    const result = await createLocalParcelBoundaryIndex(
      new Blob([JSON.stringify(parcelCollection)]),
      [
        [
          [10, 10],
          [11, 10],
          [11, 11],
          [10, 11],
          [10, 10]
        ]
      ],
      5
    );
    expect(result.parcelIndex).toBeNull();
    expect(result.scannedParcelCount).toBe(2);
  });

  it('uses the union of each extracted shape and applies the tolerance buffer', async () => {
    const square = (x: number) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [x, 0],
            [x + 0.001, 0],
            [x + 0.001, 0.001],
            [x, 0.001],
            [x, 0]
          ]
        ]
      }
    });
    const file = new Blob([
      JSON.stringify({
        type: 'FeatureCollection',
        features: [square(0), square(0.01), square(0.02)]
      })
    ]);
    const firstRing: [number, number][] = [
      [0.00004, 0.00004],
      [0.00096, 0.00004],
      [0.00096, 0.00096],
      [0.00004, 0.00096],
      [0.00004, 0.00004]
    ];
    const lastRing = firstRing.map(([x, y]): [number, number] => [x + 0.02, y]);
    const withinTolerance = await createLocalParcelBoundaryIndex(
      file,
      [firstRing, lastRing],
      5
    );
    const outsideTolerance = await createLocalParcelBoundaryIndex(
      file,
      [firstRing, lastRing],
      3
    );
    expect(withinTolerance.parcelIndex?.parcelCount).toBe(2);
    expect(outsideTolerance.parcelIndex).toBeNull();
  });

  it('handles feature and UTF-8 data split across file chunks', async () => {
    const file = new Blob([
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            ...parcelCollection.features[0],
            properties: { padding: 'x'.repeat(1024 * 1024 - 40) + 'é' }
          },
          parcelCollection.features[1]
        ]
      })
    ]);

    const result = await createLocalParcelBoundaryIndex(
      file,
      [insetPdfZone],
      5
    );
    expect(result.scannedParcelCount).toBe(2);
    expect(result.parcelIndex?.parcelCount).toBe(2);
  });

  it('rejects malformed, truncated and non-collection input', async () => {
    const ring = [insetPdfZone];
    for (const json of [
      '{"type":"FeatureCollection","features":[',
      JSON.stringify({
        type: 'NotACollection',
        features: parcelCollection.features
      }),
      JSON.stringify({
        type: 'FeatureCollection',
        features: { foo: parcelCollection.features[0] }
      })
    ]) {
      await expect(
        createLocalParcelBoundaryIndex(new Blob([json]), ring, 5)
      ).rejects.toThrow();
    }
  });
});
