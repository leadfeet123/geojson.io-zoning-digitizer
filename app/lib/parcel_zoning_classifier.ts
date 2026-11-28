import { rewindGeometry } from '@placemarkio/geojson-rewind';
import Flatbush from 'flatbush';
import polygonClipping from 'polygon-clipping';
import polylabel from 'polylabel';
import {
  createLegendColorLut,
  type LegendColorLut,
  type RgbaImageLike
} from 'app/lib/color_calibration';
import { newFeatureId } from 'app/lib/id';
import type { LegendResult } from 'app/lib/ocr_adapter';
import type { VectorExtractedPolygon } from 'app/lib/pdf_vector_extractor';
import {
  computePdfPageBoundsOnMap,
  inverseTransformPoint,
  type SolvedTransform
} from 'app/lib/transform_engine';
import type { MultiPolygon, Polygon } from 'types';
import type { DigitizerFeature } from 'types/digitizer';

type Pair = [number, number];
type Ring = Pair[];
type PolyCoords = Ring[];

/** Output strategy when classifying zoning against a local parcel dataset. */
export type ParcelExtractionMode =
  | 'classify_parcels'
  | 'dissolve_parcels'
  | 'snap_outlines';

/** Inputs for parcel-driven zoning classification against a georeferenced PDF page. */
export interface ParcelZoningClassificationOptions {
  parcelFile: Blob;
  transform: SolvedTransform;
  pdfPageWidth: number;
  pdfPageHeight: number;
  legend: LegendResult;
  sourceName: string;
  vectorPolygons?: ReadonlyArray<VectorExtractedPolygon>;
  rasterImage?: RgbaImageLike | null;
  rasterScale?: number;
  mode?: 'classify_parcels' | 'dissolve_parcels';
  marginMeters?: number;
  onStatus?: (message: string) => void;
}

/** Summary diagnostics and output features from parcel-driven zoning classification. */
export interface ParcelZoningClassificationResult {
  features: DigitizerFeature[];
  scannedParcelCount: number;
  inBoundsParcelCount: number;
  classifiedParcelCount: number;
  ambiguousParcelCount: number;
}

interface ParsedParcelCandidate {
  mapMultiPoly: PolyCoords[];
  bbox: [number, number, number, number];
}

interface ClassifiedParcelRecord {
  zoneIndex: number;
  confidence: number;
  notes?: string;
  mapMultiPoly: PolyCoords[];
  pdfArea: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseWgs84Pair(value: unknown): Pair {
  if (
    !Array.isArray(value) ||
    typeof value[0] !== 'number' ||
    typeof value[1] !== 'number' ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    value[0] < -180 ||
    value[0] > 180 ||
    value[1] < -90 ||
    value[1] > 90
  ) {
    throw new Error(
      'Parcel coordinates must be valid WGS-84 longitude/latitude pairs.'
    );
  }
  return [value[0], value[1]];
}

function parseWgs84Ring(
  value: unknown,
  boundsTracker: [number, number, number, number]
): Ring {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(
      'Parcel polygon rings must contain at least three coordinates.'
    );
  }
  const ring: Ring = [];
  for (const rawPt of value) {
    const pt = parseWgs84Pair(rawPt);
    if (pt[0] < boundsTracker[0]) boundsTracker[0] = pt[0];
    if (pt[1] < boundsTracker[1]) boundsTracker[1] = pt[1];
    if (pt[0] > boundsTracker[2]) boundsTracker[2] = pt[0];
    if (pt[1] > boundsTracker[3]) boundsTracker[3] = pt[1];
    if (ring.length > 0) {
      const prev = ring[ring.length - 1];
      if (prev[0] === pt[0] && prev[1] === pt[1]) continue;
    }
    ring.push(pt);
  }
  if (ring.length < 3) {
    throw new Error(
      'Parcel polygon rings must contain at least three distinct coordinates.'
    );
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  if (ring.length < 4) {
    throw new Error(
      'Parcel polygon rings must contain at least three distinct coordinates.'
    );
  }
  return ring;
}

function parseParcelCandidate(feature: unknown): ParsedParcelCandidate {
  if (!isRecord(feature) || !isRecord(feature.geometry)) {
    throw new Error(
      'Every parcel feature must have Polygon or MultiPolygon geometry.'
    );
  }

  const bbox: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity
  ];
  const geom = feature.geometry;

