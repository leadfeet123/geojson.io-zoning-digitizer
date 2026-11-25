import { env } from 'app/lib/env_client';
import {
  haversineDistanceMeters,
  type LonLatCoordinate
} from 'app/lib/transform_engine';

const GEOCODER_TIMEOUT_MS = 8_000;
const OVERPASS_TIMEOUT_MS = 9_000;
const INTERSECTION_CLUSTER_RADIUS_METERS = 55;
const NEAR_JUNCTION_TOLERANCE_METERS = 18;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const US_STATE_ABBR_TO_NAME: Record<string, string> = {
  al: 'alabama',
  ak: 'alaska',
  az: 'arizona',
  ar: 'arkansas',
  ca: 'california',
  co: 'colorado',
  ct: 'connecticut',
  de: 'delaware',
  dc: 'district of columbia',
  fl: 'florida',
  ga: 'georgia',
  hi: 'hawaii',
  id: 'idaho',
  il: 'illinois',
  in: 'indiana',
  ia: 'iowa',
  ks: 'kansas',
  ky: 'kentucky',
  la: 'louisiana',
  me: 'maine',
  md: 'maryland',
  ma: 'massachusetts',
  mi: 'michigan',
  mn: 'minnesota',
  ms: 'mississippi',
  mo: 'missouri',
  mt: 'montana',
  ne: 'nebraska',
  nv: 'nevada',
  nh: 'new hampshire',
  nj: 'new jersey',
  nm: 'new mexico',
  ny: 'new york',
  nc: 'north carolina',
  nd: 'north dakota',
  oh: 'ohio',
  ok: 'oklahoma',
  or: 'oregon',
  pa: 'pennsylvania',
  ri: 'rhode island',
  sc: 'south carolina',
  sd: 'south dakota',
  tn: 'tennessee',
  tx: 'texas',
  ut: 'utah',
  vt: 'vermont',
  va: 'virginia',
  wa: 'washington',
  wv: 'west virginia',
  wi: 'wisconsin',
  wy: 'wyoming'
};

const ORDINAL_WORD_TO_NUM: Record<string, string> = {
  first: '1st',
  second: '2nd',
  third: '3rd',
  fourth: '4th',
  fifth: '5th',
  sixth: '6th',
  seventh: '7th',
  eighth: '8th',
  ninth: '9th',
  tenth: '10th',
  eleventh: '11th',
  twelfth: '12th',
  thirteenth: '13th',
  fourteenth: '14th',
  fifteenth: '15th',
  sixteenth: '16th',
  seventeenth: '17th',
  eighteenth: '18th',
  nineteenth: '19th',
  twentieth: '20th'
};

const DIRECTION_MAP: Record<string, string> = {
  n: 'n',
  north: 'n',
  s: 's',
  south: 's',
  e: 'e',
  east: 'e',
  w: 'w',
  west: 'w',
  ne: 'ne',
  northeast: 'ne',
  nw: 'nw',
  northwest: 'nw',
  se: 'se',
  southeast: 'se',
  sw: 'sw',
  southwest: 'sw'
};

const ROAD_TYPE_MAP: Record<string, string> = {
  st: 'st',
  street: 'st',
  str: 'st',
  ave: 'ave',
  av: 'ave',
  avenue: 'ave',
  rd: 'rd',
  road: 'rd',
  blvd: 'blvd',
  boulevard: 'blvd',
  dr: 'dr',
  drive: 'dr',
  ln: 'ln',
  lane: 'ln',
  ct: 'ct',
  court: 'ct',
  pl: 'pl',
  place: 'pl',
  cir: 'cir',
  circle: 'cir',
  pkwy: 'pkwy',
  parkway: 'pkwy',
  hwy: 'hwy',
  highway: 'hwy',
  way: 'way',
  ter: 'ter',
  terrace: 'ter',
  trl: 'trl',
  trail: 'trl',
  pike: 'pike',
  tpke: 'tpke',
  turnpike: 'tpke',
  expy: 'expy',
  expressway: 'expy',
  fwy: 'fwy',
  freeway: 'fwy',
  aly: 'aly',
  alley: 'aly',
  loop: 'loop',
  plz: 'plz',
  plaza: 'plz',
  sq: 'sq',
  square: 'sq'
};

/** Geographic bounding box in decimal degrees. */
export interface GeoBoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Hints extracted from a PDF map title block, filename, or active viewport. */
export interface GeographicRegionHint {
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
  rawRegionText?: string;
  sourceName?: string;
  viewportHint?: {
    center: LonLatCoordinate;
    bounds: GeoBoundingBox;
  };
}

/** Verified geographic search area for a zoning map's jurisdiction. */
export interface ResolvedJurisdiction {
  displayName: string;
  center: LonLatCoordinate;
  bbox: GeoBoundingBox;
  source: 'nominatim' | 'mapbox' | 'viewport';
}

/** Pair of intersecting streets/highways to locate in real-world coordinates. */
export interface StreetIntersectionQuery {
  id: string;
  street1: string;
  street2: string;
}

