import {
  classifyPdfTextItems,
  extractAndMergePdfTextItems,
  inferVectorStreetCrossings,
  parseEmbeddedGeoPdfControlPoints,
  type PdfViewportLike
} from 'app/lib/pdf_georef_extractor';
import { describe, expect, it } from 'vitest';

const letterViewport: PdfViewportLike = {
  width: 792,
  height: 612,
  // Standard PDF bottom-left origin -> top-left viewport origin
  convertToViewportPoint(x: number, y: number): [number, number] {
    return [x, 612 - y];
  }
};

describe('pdf_georef_extractor', () => {
  it('merges fragmented CAD glyph runs and classifies title vs street labels', () => {
    const rawItems = [
      // Header title split into words
      {
        str: 'VILLAGE OF',
        transform: [18, 0, 0, 18, 80, 560],
        width: 95,
        height: 18
      },
      {
        str: 'OAK PARK, IL',
        transform: [18, 0, 0, 18, 182, 560],
        width: 115,
        height: 18
      },
      // Horizontal street split character-by-character: "W" " " "LAKE" " " "ST"
      { str: 'W', transform: [8, 0, 0, 8, 200, 412], width: 7, height: 8 },
      { str: 'LAKE', transform: [8, 0, 0, 8, 211, 412], width: 22, height: 8 },
      { str: 'ST', transform: [8, 0, 0, 8, 237, 412], width: 11, height: 8 },
      // Vertical street rotated 90° CCW in PDF space: [0, 8, -8, 0, 410, 200] -> upwards in PDF = -90° in viewport
      {
        str: 'N HARLEM AVE',
        transform: [0, 8, -8, 0, 410, 220],
        width: 68,
        height: 8
      }
    ];

    const merged = extractAndMergePdfTextItems(rawItems, letterViewport);
    const texts = merged.map((m) => m.text);
    expect(texts).toContain('VILLAGE OF OAK PARK, IL');
    expect(texts).toContain('W LAKE ST');
    expect(texts).toContain('N HARLEM AVE');

    const { titleTextCandidates, streetTextItems } =
      classifyPdfTextItems(merged);
    expect(titleTextCandidates).toContain('VILLAGE OF OAK PARK, IL');
    expect(streetTextItems.map((s) => s.text)).toEqual(
      expect.arrayContaining(['W LAKE ST', 'N HARLEM AVE'])
    );

    const crossings = inferVectorStreetCrossings(streetTextItems, 792, 612);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].pdf.x).toBeCloseTo(410, -1);
    expect(crossings[0].pdf.y).toBeCloseTo(612 - 412, -1);
  });

  it('extracts and validates embedded ISO 32000 GeoPDF /VP control points', () => {
    const fakeGeoPdfAscii = `%PDF-1.7
1 0 obj
<< /Type /Page /MediaBox [0 0 792 612] /VP [ 2 0 R ] >>
endobj
2 0 obj
<< /Type /Viewport /BBox [ 50 40 742 572 ] /Measure 3 0 R >>
endobj
3 0 obj
<< /Type /Measure /Subtype /GEO
   /Bounds [ 0 0 0 1 1 1 1 0 ]
   /LPTS [ 0 0 0 1 1 1 1 0 ]
   /GPTS [ 40.0950 -88.2700 40.1250 -88.2700 40.1250 -88.2180 40.0950 -88.2180 ]
>>
endobj
%%EOF`;

    const bytes = new TextEncoder().encode(fakeGeoPdfAscii);
    const points = parseEmbeddedGeoPdfControlPoints(bytes, letterViewport);

    expect(points).toHaveLength(4);
    // Lower-left LPTS (0, 0) => PDF (50, 40) => viewport (50, 612 - 40 = 572) => (lat 40.095, lon -88.27)
    const lowerLeft = points.find(
      (p) => Math.abs(p.pdf.x - 50) < 1 && Math.abs(p.pdf.y - 572) < 1
    );
    expect(lowerLeft).toBeDefined();
    expect(lowerLeft!.map.lon).toBeCloseTo(-88.27, 5);
    expect(lowerLeft!.map.lat).toBeCloseTo(40.095, 5);

    // Upper-right LPTS (1, 1) => PDF (742, 572) => viewport (742, 612 - 572 = 40) => (lat 40.125, lon -88.218)
    const upperRight = points.find(
      (p) => Math.abs(p.pdf.x - 742) < 1 && Math.abs(p.pdf.y - 40) < 1
    );
    expect(upperRight).toBeDefined();
    expect(upperRight!.map.lon).toBeCloseTo(-88.218, 5);
    expect(upperRight!.map.lat).toBeCloseTo(40.125, 5);
  });
});