  if (geom.type === 'Polygon') {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
      throw new Error('Parcel polygon geometry is missing coordinate rings.');
    }
    const poly: PolyCoords = geom.coordinates.map((r) =>
      parseWgs84Ring(r, bbox)
    );
    return { mapMultiPoly: [poly], bbox };
  }

  if (
    geom.type === 'MultiPolygon' &&
    Array.isArray(geom.coordinates) &&
    geom.coordinates.length > 0
  ) {
    const multi: PolyCoords[] = geom.coordinates.map((polyRaw) => {
      if (!Array.isArray(polyRaw) || polyRaw.length === 0) {
        throw new Error('Parcel polygon geometry is missing coordinate rings.');
      }
      return polyRaw.map((r) => parseWgs84Ring(r, bbox));
    });
    return { mapMultiPoly: multi, bbox };
  }

  throw new Error(
    'Every parcel feature must have Polygon or MultiPolygon geometry.'
  );
}

/**
 * Streams a local or statewide Parcel GeoJSON file, classifies every parcel
 * intersecting the georeferenced PDF page against vector fills and/or high-DPI
 * CIELAB pixels, and returns survey-grade zoned parcel or dissolved district features.
 */
export async function classifyParcelsFromPdfZoning(
  options: ParcelZoningClassificationOptions
): Promise<ParcelZoningClassificationResult> {
  const {
    parcelFile,
    transform,
    pdfPageWidth,
    pdfPageHeight,
    legend,
    sourceName,
    vectorPolygons = [],
    rasterImage = null,
    rasterScale = 1,
    mode = 'classify_parcels',
    marginMeters = 25,
    onStatus
  } = options;

  if (legend.zones.length === 0) {
    return {
      features: [],
      scannedParcelCount: 0,
      inBoundsParcelCount: 0,
      classifiedParcelCount: 0,
      ambiguousParcelCount: 0
    };
  }

  const mapBounds = computePdfPageBoundsOnMap(
    transform,
    pdfPageWidth,
    pdfPageHeight,
    marginMeters
  );

  onStatus?.('Streaming parcel file within georeferenced PDF page bounds...');
  const { candidates, scannedParcelCount } = await streamParcelsInMapBounds(
    parcelFile,
    mapBounds
  );

  if (candidates.length === 0) {
    return {
      features: [],
      scannedParcelCount,
      inBoundsParcelCount: 0,
      classifiedParcelCount: 0,
      ambiguousParcelCount: 0
    };
  }

  onStatus?.(
    `Evaluating zoning across ${candidates.length} parcel${candidates.length === 1 ? '' : 's'} in map area...`
  );

  const lut = createLegendColorLut(legend.zones, legend.boundary_line);
  const indexedVectors = buildVectorSpatialIndex(vectorPolygons);

  const classifiedRecords: ClassifiedParcelRecord[] = [];
  let inBoundsParcelCount = 0;
  let ambiguousParcelCount = 0;

  for (const candidate of candidates) {
    const pdfMultiPoly: PolyCoords[] = candidate.mapMultiPoly.map((poly) =>
      poly.map((ring) =>
        ring.map(([lon, lat]): Pair => {
          const pdfPt = inverseTransformPoint(transform, { lon, lat });
          return [pdfPt.x, pdfPt.y];
        })
      )
    );

    const pdfStats = computeMultiPolyPdfBoundsAndArea(pdfMultiPoly);
    if (pdfStats.area <= 1e-6) continue;

    // Require parcel to overlap the PDF page interior
    if (
      pdfStats.bbox[2] < 0 ||
      pdfStats.bbox[0] > pdfPageWidth ||
      pdfStats.bbox[3] < 0 ||
      pdfStats.bbox[1] > pdfPageHeight
    ) {
      continue;
    }

    inBoundsParcelCount++;

    let decision =
      indexedVectors !== null
        ? evaluateParcelAgainstVectors(
            pdfMultiPoly,
            pdfStats.bbox,
            pdfStats.area,
            indexedVectors,
            legend
          )
        : null;

    if (!decision && rasterImage && rasterScale > 0) {
      decision = evaluateParcelAgainstRaster(
        pdfMultiPoly,
        rasterImage,
        rasterScale,
        lut,
        legend
      );
    }

    if (!decision) continue;

    if (decision.confidence < 0.5) {
      ambiguousParcelCount++;
    }

    classifiedRecords.push({
      zoneIndex: decision.zoneIndex,
      confidence: decision.confidence,
      notes: decision.notes,
      mapMultiPoly: candidate.mapMultiPoly,
      pdfArea: pdfStats.area
    });
  }

  const features =
    mode === 'dissolve_parcels'
      ? buildDissolvedZoneFeatures(classifiedRecords, legend, sourceName)
      : buildIndividualParcelFeatures(classifiedRecords, legend, sourceName);

  return {
    features,
    scannedParcelCount,
    inBoundsParcelCount,
    classifiedParcelCount: classifiedRecords.length,
    ambiguousParcelCount
  };
}

