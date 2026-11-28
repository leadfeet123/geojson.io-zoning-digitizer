import { classifyParcelsFromPdfZoning } from 'app/lib/parcel_zoning_classifier';
import { transformPoint, type AffineTransform } from 'app/lib/transform_engine';
import { validateFeatureCollection } from 'app/lib/validation_engine';
import { describe, expect, it } from 'vitest';

const affineTransform: AffineTransform = {
  type: 'affine',
  lon: { a: 0.0001, b: 0, c: -88.3 },
  lat: { d: 0, e: -0.0001, f: 40.2 }
};

function makeParcelFeatureFromPdfRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number
) {
  const p00 = transformPoint(affineTransform, { x: x0, y: y0 });
  const p10 = transformPoint(affineTransform, { x: x1, y: y0 });
  const p11 = transformPoint(affineTransform, { x: x1, y: y1 });
  const p01 = transformPoint(affineTransform, { x: x0, y: y1 });

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [p00.lon, p00.lat],
          [p10.lon, p10.lat],
          [p11.lon, p11.lat],
          [p01.lon, p01.lat],
          [p00.lon, p00.lat]
        ]
      ]
    }
  };
}

describe('parcel_zoning_classifier', () => {
  const legend = {
    boundary_line: '#000000',
    zones: [
      {
        code: 'R-1',
        description: 'Single-Family Residential',
        color: '#f7eeb5'
      },
      { code: 'C-2', description: 'General Commercial', color: '#e63946' }
    ]
  };

  it('classifies dozens of small parcels from raster PDF even with black borders and text ink', async () => {
    const pdfWidth = 200;
    const pdfHeight = 200;
    const rasterScale = 2; // 400 x 400 raster
    const rw = pdfWidth * rasterScale;
    const rh = pdfHeight * rasterScale;
    const data = new Uint8ClampedArray(rw * rh * 4).fill(255); // white paper

    // Paint 40 small 10x10 PDF-pt parcels: 20 R-1 on top row, 20 C-2 on second row,
    // with black parcel borders AND black text ink across parcel centers!
    const parcelFeatures = [];

    for (let i = 0; i < 20; i++) {
      const x0 = i * 10;
      const x1 = x0 + 10;
      parcelFeatures.push(makeParcelFeatureFromPdfRect(x0, 20, x1, 30));
      parcelFeatures.push(makeParcelFeatureFromPdfRect(x0, 40, x1, 50));

      // Fill R-1 row (y:[20..30] in PDF -> py:[40..60] in raster)
      for (let py = 40; py < 60; py++) {
        for (let px = x0 * 2; px < x1 * 2; px++) {
          const off = (py * rw + px) * 4;
          const isBorder =
            py === 40 || py === 59 || px === x0 * 2 || px === x1 * 2 - 1;
          const isTextStripe = py === 50 && px % 3 === 0;
          data[off] = isBorder || isTextStripe ? 10 : 247;
          data[off + 1] = isBorder || isTextStripe ? 10 : 238;
          data[off + 2] = isBorder || isTextStripe ? 10 : 181;
          data[off + 3] = 255;
        }
      }

      // Fill C-2 row (y:[40..50] in PDF -> py:[80..100] in raster)
      for (let py = 80; py < 100; py++) {
        for (let px = x0 * 2; px < x1 * 2; px++) {
          const off = (py * rw + px) * 4;
          const isBorder =
            py === 80 || py === 99 || px === x0 * 2 || px === x1 * 2 - 1;
          data[off] = isBorder ? 0 : 230;
          data[off + 1] = isBorder ? 0 : 57;
          data[off + 2] = isBorder ? 0 : 70;
          data[off + 3] = 255;
        }
      }
    }

    // Add 5 unzoned white parcels and 2 far-away parcels outside the PDF map
    for (let u = 0; u < 5; u++) {
      parcelFeatures.push(
        makeParcelFeatureFromPdfRect(u * 15, 140, u * 15 + 12, 155)
      );
    }
    parcelFeatures.push(makeParcelFeatureFromPdfRect(5000, 5000, 5020, 5020));

    const parcelBlob = new Blob([
      JSON.stringify({ type: 'FeatureCollection', features: parcelFeatures })
    ]);

    const result = await classifyParcelsFromPdfZoning({
      parcelFile: parcelBlob,
      transform: affineTransform,
      pdfPageWidth: pdfWidth,
      pdfPageHeight: pdfHeight,
      legend,
      sourceName: 'city_zoning.pdf',
      rasterImage: { width: rw, height: rh, data },
      rasterScale,
      mode: 'classify_parcels'
    });

    expect(result.scannedParcelCount).toBe(46);
    expect(result.classifiedParcelCount).toBe(40);
    expect(result.features).toHaveLength(40);
    expect(
      result.features.filter((f) => f.properties.raw_zoning_label === 'R-1')
    ).toHaveLength(20);
    expect(
      result.features.filter((f) => f.properties.raw_zoning_label === 'C-2')
    ).toHaveLength(20);
    expect(validateFeatureCollection(result.features)).toEqual([]);
  });

  it('dissolves adjacent same-zone parcels into district polygons and flags split-zoned parcels', async () => {
    const parcels = [
      makeParcelFeatureFromPdfRect(10, 10, 30, 30), // 100% R-1
      makeParcelFeatureFromPdfRect(30, 10, 50, 30), // 100% R-1 (adjacent!)
      makeParcelFeatureFromPdfRect(60, 10, 100, 30) // 50% R-1 / 50% C-2 split parcel!
    ];
    const parcelBlob = new Blob([
      JSON.stringify({ type: 'FeatureCollection', features: parcels })
    ]);

    const vectorPolygons = [
      {
        legendItem: legend.zones[0],
        zoneIndex: 0,
        outerRing: [
          { x: 10, y: 10 },
          { x: 80, y: 10 },
          { x: 80, y: 30 },
          { x: 10, y: 30 },
          { x: 10, y: 10 }
        ],
        holes: [],
        pdfArea: 1400,
        confidence: 0.95
      },
      {
        legendItem: legend.zones[1],
        zoneIndex: 1,
        outerRing: [
          { x: 80, y: 10 },
          { x: 100, y: 10 },
          { x: 100, y: 30 },
          { x: 80, y: 30 },
          { x: 80, y: 10 }
        ],
        holes: [],
        pdfArea: 400,
        confidence: 0.95
      }
    ];

    const individual = await classifyParcelsFromPdfZoning({
      parcelFile: parcelBlob,
      transform: affineTransform,
      pdfPageWidth: 200,
      pdfPageHeight: 200,
      legend,
      sourceName: 'vector_zoning.pdf',
      vectorPolygons,
      mode: 'classify_parcels'
    });

    expect(individual.features).toHaveLength(3);
    expect(individual.ambiguousParcelCount).toBe(1);
    expect(individual.features[2].properties.confidence).toBeLessThan(0.5);
    expect(individual.features[2].properties.notes).toContain('Split');

    const dissolved = await classifyParcelsFromPdfZoning({
      parcelFile: new Blob([
        JSON.stringify({
          type: 'FeatureCollection',
          features: parcels.slice(0, 2)
        })
      ]),
      transform: affineTransform,
      pdfPageWidth: 200,
      pdfPageHeight: 200,
      legend,
      sourceName: 'vector_zoning.pdf',
      vectorPolygons,
      mode: 'dissolve_parcels'
    });

    // Two adjacent R-1 parcels merge into 1 contiguous R-1 district polygon
    expect(dissolved.features).toHaveLength(1);
    expect(dissolved.features[0].properties.raw_zoning_label).toBe('R-1');
    expect(validateFeatureCollection(dissolved.features)).toEqual([]);
  });
});
