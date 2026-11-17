import Flatbush from 'flatbush';

type Position = [number, number];
type ParcelRing = Position[];
type ParcelPolygon = ParcelRing[];
type Bounds = [number, number, number, number];
interface ParcelEdge {
  start: Position;
  end: Position;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Spatial index of the boundaries from a local GeoJSON parcel collection. */
export interface ParcelBoundaryIndex {
  index: Flatbush;
  edges: ParcelEdge[];
  parcelCount: number;
}

/** Result of checking and optionally snapping one PDF-derived polygon ring. */
export interface ParcelSnapResult {
  coordinates: Position[];
  alignmentRatio: number;
  snappedVertexCount: number;
  applied: boolean;
}

/** Parcel edges near the extracted shapes, and the number of parcels scanned. */
export interface LocalParcelIndexResult {
  parcelIndex: ParcelBoundaryIndex | null;
  scannedParcelCount: number;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_DEGREE = (Math.PI * EARTH_RADIUS_METERS) / 180;
const MIN_ALIGNMENT_RATIO = 0.5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePosition(value: unknown): Position {
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

function parseRing(value: unknown): ParcelRing {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(
      'Parcel polygon rings must contain at least three coordinates.'
    );
  }

  const ring = value.map(parsePosition);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([...first]);
  }