async function streamParcelsInMapBounds(
  file: Blob,
  mapBounds: [number, number, number, number]
): Promise<{
  candidates: ParsedParcelCandidate[];
  scannedParcelCount: number;
}> {
  const { JSONParser } = await import('@streamparser/json');
  const parser = new JSONParser({
    paths: ['$.type', '$.features.*'],
    keepStack: false
  });

  const candidates: ParsedParcelCandidate[] = [];
  let collectionType: unknown;
  let scannedParcelCount = 0;

  parser.onValue = ({ value, key, parent, stack }) => {
    if (key === 'type' && stack.length === 1) {
      collectionType = value;
      return;
    }
    if (!Array.isArray(parent) || typeof key !== 'number') {
      throw new Error('Parcel features must be an array of GeoJSON features.');
    }
    scannedParcelCount++;
    const parsed = parseParcelCandidate(value);
    if (bboxesIntersect(parsed.bbox, mapBounds)) {
      candidates.push(parsed);
    }
  };

  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
    parser.write(new Uint8Array(chunk));
  }
  if (!parser.isEnded) parser.end();

  if (collectionType !== 'FeatureCollection' || scannedParcelCount === 0) {
    throw new Error(
      'Parcel data must be a non-empty GeoJSON FeatureCollection.'
    );
  }

  return { candidates, scannedParcelCount };
}

interface IndexedVectorEntry {
  zoneIndex: number;
  confidence: number;
  coords: PolyCoords;
  bbox: [number, number, number, number];
}

function buildVectorSpatialIndex(
  vectorPolygons: ReadonlyArray<VectorExtractedPolygon>
): { index: Flatbush; entries: IndexedVectorEntry[] } | null {
  if (vectorPolygons.length === 0) return null;

  const entries: IndexedVectorEntry[] = [];
  for (const vp of vectorPolygons) {
    if (vp.outerRing.length < 4) continue;
    const outer: Ring = vp.outerRing.map((p) => [p.x, p.y]);
    const holes: Ring[] = vp.holes.map((h) => h.map((p) => [p.x, p.y]));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outer) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    entries.push({
      zoneIndex: vp.zoneIndex,
      confidence: vp.confidence,
      coords: [outer, ...holes],
      bbox: [minX, minY, maxX, maxY]
    });
  }

  if (entries.length === 0) return null;

  const index = new Flatbush(entries.length);
  for (const e of entries) {
    index.add(e.bbox[0], e.bbox[1], e.bbox[2], e.bbox[3]);
  }
  index.finish();
  return { index, entries };
}