/** Grounded WGS-84 coordinate candidate for a street intersection. */
export interface GroundedIntersectionCandidate {
  lon: number;
  lat: number;
  source: 'osm_intersection' | 'mapbox_geocoder';
  confidence: number;
  matchedNames: string;
}

/** Minimal OpenStreetMap road/rail way representation used for intersection math. */
export interface OsmRoadWay {
  id: number;
  nodes?: number[];
  geometry: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

/** Interface for grounding map regions and street intersections to WGS-84 coordinates. */
export interface GeorefGeocoder {
  resolveJurisdiction(
    hint: GeographicRegionHint
  ): Promise<ResolvedJurisdiction | null>;
  resolveIntersections(
    queries: ReadonlyArray<StreetIntersectionQuery>,
    jurisdiction: ResolvedJurisdiction
  ): Promise<Map<string, GroundedIntersectionCandidate[]>>;
}

interface RouteIdentifier {
  network: 'i' | 'us' | 'sr' | 'cr' | 'any';
  number: string;
}

/** Parsed canonical components of a street or highway name. */
export interface ParsedStreetSignature {
  core: string;
  coreTokens: string[];
  direction?: string;
  roadType?: string;
  routes: RouteIdentifier[];
}

/**
 * Parses a raw street or highway label into canonical tokens and route numbers.
 */
export function parseStreetSignature(raw: string): ParsedStreetSignature[] {
  const parts = raw
    .split(/[()/]|(?:\s+aka\s+)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const signatures: ParsedStreetSignature[] = [];
  for (const part of parts) {
    const sig = parseSingleStreetPart(part);
    if (sig.core.length > 0 || sig.routes.length > 0) {
      signatures.push(sig);
    }
  }

  return signatures.length > 0 ? signatures : [parseSingleStreetPart(raw)];
}

function parseSingleStreetPart(raw: string): ParsedStreetSignature {
  const routes = extractRouteIdentifiers(raw);
  const cleaned = raw
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[.,#]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return { core: '', coreTokens: [], routes };
  }

  const rawTokens = cleaned.split(' ').map((tok) => {
    if (ORDINAL_WORD_TO_NUM[tok]) return ORDINAL_WORD_TO_NUM[tok];
    const zeroStripped = tok.replace(/^0+(\d+(?:st|nd|rd|th)?)$/, '$1');
    return zeroStripped;
  });

  // Normalize "saint" -> "st" when followed by a name token so "St Charles Rd" === "Saint Charles Rd"
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    if (tok === 'saint' && i + 1 < rawTokens.length) {
      tokens.push('st');
    } else {
      tokens.push(tok);
    }
  }

  let direction: string | undefined;
  let roadType: string | undefined;

  if (tokens.length > 1 && DIRECTION_MAP[tokens[0]]) {
    direction = DIRECTION_MAP[tokens.shift()!];
  }
  if (tokens.length > 1 && DIRECTION_MAP[tokens[tokens.length - 1]]) {
    direction = direction ?? DIRECTION_MAP[tokens.pop()!];
  }

  // Strip trailing road type suffix only when at least one core token remains before it
  if (tokens.length > 1 && ROAD_TYPE_MAP[tokens[tokens.length - 1]]) {
    roadType = ROAD_TYPE_MAP[tokens.pop()!];
  }
  // Occasionally a second trailing direction/suffix remained (e.g. "Main St N" -> "Main St")
  if (tokens.length > 1 && ROAD_TYPE_MAP[tokens[tokens.length - 1]]) {
    roadType = roadType ?? ROAD_TYPE_MAP[tokens.pop()!];
  }

  const coreTokens = tokens.filter((t) => t.length > 0);
  return {
    core: coreTokens.join(' '),
    coreTokens,
    direction,
    roadType,
    routes
  };
}

function extractRouteIdentifiers(raw: string): RouteIdentifier[] {
  const results: RouteIdentifier[] = [];
  const seen = new Set<string>();
  const add = (network: RouteIdentifier['network'], num: string) => {
    const normalized = num.replace(/^0+/, '') || '0';
    const key = `${network}:${normalized}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ network, number: normalized });
    }
  };

  const text = raw.toLowerCase();

  for (const m of text.matchAll(/\b(?:interstate|i)[\s-]*(\d+[a-z]?)\b/g)) {
    add('i', m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:u\.?s\.?\s*(?:hwy|highway|rte|route)?|us)[\s-]*(\d+[a-z]?)\b/g
  )) {
    add('us', m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:county\s*(?:rd|road|hwy|highway|rte|route)|co\.?\s*rd\.?|cr)[\s-]*(\d+[a-z]?)\b/g
  )) {
    add('cr', m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:state\s*(?:rd|road|hwy|highway|rte|route)|sr|sh|st\s*hwy|hwy|highway|route|rte)[\s-]*(\d+[a-z]?)\b/g
  )) {
    add('sr', m[1]);
  }

  // State abbreviation + number (e.g. "IL-130", "WI 50", "CA-1")
  for (const m of text.matchAll(/\b([a-z]{2})[\s-]+(\d+[a-z]?)\b/g)) {
    if (US_STATE_ABBR_TO_NAME[m[1]]) {
      add('sr', m[2]);
    }
  }

  return results;
}

function extractWaySignatures(way: OsmRoadWay): ParsedStreetSignature[] {
  const tags = way.tags ?? {};
  const candidates: string[] = [];

  for (const key of [
    'name',
    'alt_name',
    'official_name',
    'short_name',
    'loc_name',
    'tiger:name_base'
  ]) {
    if (tags[key]) {
      for (const piece of tags[key].split(';')) {
        if (piece.trim()) candidates.push(piece.trim());
      }
    }
  }

  const sigs = candidates.flatMap((c) => parseStreetSignature(c));

  if (tags.ref) {
    const refRoutes: RouteIdentifier[] = [];
    for (const piece of tags.ref.split(';')) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const extracted = extractRouteIdentifiers(trimmed);
      if (extracted.length > 0) {
        refRoutes.push(...extracted);
      } else {
        const numMatch = trimmed.match(/\b(\d+[a-z]?)\b/i);
        if (numMatch) {
          refRoutes.push({
            network: 'any',
            number: numMatch[1].toLowerCase().replace(/^0+/, '') || '0'
          });
        }
      }
    }
    if (refRoutes.length > 0) {
      sigs.push({ core: '', coreTokens: [], routes: refRoutes });
    }
  }

  return sigs;
}

function matchWayScore(
  querySigs: ReadonlyArray<ParsedStreetSignature>,
  waySigs: ReadonlyArray<ParsedStreetSignature>
): number {
  let best = 0;

  for (const q of querySigs) {
    for (const w of waySigs) {
      // 1. Route number match
      for (const qr of q.routes) {
        for (const wr of w.routes) {
          if (qr.number === wr.number) {
            const networkCompatible =
              qr.network === 'any' ||
              wr.network === 'any' ||
              qr.network === wr.network ||
              (qr.network === 'sr' && wr.network === 'us');
            if (networkCompatible) {
              best = Math.max(best, 0.94);
            }
          }
        }
      }

      if (!q.core || !w.core) continue;

      // 2. Exact canonical core match
      if (q.core === w.core) {
        let score = 0.96;
        if (q.direction && w.direction && q.direction === w.direction) {
          score += 0.02;
        }
        if (q.roadType && w.roadType && q.roadType === w.roadType) {
          score += 0.02;
        }
        best = Math.max(best, Math.min(1, score));
        continue;
      }

      // 3. Collapsed whitespace match (e.g. "Mc Kinley" vs "McKinley")
      if (
        q.core.length >= 4 &&
        q.core.replace(/\s+/g, '') === w.core.replace(/\s+/g, '')
      ) {
        best = Math.max(best, 0.93);
        continue;
      }

      // 4. Multi-token subset match (e.g. "Martin Luther King" vs "Dr Martin Luther King Jr")
      if (q.coreTokens.length >= 2 && w.coreTokens.length >= 2) {
        const wSet = new Set(w.coreTokens);
        const shared = q.coreTokens.filter(
          (tok) => tok.length >= 3 && wSet.has(tok)
        );
        if (
          shared.length >= 2 &&
          shared.length >=
            Math.min(q.coreTokens.length, w.coreTokens.length) * 0.75
        ) {
          best = Math.max(best, 0.86);
        }
      }
    }
  }

  return best;
}

/**
 * Computes exact road-centerline intersection candidates for street pairs from OSM highway ways.
 */
export function findIntersectionsFromOsmWays(
  ways: ReadonlyArray<OsmRoadWay>,
  queries: ReadonlyArray<StreetIntersectionQuery>
): Map<string, GroundedIntersectionCandidate[]> {
  const result = new Map<string, GroundedIntersectionCandidate[]>();
  if (ways.length === 0 || queries.length === 0) {
    return result;
  }

  const validWays = ways.filter(
    (w) => Array.isArray(w.geometry) && w.geometry.length >= 2
  );
  const waySignatures = validWays.map((w) => extractWaySignatures(w));

  for (const query of queries) {
    const q1 = parseStreetSignature(query.street1);
    const q2 = parseStreetSignature(query.street2);
    if (
      q1.every((s) => !s.core && s.routes.length === 0) ||
      q2.every((s) => !s.core && s.routes.length === 0)
    ) {
      continue;
    }

    const ways1: Array<{ way: OsmRoadWay; score: number }> = [];
    const ways2: Array<{ way: OsmRoadWay; score: number }> = [];

    for (let i = 0; i < validWays.length; i++) {
      const s1 = matchWayScore(q1, waySignatures[i]);
      const s2 = matchWayScore(q2, waySignatures[i]);
      if (s1 >= 0.85) ways1.push({ way: validWays[i], score: s1 });
      if (s2 >= 0.85) ways2.push({ way: validWays[i], score: s2 });
    }

    if (ways1.length === 0 || ways2.length === 0) {
      continue;
    }

    const rawHits: Array<{
      lon: number;
      lat: number;
      confidence: number;
      label: string;
    }> = [];

    for (const w1 of ways1) {
      for (const w2 of ways2) {
        if (w1.way.id === w2.way.id) continue;
        // Skip if both ways actually have the identical name (same street meeting itself)
        const n1 = w1.way.tags?.name?.trim().toLowerCase();
        const n2 = w2.way.tags?.name?.trim().toLowerCase();
        if (
          n1 &&
          n2 &&
          n1 === n2 &&
          query.street1.toLowerCase() !== query.street2.toLowerCase()
        ) {
          continue;
        }

        const label = `${w1.way.tags?.name || w1.way.tags?.ref || query.street1} & ${w2.way.tags?.name || w2.way.tags?.ref || query.street2}`;
        const pairScore = Math.min(w1.score, w2.score);

        // Quick bbox overlap check before segment checks
        if (!wayBboxesOverlap(w1.way.geometry, w2.way.geometry, 0.0004)) {
          continue;
        }

        let foundExact = false;

        // 1. Shared topological node IDs
        if (
          w1.way.nodes &&
          w2.way.nodes &&
          w1.way.nodes.length === w1.way.geometry.length &&
          w2.way.nodes.length === w2.way.geometry.length
        ) {
          const nodeIndexMap = new Map<number, number>();
          w1.way.nodes.forEach((nid, idx) => nodeIndexMap.set(nid, idx));
          for (const nid of w2.way.nodes) {
            const idx1 = nodeIndexMap.get(nid);
            if (idx1 !== undefined) {
              const pt = w1.way.geometry[idx1];
              rawHits.push({
                lon: pt.lon,
                lat: pt.lat,
                confidence: 0.94 * pairScore,
                label
              });
              foundExact = true;
            }
          }
        }

        // 2. Geometric 2D segment crossings (handles bridges/overpasses or missing node IDs)
        if (!foundExact) {
          const crossings = computePolylineIntersections(
            w1.way.geometry,
            w2.way.geometry
          );
          for (const pt of crossings) {
            rawHits.push({
              lon: pt.lon,
              lat: pt.lat,
              confidence: 0.92 * pairScore,
              label
            });
            foundExact = true;
          }
        }

        // 3. Near-endpoint T-junctions within 18m (handles dual-carriageway gaps)
        if (!foundExact) {
          const nearPt = findNearJunctionPoint(
            w1.way.geometry,
            w2.way.geometry,
            NEAR_JUNCTION_TOLERANCE_METERS
          );
          if (nearPt) {
            rawHits.push({
              lon: nearPt.lon,
              lat: nearPt.lat,
              confidence: 0.86 * pairScore,
              label
            });
          }
        }
      }
    }

    if (rawHits.length > 0) {
      const clustered = clusterIntersectionHits(
        rawHits,
        INTERSECTION_CLUSTER_RADIUS_METERS
      );
      result.set(query.id, clustered);
    }
  }

  return result;
}

function wayBboxesOverlap(
  g1: ReadonlyArray<{ lat: number; lon: number }>,
  g2: ReadonlyArray<{ lat: number; lon: number }>,
  padDeg: number
): boolean {
  let minLon1 = Infinity;
  let maxLon1 = -Infinity;
  let minLat1 = Infinity;
  let maxLat1 = -Infinity;
  for (const p of g1) {
    if (p.lon < minLon1) minLon1 = p.lon;
    if (p.lon > maxLon1) maxLon1 = p.lon;
    if (p.lat < minLat1) minLat1 = p.lat;
    if (p.lat > maxLat1) maxLat1 = p.lat;
  }

  let minLon2 = Infinity;
  let maxLon2 = -Infinity;
  let minLat2 = Infinity;
  let maxLat2 = -Infinity;
  for (const p of g2) {
    if (p.lon < minLon2) minLon2 = p.lon;
    if (p.lon > maxLon2) maxLon2 = p.lon;
    if (p.lat < minLat2) minLat2 = p.lat;
    if (p.lat > maxLat2) maxLat2 = p.lat;
  }

  return !(
    maxLon1 + padDeg < minLon2 ||
    maxLon2 + padDeg < minLon1 ||
    maxLat1 + padDeg < minLat2 ||
    maxLat2 + padDeg < minLat1
  );
}

function computePolylineIntersections(
  poly1: ReadonlyArray<{ lat: number; lon: number }>,
  poly2: ReadonlyArray<{ lat: number; lon: number }>
): LonLatCoordinate[] {
  const hits: LonLatCoordinate[] = [];
  for (let i = 0; i < poly1.length - 1; i++) {
    const a1 = poly1[i];
    const a2 = poly1[i + 1];
    for (let j = 0; j < poly2.length - 1; j++) {
      const b1 = poly2[j];
      const b2 = poly2[j + 1];
      const pt = segmentIntersection(a1, a2, b1, b2);
      if (pt) {
        hits.push(pt);
      }
    }
  }
  return hits;
}

function segmentIntersection(
  a1: { lat: number; lon: number },
  a2: { lat: number; lon: number },
  b1: { lat: number; lon: number },
  b2: { lat: number; lon: number }
): LonLatCoordinate | null {
  const dax = a2.lon - a1.lon;
  const day = a2.lat - a1.lat;
  const dbx = b2.lon - b1.lon;
  const dby = b2.lat - b1.lat;

  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-14) {
    return null;
  }

  const dx = b1.lon - a1.lon;
  const dy = b1.lat - a1.lat;
  const t = (dx * dby - dy * dbx) / denom;
  const u = (dx * day - dy * dax) / denom;

  const eps = 1e-5;
  if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
    return {
      lon: a1.lon + Math.max(0, Math.min(1, t)) * dax,
      lat: a1.lat + Math.max(0, Math.min(1, t)) * day
    };
  }

  return null;
}

function findNearJunctionPoint(
  poly1: ReadonlyArray<{ lat: number; lon: number }>,
  poly2: ReadonlyArray<{ lat: number; lon: number }>,
  toleranceMeters: number
): LonLatCoordinate | null {
  let bestDist = toleranceMeters;
  let bestPoint: LonLatCoordinate | null = null;

  const endpoints1 = [poly1[0], poly1[poly1.length - 1]];
  for (const ep of endpoints1) {
    for (let j = 0; j < poly2.length - 1; j++) {
      const proj = projectPointOntoSegment(ep, poly2[j], poly2[j + 1]);
      const d = haversineDistanceMeters(ep, proj);
      if (d < bestDist) {
        bestDist = d;
        bestPoint = {
          lon: (ep.lon + proj.lon) / 2,
          lat: (ep.lat + proj.lat) / 2
        };
      }
    }
  }

  const endpoints2 = [poly2[0], poly2[poly2.length - 1]];
  for (const ep of endpoints2) {
    for (let i = 0; i < poly1.length - 1; i++) {
      const proj = projectPointOntoSegment(ep, poly1[i], poly1[i + 1]);
      const d = haversineDistanceMeters(ep, proj);
      if (d < bestDist) {
        bestDist = d;
        bestPoint = {
          lon: (ep.lon + proj.lon) / 2,
          lat: (ep.lat + proj.lat) / 2
        };
      }
    }
  }

  return bestPoint;
}

function projectPointOntoSegment(
  p: { lat: number; lon: number },
  s1: { lat: number; lon: number },
  s2: { lat: number; lon: number }
): LonLatCoordinate {
  const cosLat = Math.cos((s1.lat * Math.PI) / 180);
  const dx = (s2.lon - s1.lon) * cosLat;
  const dy = s2.lat - s1.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-16) {
    return { lon: s1.lon, lat: s1.lat };
  }
  const px = (p.lon - s1.lon) * cosLat;
  const py = p.lat - s1.lat;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
  return {
    lon: s1.lon + t * (s2.lon - s1.lon),
    lat: s1.lat + t * (s2.lat - s1.lat)
  };
}

function clusterIntersectionHits(
  hits: ReadonlyArray<{
    lon: number;
    lat: number;
    confidence: number;
    label: string;
  }>,
  radiusMeters: number
): GroundedIntersectionCandidate[] {
  const clusters: Array<{
    sumLon: number;
    sumLat: number;
    count: number;
    maxConfidence: number;
    label: string;
  }> = [];

  for (const hit of hits) {
    let merged = false;
    for (const cluster of clusters) {
      const center = {
        lon: cluster.sumLon / cluster.count,
        lat: cluster.sumLat / cluster.count
      };
      if (haversineDistanceMeters(center, hit) <= radiusMeters) {
        cluster.sumLon += hit.lon;
        cluster.sumLat += hit.lat;
        cluster.count += 1;
        if (hit.confidence > cluster.maxConfidence) {
          cluster.maxConfidence = hit.confidence;
          cluster.label = hit.label;
        }
        merged = true;
        break;
      }
    }

    if (!merged) {
      clusters.push({
        sumLon: hit.lon,
        sumLat: hit.lat,
        count: 1,
        maxConfidence: hit.confidence,
        label: hit.label
      });
    }
  }

  return clusters
    .map((c) => ({
      lon: c.sumLon / c.count,
      lat: c.sumLat / c.count,
      source: 'osm_intersection' as const,
      confidence: c.maxConfidence,
      matchedNames: c.label
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Builds ordered jurisdiction search queries from structured hints and PDF filenames.
 */
export function buildJurisdictionSearchQueries(
  hint: GeographicRegionHint
): string[] {
  const cleanPart = (val?: string) =>
    (val ?? '')
      .replace(
        /\b(official|zoning|district|districts|comprehensive|land\s+use|future|general|plan|map|maps|ordinance|amended|revised|draft|adopted|page|sheet)\b/gi,
        ' '
      )
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(/[_\-()/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const muniRaw = cleanPart(hint.municipality);
  const muniShort = muniRaw
    .replace(
      /^(?:city|village|town|township|charter\s+township|borough|parish)\s+of\s+/i,
      ''
    )
    .trim();
  const county = cleanPart(hint.county);
  const state = (hint.state ?? '').trim();
  const country = (hint.country ?? '').trim();

  const queries: string[] = [];
  const pushUnique = (parts: Array<string | undefined>) => {
    const joined = parts
      .map((p) => (p ?? '').trim())
      .filter((p) => p.length > 0)
      .join(', ');
    if (joined.length >= 3 && !queries.includes(joined)) {
      queries.push(joined);
    }
  };

  if (muniRaw) {
    pushUnique([muniRaw, county, state, country]);
    if (muniShort && muniShort !== muniRaw) {
      pushUnique([muniShort, county, state, country]);
    }
    pushUnique([muniShort || muniRaw, state, country]);
    if (!state && !county) {
      pushUnique([muniShort || muniRaw, country]);
    }
  }

  if (county) {
    pushUnique([county, state, country]);
  }

  if (hint.rawRegionText) {
    const cleanedRegion = cleanPart(hint.rawRegionText);
    pushUnique([cleanedRegion]);
  }

  if (queries.length === 0 && hint.sourceName) {
    const fromFile = cleanPart(hint.sourceName.replace(/\.pdf$/i, ''));
    if (fromFile.length >= 3) {
      pushUnique([fromFile]);
    }
  }

  return queries.slice(0, 4);
}

function normalizeStateToken(state?: string): string[] {
  if (!state) return [];
  const lower = state.trim().toLowerCase().replace(/\./g, '');
  if (!lower) return [];
  if (US_STATE_ABBR_TO_NAME[lower]) {
    return [lower, US_STATE_ABBR_TO_NAME[lower]];
  }
  for (const [abbr, full] of Object.entries(US_STATE_ABBR_TO_NAME)) {
    if (full === lower) {
      return [lower, abbr];
    }
  }
  return [lower];
}

function expandJurisdictionBbox(raw: GeoBoundingBox): GeoBoundingBox {
  const lonSpan = Math.max(0.01, raw.east - raw.west);
  const latSpan = Math.max(0.01, raw.north - raw.south);
  // Pad by 25% (at least ~3.8 km) to capture fringe/extraterritorial intersections, capped to ~95 km span
  const lonPad = Math.max(0.035, lonSpan * 0.25);
  const latPad = Math.max(0.032, latSpan * 0.25);

  const centerLon = (raw.west + raw.east) / 2;
  const centerLat = (raw.south + raw.north) / 2;
  const halfLon = Math.min(0.45, lonSpan / 2 + lonPad);
  const halfLat = Math.min(0.42, latSpan / 2 + latPad);

  return {
    west: centerLon - halfLon,
    east: centerLon + halfLon,
    south: centerLat - halfLat,
    north: centerLat + halfLat
  };
}

function escapeOverpassRegex(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOverpassStreetRegex(
  queries: ReadonlyArray<StreetIntersectionQuery>
): string | null {
  const tokens = new Set<string>();
  for (const q of queries) {
    for (const raw of [q.street1, q.street2]) {
      for (const sig of parseStreetSignature(raw)) {
        for (const r of sig.routes) {
          if (r.number.length > 0) {
            tokens.add(`\\b${escapeOverpassRegex(r.number)}\\b`);
          }
        }
        // Pick longest distinctive core token (>=3 chars, or numeric ordinal like 1st/2nd)
        const bestTok = [...sig.coreTokens]
          .filter((t) => t.length >= 2)
          .sort((a, b) => b.length - a.length)[0];
        if (bestTok) {
          tokens.add(escapeOverpassRegex(bestTok));
          // If ordinal like "1st", also include word form "first"
          for (const [word, ord] of Object.entries(ORDINAL_WORD_TO_NUM)) {
            if (ord === bestTok) {
              tokens.add(word);
            }
          }
        }
      }
    }
  }

  if (tokens.size === 0) return null;
  return Array.from(tokens).slice(0, 28).join('|');
}

interface NominatimItem {
  lat?: string;
  lon?: string;
  display_name?: string;
  boundingbox?: [string, string, string, string];
  type?: string;
  class?: string;
  importance?: number;
  address?: Record<string, string>;
}

interface MapboxV6Feature {
  geometry?: { coordinates?: [number, number] };
  bbox?: [number, number, number, number];
  properties?: {
    full_address?: string;
    name?: string;
    place_formatted?: string;
  };
}

interface MapboxV5Feature {
  center?: [number, number];
  place_name?: string;
  relevance?: number;
  place_type?: string[];
}

/**
 * Browser-compatible geocoder combining OpenStreetMap Nominatim + Overpass road
 * topology with optional Mapbox Geocoding fallback. Requires no custom backend.
 */
export class DefaultGeorefGeocoder implements GeorefGeocoder {
  private readonly jurisdictionCache = new Map<string, ResolvedJurisdiction>();

  constructor(private readonly mapboxToken: string = env.MAPBOX_TOKEN ?? '') {}

  async resolveJurisdiction(
    hint: GeographicRegionHint
  ): Promise<ResolvedJurisdiction | null> {
    const queries = buildJurisdictionSearchQueries(hint);
    const stateMatchers = normalizeStateToken(hint.state);
    const countyLower = (hint.county ?? '')
      .toLowerCase()
      .replace(/\bcounty\b/g, '')
      .trim();

    const localViewportCenter =
      hint.viewportHint &&
      hint.viewportHint.bounds.east - hint.viewportHint.bounds.west < 3.0 &&
      !(
        Math.abs(hint.viewportHint.center.lon) < 0.05 &&
        Math.abs(hint.viewportHint.center.lat) < 0.05
      )
        ? hint.viewportHint.center
        : null;

    for (const query of queries) {
      const cached = this.jurisdictionCache.get(query);
      if (cached) return cached;

      const nominatimResult = await this.searchNominatimJurisdiction(
        query,
        stateMatchers,
        countyLower,
        localViewportCenter
      );
      if (nominatimResult) {
        this.jurisdictionCache.set(query, nominatimResult);
        return nominatimResult;
      }

      if (this.mapboxToken) {
        const mapboxResult = await this.searchMapboxJurisdiction(
          query,
          stateMatchers,
          countyLower,
          localViewportCenter
        );
        if (mapboxResult) {
          this.jurisdictionCache.set(query, mapboxResult);
          return mapboxResult;
        }
      }
    }

    if (localViewportCenter && hint.viewportHint) {
      return {
        displayName: 'Current map viewport',
        center: localViewportCenter,
        bbox: expandJurisdictionBbox(hint.viewportHint.bounds),
        source: 'viewport'
      };
    }

    return null;
  }

  async resolveIntersections(
    queries: ReadonlyArray<StreetIntersectionQuery>,
    jurisdiction: ResolvedJurisdiction
  ): Promise<Map<string, GroundedIntersectionCandidate[]>> {
    const resolved = new Map<string, GroundedIntersectionCandidate[]>();
    if (queries.length === 0) return resolved;

    // 1. Primary: OpenStreetMap Overpass road-network centerline intersections
    const ways = await this.fetchOverpassRoads(queries, jurisdiction.bbox);
    if (ways.length > 0) {
      const osmMatches = findIntersectionsFromOsmWays(ways, queries);
      for (const [id, candidates] of osmMatches.entries()) {
        resolved.set(id, candidates);
      }
    }

    // 2. Fallback for any unresolved intersection when Mapbox token is configured
    if (this.mapboxToken) {
      const missing = queries.filter((q) => !resolved.has(q.id));
      const fallbackPromises = missing.slice(0, 6).map(async (q) => {
        const geocoded = await this.geocodeIntersectionMapbox(q, jurisdiction);
        if (geocoded.length > 0) {
          resolved.set(q.id, geocoded);
        }
      });
      await Promise.all(fallbackPromises);
    }

    return resolved;
  }

  private async searchNominatimJurisdiction(
    query: string,
    stateMatchers: string[],
    countyLower: string,
    localViewportCenter: LonLatCoordinate | null
  ): Promise<ResolvedJurisdiction | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEOCODER_TIMEOUT_MS);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!res.ok) return null;

      const items = (await res.json()) as NominatimItem[];
      if (!Array.isArray(items) || items.length === 0) return null;

      let best: { item: NominatimItem; score: number } | null = null;
      for (const item of items) {
        const lat = Number(item.lat);
        const lon = Number(item.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const text =
          `${item.display_name ?? ''} ${Object.values(item.address ?? {}).join(' ')}`.toLowerCase();

        if (
          stateMatchers.length > 0 &&
          !stateMatchers.some((st) =>
            new RegExp(`\\b${escapeOverpassRegex(st)}\\b`, 'i').test(text)
          )
        ) {
          continue;
        }

        let score = (item.importance ?? 0.4) * 10;
        if (item.class === 'boundary' || item.class === 'place') score += 5;
        if (countyLower && text.includes(countyLower)) score += 4;
        if (localViewportCenter) {
          const distKm =
            haversineDistanceMeters({ lon, lat }, localViewportCenter) / 1000;
          if (distKm < 50) score += 3;
          else if (distKm < 150) score += 1;
        }

        if (!best || score > best.score) {
          best = { item, score };
        }
      }

      if (!best) return null;
      const lat = Number(best.item.lat);
      const lon = Number(best.item.lon);
      const rawBbox = best.item.boundingbox;
      const bbox: GeoBoundingBox =
        rawBbox && rawBbox.length === 4
          ? expandJurisdictionBbox({
              south: Number(rawBbox[0]),
              north: Number(rawBbox[1]),
              west: Number(rawBbox[2]),
              east: Number(rawBbox[3])
            })
          : expandJurisdictionBbox({
              west: lon - 0.06,
              east: lon + 0.06,
              south: lat - 0.05,
              north: lat + 0.05
            });

      return {
        displayName: best.item.display_name ?? query,
        center: { lon, lat },
        bbox,
        source: 'nominatim'
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchMapboxJurisdiction(
    query: string,
    stateMatchers: string[],
    countyLower: string,
    localViewportCenter: LonLatCoordinate | null
  ): Promise<ResolvedJurisdiction | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEOCODER_TIMEOUT_MS);
    try {
      const proximityParam = localViewportCenter
        ? `&proximity=${localViewportCenter.lon},${localViewportCenter.lat}`
        : '';
      const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query)}&types=place,locality,district,postcode&limit=5${proximityParam}&access_token=${encodeURIComponent(this.mapboxToken)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;

      const data = (await res.json()) as { features?: MapboxV6Feature[] };
      const features = data.features ?? [];
      for (const feat of features) {
        const coords = feat.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;
        const [lon, lat] = coords;
        const label =
          feat.properties?.full_address ||
          [feat.properties?.name, feat.properties?.place_formatted]
            .filter(Boolean)
            .join(', ') ||
          query;
        const lower = label.toLowerCase();

        if (
          stateMatchers.length > 0 &&
          !stateMatchers.some((st) =>
            new RegExp(`\\b${escapeOverpassRegex(st)}\\b`, 'i').test(lower)
          )
        ) {
          continue;
        }
        if (
          countyLower &&
          features.length > 1 &&
          !lower.includes(countyLower) &&
          features.some((f) =>
            (f.properties?.full_address ?? '')
              .toLowerCase()
              .includes(countyLower)
          )
        ) {
          continue;
        }

        const rawBbox = feat.bbox;
        const bbox =
          rawBbox && rawBbox.length === 4
            ? expandJurisdictionBbox({
                west: rawBbox[0],
                south: rawBbox[1],
                east: rawBbox[2],
                north: rawBbox[3]
              })
            : expandJurisdictionBbox({
                west: lon - 0.06,
                east: lon + 0.06,
                south: lat - 0.05,
                north: lat + 0.05
              });

        return {
          displayName: label,
          center: { lon, lat },
          bbox,
          source: 'mapbox'
        };
      }

      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchOverpassRoads(
    queries: ReadonlyArray<StreetIntersectionQuery>,
    bbox: GeoBoundingBox
  ): Promise<OsmRoadWay[]> {
    const regex = buildOverpassStreetRegex(queries);
    if (!regex) return [];

    const bboxStr = `${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)}`;
    const overpassQl = `[out:json][timeout:8];(way["highway"][~"^(name|ref|alt_name|official_name)$"~"${regex}",i](${bboxStr}););out body geom;`;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
          },
          body: `data=${encodeURIComponent(overpassQl)}`,
          signal: controller.signal
        });
        if (!res.ok) continue;

        const payload = (await res.json()) as { elements?: OsmRoadWay[] };
        if (Array.isArray(payload.elements)) {
          return payload.elements;
        }
      } catch {
        // Try backup Overpass mirror
      } finally {
        clearTimeout(timer);
      }
    }

    return [];
  }

  private async geocodeIntersectionMapbox(
    query: StreetIntersectionQuery,
    jurisdiction: ResolvedJurisdiction
  ): Promise<GroundedIntersectionCandidate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEOCODER_TIMEOUT_MS);
    try {
      const searchStr = `${query.street1} and ${query.street2}, ${jurisdiction.displayName}`;
      const { west, south, east, north } = jurisdiction.bbox;
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(searchStr)}.json?bbox=${west},${south},${east},${north}&types=address,street&limit=3&access_token=${encodeURIComponent(this.mapboxToken)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return [];

      const data = (await res.json()) as { features?: MapboxV5Feature[] };
      const q1 = parseStreetSignature(query.street1);
      const q2 = parseStreetSignature(query.street2);
      const candidates: GroundedIntersectionCandidate[] = [];

      for (const feat of data.features ?? []) {
        if (!feat.center || feat.center.length < 2) continue;
        const [lon, lat] = feat.center;
        if (lon < west || lon > east || lat < south || lat > north) continue;

        const placeName = (feat.place_name ?? '').toLowerCase();
        // Require the returned feature label to reference both streets or have high intersection relevance
        const mentionsFirst = q1.some(
          (s) =>
            (s.core && placeName.includes(s.core)) ||
            s.routes.some((r) => placeName.includes(r.number))
        );
        const mentionsSecond = q2.some(
          (s) =>
            (s.core && placeName.includes(s.core)) ||
            s.routes.some((r) => placeName.includes(r.number))
        );

        if (!mentionsFirst && !mentionsSecond) continue;
        const relevance = feat.relevance ?? 0.6;
        if (!mentionsSecond && relevance < 0.85) continue;

        candidates.push({
          lon,
          lat,
          source: 'mapbox_geocoder',
          confidence: mentionsFirst && mentionsSecond ? 0.78 : 0.62,
          matchedNames: feat.place_name ?? `${query.street1} & ${query.street2}`
        });
      }

      return candidates;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Shared default geocoder instance. */
export const defaultGeorefGeocoder: GeorefGeocoder =
  new DefaultGeorefGeocoder();