  const uniquePositions = new Set(
    ring.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`)
  );
  if (uniquePositions.size < 3) {
    throw new Error(
      'Parcel polygon rings must contain at least three distinct coordinates.'
    );
  }

  return ring;
}

function parsePolygon(value: unknown): ParcelPolygon {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Parcel polygon geometry is missing coordinate rings.');
  }
  return value.map(parseRing);
}

function parseParcelFeature(feature: unknown): ParcelPolygon[] {
  if (!isRecord(feature) || !isRecord(feature.geometry)) {
    throw new Error(
      'Every parcel feature must have Polygon or MultiPolygon geometry.'
    );
  }

  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') {
    return [parsePolygon(geometry.coordinates)];
  }
  if (
    geometry.type === 'MultiPolygon' &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length > 0
  ) {
    return geometry.coordinates.map(parsePolygon);
  }
  throw new Error(
    'Every parcel feature must have Polygon or MultiPolygon geometry.'
  );
}

function appendParcelEdges(
  polygons: ParcelPolygon[],
  edges: ParcelEdge[],
  include: (edge: ParcelEdge) => boolean
): boolean {
  let included = false;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i++) {
        const start = ring[i];
        const end = ring[i + 1];
        if (start[0] === end[0] && start[1] === end[1]) continue;
        const edge = {
          start,
          end,
          minX: Math.min(start[0], end[0]),
          minY: Math.min(start[1], end[1]),
          maxX: Math.max(start[0], end[0]),
          maxY: Math.max(start[1], end[1])
        };
        if (include(edge)) {
          edges.push(edge);
          included = true;
        }
      }
    }
  }
  return included;
}

function buildParcelIndex(
  edges: ParcelEdge[],
  parcelCount: number
): ParcelBoundaryIndex {
  const index = new Flatbush(edges.length);
  for (const edge of edges) {
    index.add(edge.minX, edge.minY, edge.maxX, edge.maxY);
  }
  index.finish();
  return { index, edges, parcelCount };
}

/**
 * Parses a GeoJSON FeatureCollection containing Polygon and MultiPolygon parcels
 * and builds a spatial index of all exterior and interior parcel boundaries.
 */
export function createParcelBoundaryIndex(input: unknown): ParcelBoundaryIndex {
  if (
    !isRecord(input) ||
    input.type !== 'FeatureCollection' ||
    !Array.isArray(input.features) ||
    input.features.length === 0
  ) {
    throw new Error(
      'Parcel data must be a non-empty GeoJSON FeatureCollection.'
    );
  }

  const edges: ParcelEdge[] = [];
  for (const feature of input.features) {
    appendParcelEdges(parseParcelFeature(feature), edges, () => true);
  }

  if (edges.length === 0) {
    throw new Error(
      'Parcel data does not contain any usable polygon boundaries.'
    );
  }

  return buildParcelIndex(edges, input.features.length);
}

/**
 * Streams a parcel GeoJSON and indexes only edges whose bounds overlap the
 * buffered bounds of extracted WGS-84 polygons. Returns null when no edges
 * match; parcels crossing the search area's boundary are retained.
 */
export async function createLocalParcelBoundaryIndex(
  file: Blob,
  rings: Position[][],
  toleranceMeters: number
): Promise<LocalParcelIndexResult> {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0) {
    throw new Error(
      'Parcel snap tolerance must be a positive number of meters.'
    );
  }
  if (rings.length === 0) {
    throw new Error(
      'At least one extracted polygon is required to search parcels.'
    );
  }

  const bounds: Bounds[] = rings.map((ring) => {
    if (ring.length < 4) {
      throw new Error('Extracted polygon must have at least four coordinates.');
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const coordinate of ring) {
      const [lon, lat] = parsePosition(coordinate);
      minX = Math.min(minX, lon);
      minY = Math.min(minY, lat);
      maxX = Math.max(maxX, lon);
      maxY = Math.max(maxY, lat);
    }
    const latitudeBuffer = toleranceMeters / METERS_PER_DEGREE;
    const maxAbsLatitude = Math.min(
      90,
      Math.max(Math.abs(minY), Math.abs(maxY)) + latitudeBuffer
    );
    const longitudeBuffer =
      toleranceMeters / localMetersPerDegree(maxAbsLatitude).longitude;
    return [
      minX - longitudeBuffer,
      minY - latitudeBuffer,
      maxX + longitudeBuffer,
      maxY + latitudeBuffer
    ];
  });
  const shapeIndex = new Flatbush(bounds.length);
  for (const box of bounds) shapeIndex.add(...box);
  shapeIndex.finish();

  const { JSONParser } = await import('@streamparser/json');
  const parser = new JSONParser({
    paths: ['$.type', '$.features.*'],
    keepStack: false
  });
  const edges: ParcelEdge[] = [];
  let collectionType: unknown;
  let scannedParcelCount = 0;
  let matchedParcelCount = 0;
  parser.onValue = ({ value, key, parent, stack }) => {
    if (key === 'type' && stack.length === 1) {
      collectionType = value;
      return;
    }
    if (!Array.isArray(parent) || typeof key !== 'number') {
      throw new Error('Parcel features must be an array of GeoJSON features.');
    }
    scannedParcelCount++;
    const polygons = parseParcelFeature(value);
    if (
      appendParcelEdges(
        polygons,
        edges,
        (edge) =>
          shapeIndex.search(edge.minX, edge.minY, edge.maxX, edge.maxY).length >
          0
      )
    ) {
      matchedParcelCount++;
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

  return {
    parcelIndex: edges.length
      ? buildParcelIndex(edges, matchedParcelCount)
      : null,
    scannedParcelCount
  };
}

function localMetersPerDegree(latitude: number): {
  longitude: number;
  latitude: number;
} {
  return {
    longitude:
      METERS_PER_DEGREE *
      Math.max(Math.abs(Math.cos((latitude * Math.PI) / 180)), 1e-6),
    latitude: METERS_PER_DEGREE
  };
}

function searchNearbyEdges(
  point: Position,
  parcelIndex: ParcelBoundaryIndex,
  radiusMeters: number
): number[] {
  const scale = localMetersPerDegree(point[1]);
  const latitudeRadius = radiusMeters / scale.latitude;
  const longitudeRadius = radiusMeters / scale.longitude;
  return parcelIndex.index.search(
    point[0] - longitudeRadius,
    point[1] - latitudeRadius,
    point[0] + longitudeRadius,
    point[1] + latitudeRadius
  );
}

function nearestPointOnEdge(
  point: Position,
  edge: ParcelEdge
): { point: Position; distanceMeters: number } {
  const scale = localMetersPerDegree(point[1]);
  const startX = (edge.start[0] - point[0]) * scale.longitude;
  const startY = (edge.start[1] - point[1]) * scale.latitude;
  const endX = (edge.end[0] - point[0]) * scale.longitude;
  const endY = (edge.end[1] - point[1]) * scale.latitude;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const fraction =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, -(startX * deltaX + startY * deltaY) / lengthSquared)
        );
  const x = startX + fraction * deltaX;
  const y = startY + fraction * deltaY;

  return {
    point: [point[0] + x / scale.longitude, point[1] + y / scale.latitude],
    distanceMeters: Math.hypot(x, y)
  };
}

function pointInRing(point: Position, ring: Position[]): boolean {
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

function separatesPdfZone(
  edge: ParcelEdge,
  nearestPoint: Position,
  polygonRing: Position[],
  toleranceMeters: number
): boolean {
  const scale = localMetersPerDegree(nearestPoint[1]);
  const deltaX = (edge.end[0] - edge.start[0]) * scale.longitude;
  const deltaY = (edge.end[1] - edge.start[1]) * scale.latitude;
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) return false;

  const offset = toleranceMeters + 0.5;
  const normalX = (-deltaY / length) * offset;
  const normalY = (deltaX / length) * offset;
  const firstSide: Position = [
    nearestPoint[0] + normalX / scale.longitude,
    nearestPoint[1] + normalY / scale.latitude
  ];
  const secondSide: Position = [
    nearestPoint[0] - normalX / scale.longitude,
    nearestPoint[1] - normalY / scale.latitude
  ];

  return (
    pointInRing(firstSide, polygonRing) !== pointInRing(secondSide, polygonRing)
  );
}

function nearestZoneBoundaryEdge(
  point: Position,
  polygonRing: Position[],
  parcelIndex: ParcelBoundaryIndex,
  toleranceMeters: number
): { point: Position; distanceMeters: number } | null {
  let nearest: { point: Position; distanceMeters: number } | null = null;
  for (const edgeId of searchNearbyEdges(point, parcelIndex, toleranceMeters)) {
    const candidate = nearestPointOnEdge(point, parcelIndex.edges[edgeId]);
    if (
      candidate.distanceMeters <= toleranceMeters &&
      candidate.distanceMeters < (nearest?.distanceMeters ?? Infinity) &&
      separatesPdfZone(
        parcelIndex.edges[edgeId],
        candidate.point,
        polygonRing,
        toleranceMeters
      )
    ) {
      nearest = candidate;
    }
  }
  return nearest;
}

function boundaryAlignmentRatio(
  ring: Position[],
  parcelIndex: ParcelBoundaryIndex,
  toleranceMeters: number
): number {
  let sampleCount = 0;
  let alignedSampleCount = 0;
  const sampleSpacing = Math.max(1, Math.min(toleranceMeters, 5));

  for (let i = 0; i < ring.length - 1; i++) {
    const start = ring[i];
    const end = ring[i + 1];
    const scale = localMetersPerDegree((start[1] + end[1]) / 2);
    const length = Math.hypot(
      (end[0] - start[0]) * scale.longitude,
      (end[1] - start[1]) * scale.latitude
    );
    const samplesOnEdge = Math.max(1, Math.ceil(length / sampleSpacing));

    for (let sample = 0; sample < samplesOnEdge; sample++) {
      const fraction = (sample + 0.5) / samplesOnEdge;
      const point: Position = [
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction
      ];
      sampleCount++;
      if (nearestZoneBoundaryEdge(point, ring, parcelIndex, toleranceMeters)) {
        alignedSampleCount++;
      }
    }
  }

  return sampleCount === 0 ? 0 : alignedSampleCount / sampleCount;
}

/**
 * Snaps a PDF-derived WGS-84 polygon ring to nearby parcel edges only when at
 * least half of its boundary aligns. Parcel edges shared inside the PDF zone
 * are ignored, so zones spanning multiple parcels remain a single polygon.
 */
export function snapPolygonToParcelBoundaries(
  ring: Position[],
  parcelIndex: ParcelBoundaryIndex,
  toleranceMeters: number
): ParcelSnapResult {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0) {
    throw new Error(
      'Parcel snap tolerance must be a positive number of meters.'
    );
  }
  if (ring.length < 4) {
    throw new Error(
      'A closed polygon ring with at least four coordinates is required.'
    );
  }

  const closedRing = ring.map((position) => [...position] as Position);
  const first = closedRing[0];
  const last = closedRing[closedRing.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    closedRing.push([...first]);
  }

  const alignmentRatio = boundaryAlignmentRatio(
    closedRing,
    parcelIndex,
    toleranceMeters
  );
  if (alignmentRatio < MIN_ALIGNMENT_RATIO) {
    return {
      coordinates: closedRing,
      alignmentRatio,
      snappedVertexCount: 0,
      applied: false
    };
  }

  let snappedVertexCount = 0;
  const snappedRing = closedRing.map((position, index) => {
    if (index === closedRing.length - 1) return [...position] as Position;
    const nearest = nearestZoneBoundaryEdge(
      position,
      closedRing,
      parcelIndex,
      toleranceMeters
    );
    if (!nearest || nearest.distanceMeters < 0.01) {
      return [...position] as Position;
    }
    snappedVertexCount++;
    return nearest.point;
  });
  snappedRing[snappedRing.length - 1] = [...snappedRing[0]];

  return {
    coordinates: snappedRing,
    alignmentRatio,
    snappedVertexCount,
    applied: snappedVertexCount > 0
  };
}