function evaluateParcelAgainstVectors(
  parcelPdfMultiPoly: PolyCoords[],
  parcelBbox: [number, number, number, number],
  parcelArea: number,
  vectorStore: { index: Flatbush; entries: IndexedVectorEntry[] },
  legend: LegendResult
): { zoneIndex: number; confidence: number; notes?: string } | null {
  const hitIds = vectorStore.index.search(
    parcelBbox[0],
    parcelBbox[1],
    parcelBbox[2],
    parcelBbox[3]
  );
  if (hitIds.length === 0) return null;

  const areaByZone = new Float64Array(legend.zones.length);
  const confWeightedByZone = new Float64Array(legend.zones.length);

  for (const id of hitIds) {
    const vec = vectorStore.entries[id];
    try {
      const clipped = polygonClipping.intersection(parcelPdfMultiPoly, [
        vec.coords
      ]) as PolyCoords[];
      if (clipped.length === 0) continue;
      const overlapArea = computeMultiPolyAreaOnly(clipped);
      if (overlapArea > 0) {
        areaByZone[vec.zoneIndex] += overlapArea;
        confWeightedByZone[vec.zoneIndex] += overlapArea * vec.confidence;
      }
    } catch {
      // Ignore degenerate clipping pairs
    }
  }

  let totalMatched = 0;
  let bestZone = -1;
  let bestArea = 0;
  let secondZone = -1;
  let secondArea = 0;

  for (let z = 0; z < areaByZone.length; z++) {
    const a = areaByZone[z];
    totalMatched += a;
    if (a > bestArea) {
      secondArea = bestArea;
      secondZone = bestZone;
      bestArea = a;
      bestZone = z;
    } else if (a > secondArea) {
      secondArea = a;
      secondZone = z;
    }
  }

  if (bestZone < 0 || totalMatched < parcelArea * 0.2) {
    return null;
  }

  const purity = bestArea / totalMatched;
  const meanColorConf = confWeightedByZone[bestZone] / bestArea;
  const coverageFactor = Math.min(1, totalMatched / (parcelArea * 0.6));

  let confidence = roundConfidence(
    meanColorConf *
      (0.45 * Math.max(0, 2 * purity - 1) + 0.55 * purity) *
      Math.max(0.55, coverageFactor)
  );

  let notes: string | undefined;
  if (purity < 0.65 && secondZone >= 0) {
    confidence = Math.min(confidence, 0.44);
    const primaryLabel =
      legend.zones[bestZone].code || legend.zones[bestZone].description;
    const secondaryLabel =
      legend.zones[secondZone].code || legend.zones[secondZone].description;
    notes = `Split or boundary-adjacent parcel: ${Math.round(purity * 100)}% ${primaryLabel}, ${Math.round((secondArea / totalMatched) * 100)}% ${secondaryLabel}`;
  }

  return { zoneIndex: bestZone, confidence, notes };
}

function evaluateParcelAgainstRaster(
  parcelPdfMultiPoly: PolyCoords[],
  rasterImage: RgbaImageLike,
  rasterScale: number,
  lut: LegendColorLut,
  legend: LegendResult
): { zoneIndex: number; confidence: number; notes?: string } | null {
  const votesByZone = new Float64Array(legend.zones.length);
  const confSumByZone = new Float64Array(legend.zones.length);
  let nonInkInteriorWeight = 0;
  let matchedSampleCount = 0;

  const sampleAtPixel = (px: number, py: number, edgeDistancePx: number) => {
    const ix = Math.round(px);
    const iy = Math.round(py);
    if (
      ix < 0 ||
      iy < 0 ||
      ix >= rasterImage.width ||
      iy >= rasterImage.height
    ) {
      return;
    }
    const off = (iy * rasterImage.width + ix) * 4;
    if (rasterImage.data[off + 3] < 96) return;

    const classified = lut.classifyPixel(
      rasterImage.data[off],
      rasterImage.data[off + 1],
      rasterImage.data[off + 2]
    );
    if (classified.isDarkInk) return;

    const weight = edgeDistancePx >= 2.0 ? 1.0 : 0.3;
    nonInkInteriorWeight += weight;

    if (classified.zoneIndex >= 0) {
      votesByZone[classified.zoneIndex] += weight;
      confSumByZone[classified.zoneIndex] += weight * classified.confidence;
      matchedSampleCount++;
    }
  };

  for (const pdfPoly of parcelPdfMultiPoly) {
    const pixelPoly: PolyCoords = pdfPoly.map((ring) =>
      ring.map(([x, y]): Pair => [x * rasterScale, y * rasterScale])
    );
    if (pixelPoly.length === 0 || pixelPoly[0].length < 4) continue;

    // 1. Always sample the pole of inaccessibility (deepest interior point)
    try {
      const pole = polylabel(pixelPoly, 0.5);
      if (
        Array.isArray(pole) &&
        Number.isFinite(pole[0]) &&
        Number.isFinite(pole[1])
      ) {
        const poleDist = Math.max(0, pole.distance ?? 2.5);
        sampleAtPixel(pole[0], pole[1], Math.max(2.5, poleDist));
        // Add tight 4-neighbor cross around pole for tiny sub-grid lots
        const step = Math.min(1.0, Math.max(0.35, poleDist * 0.4));
        for (const [dx, dy] of [
          [step, 0],
          [-step, 0],
          [0, step],
          [0, -step]
        ]) {
          const q: Pair = [pole[0] + dx, pole[1] + dy];
          if (pointInPolygonWithHoles(q, pixelPoly)) {
            sampleAtPixel(q[0], q[1], Math.max(1.5, poleDist - step));
          }
        }
      }
    } catch {
      // Continue with interior grid sampling
    }

    // 2. Adaptive interior grid across the polygon's pixel bounding box
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pixelPoly[0]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const stepsX = Math.max(3, Math.min(13, Math.ceil(spanX / 3)));
    const stepsY = Math.max(3, Math.min(13, Math.ceil(spanY / 3)));

    for (let gy = 0; gy < stepsY; gy++) {
      const py = minY + ((gy + 0.5) / stepsY) * spanY;
      for (let gx = 0; gx < stepsX; gx++) {
        const px = minX + ((gx + 0.5) / stepsX) * spanX;
        const pt: Pair = [px, py];
        if (!pointInPolygonWithHoles(pt, pixelPoly)) continue;
        const edgeDist = minDistanceToPolygonRings(pt, pixelPoly);
        sampleAtPixel(px, py, edgeDist);
      }
    }
  }

  let totalMatchedWeight = 0;
  let bestZone = -1;
  let bestWeight = 0;
  let secondZone = -1;
  let secondWeight = 0;

  for (let z = 0; z < votesByZone.length; z++) {
    const w = votesByZone[z];
    totalMatchedWeight += w;
    if (w > bestWeight) {
      secondWeight = bestWeight;
      secondZone = bestZone;
      bestWeight = w;
      bestZone = z;
    } else if (w > secondWeight) {
      secondWeight = w;
      secondZone = z;
    }
  }

  if (
    bestZone < 0 ||
    matchedSampleCount === 0 ||
    nonInkInteriorWeight <= 0 ||
    totalMatchedWeight / nonInkInteriorWeight < 0.18
  ) {
    return null;
  }

  const purity = bestWeight / totalMatchedWeight;
  const meanColorConf = confSumByZone[bestZone] / bestWeight;
  const sampleSupport = Math.min(1, matchedSampleCount / 3);

  let confidence = roundConfidence(
    meanColorConf *
      (0.45 * Math.max(0, 2 * purity - 1) + 0.55 * purity) *
      Math.max(0.55, sampleSupport)
  );

  let notes: string | undefined;
  if (purity < 0.65 && secondZone >= 0) {
    confidence = Math.min(confidence, 0.44);
    const primaryLabel =
      legend.zones[bestZone].code || legend.zones[bestZone].description;
    const secondaryLabel =
      legend.zones[secondZone].code || legend.zones[secondZone].description;
    notes = `Split or boundary-adjacent parcel: ${Math.round(purity * 100)}% ${primaryLabel}, ${Math.round((secondWeight / totalMatchedWeight) * 100)}% ${secondaryLabel}`;
  }

  return { zoneIndex: bestZone, confidence, notes };
}

function buildIndividualParcelFeatures(
  records: ReadonlyArray<ClassifiedParcelRecord>,
  legend: LegendResult,
  sourceName: string
): DigitizerFeature[] {
  return records.map((rec) => {
    const zone = legend.zones[rec.zoneIndex];
    const rawGeometry: Polygon | MultiPolygon =
      rec.mapMultiPoly.length === 1
        ? { type: 'Polygon', coordinates: rec.mapMultiPoly[0] }
        : { type: 'MultiPolygon', coordinates: rec.mapMultiPoly };

    const rewound = rewindGeometry(rawGeometry, false) as
      | Polygon
      | MultiPolygon;

    return {
      id: newFeatureId(),
      geometry: rewound,
      properties: {
        planning_class: zone.description || zone.code,
        raw_zoning_label: zone.code || zone.description,
        confidence: rec.confidence,
        source_type: 'digitized',
        source_name: sourceName,
        human_confirmed: false,
        ...(rec.notes ? { notes: rec.notes } : {})
      }
    };
  });
}

function buildDissolvedZoneFeatures(
  records: ReadonlyArray<ClassifiedParcelRecord>,
  legend: LegendResult,
  sourceName: string
): DigitizerFeature[] {
  const grouped = new Map<number, ClassifiedParcelRecord[]>();
  for (const rec of records) {
    const list = grouped.get(rec.zoneIndex);
    if (list) list.push(rec);
    else grouped.set(rec.zoneIndex, [rec]);
  }

  const features: DigitizerFeature[] = [];

  for (const [zoneIndex, group] of grouped.entries()) {
    const zone = legend.zones[zoneIndex];
    let totalWeight = 0;
    let weightedConf = 0;
    for (const r of group) {
      const w = Math.max(1e-3, r.pdfArea);
      totalWeight += w;
      weightedConf += w * r.confidence;
    }
    const zoneConfidence = roundConfidence(
      totalWeight > 0 ? weightedConf / totalWeight : 0.7
    );

    try {
      const inputs = group.map((r) => r.mapMultiPoly);
      const dissolved: PolyCoords[] =
        inputs.length === 1
          ? inputs[0]
          : polygonClipping.union(inputs[0], ...inputs.slice(1));

      for (const polyCoords of dissolved) {
        if (polyCoords.length === 0 || polyCoords[0].length < 4) continue;
        const rewound = rewindGeometry(
          { type: 'Polygon', coordinates: polyCoords },
          false
        ) as Polygon;
        features.push({
          id: newFeatureId(),
          geometry: rewound,
          properties: {
            planning_class: zone.description || zone.code,
            raw_zoning_label: zone.code || zone.description,
            confidence: zoneConfidence,
            source_type: 'digitized',
            source_name: sourceName,
            human_confirmed: false
          }
        });
      }
    } catch {
      // Fallback to individual parcel features if union encounters degenerate topology
      features.push(
        ...buildIndividualParcelFeatures(group, legend, sourceName)
      );
    }
  }

  return features;
}

function computeMultiPolyPdfBoundsAndArea(multi: PolyCoords[]): {
  bbox: [number, number, number, number];
  area: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let area = 0;

  for (const poly of multi) {
    if (poly.length === 0) continue;
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    area += Math.abs(signedRingArea(poly[0]));
    for (let h = 1; h < poly.length; h++) {
      area -= Math.abs(signedRingArea(poly[h]));
    }
  }

  return {
    bbox: [minX, minY, maxX, maxY],
    area: Math.max(0, area)
  };
}

function computeMultiPolyAreaOnly(multi: PolyCoords[]): number {
  let area = 0;
  for (const poly of multi) {
    if (poly.length === 0) continue;
    area += Math.abs(signedRingArea(poly[0]));
    for (let h = 1; h < poly.length; h++) {
      area -= Math.abs(signedRingArea(poly[h]));
    }
  }
  return Math.max(0, area);
}

function signedRingArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

function bboxesIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function pointInRing(point: Pair, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygonWithHoles(point: Pair, poly: PolyCoords): boolean {
  if (poly.length === 0 || !pointInRing(point, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) {
    if (pointInRing(point, poly[h])) return false;
  }
  return true;
}

function minDistanceToPolygonRings(point: Pair, poly: PolyCoords): number {
  let minDistSq = Infinity;
  for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = ring[i][0];
      const ay = ring[i][1];
      const bx = ring[i + 1][0];
      const by = ring[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const t =
        lenSq === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lenSq)
            );
      const projX = ax + t * dx;
      const projY = ay + t * dy;
      const dSq =
        (point[0] - projX) * (point[0] - projX) +
        (point[1] - projY) * (point[1] - projY);
      if (dSq < minDistSq) minDistSq = dSq;
    }
  }
  return Math.sqrt(minDistSq);
}

function roundConfidence(value: number): number {
  const clamped = Math.max(0.05, Math.min(0.98, value));
  return Math.round(clamped * 100) / 100;
}
