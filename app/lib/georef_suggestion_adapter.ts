import {
  GoogleGenerativeAI,
  SchemaType,
  type Part
} from '@google/generative-ai';
import { logAiError } from 'app/lib/ai_logger';
import { aiEnv } from 'app/lib/env_ai';
import {
  defaultGeorefGeocoder,
  type GeorefGeocoder,
  type GroundedIntersectionCandidate
} from 'app/lib/georef_geocoder';
import {
  extractPdfPageGeorefData,
  inferVectorStreetCrossings,
  renderPdfLandmarkCrops,
  type ExtractedPdfPageContext,
  type PdfLandmarkCrop
} from 'app/lib/pdf_georef_extractor';
import {
  selectConsistentControlPoints,
  solveAffineTransform,
  type CandidateControlPointOption
} from 'app/lib/transform_engine';
import { nanoid } from 'nanoid';

const GEMINI_TIMEOUT_MS = 30_000;
const CROP_REFINE_TIMEOUT_MS = 18_000;
const FALLBACK_GEMINI_MODELS = ['gemini-2.5-flash'];
const DEFAULT_PDF_WIDTH_PT = 612;
const DEFAULT_PDF_HEIGHT_PT = 792;

/** Configured provider category for georeference suggestions. */
export type GeorefSuggestionSource = 'Proxy' | 'Gemini' | 'Heuristic';

/** Granular provenance describing how a suggestion's coordinates were derived. */
export type GeorefSuggestionProvenance =
  | 'geopdf'
  | 'gemini_grounded'
  | 'gemini_estimated'
  | 'vector_text'
  | 'proxy'
  | 'heuristic';

/** Suggested control point pairing unscaled PDF coordinates with WGS-84 coordinates. */
export interface GeorefSuggestion {
  id: string;
  pdf: {
    /** Unscaled PDF user-space X coordinate (points at scale = 1). */
    x: number;
    /** Unscaled PDF user-space Y coordinate (points at scale = 1). */
    y: number;
    page: number;
  };
  map: {
    lon: number;
    lat: number;
  };
  confidence: number;
  rationale: string;
  provenance?: GeorefSuggestionProvenance;
  identifiedRegion?: string;
}

/** Input payload for requesting georeference control-point suggestions. */
export interface GeorefSuggestionRequest {
  page: number;
  mapCenter: {
    lon: number;
    lat: number;
  };
  mapBounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  base64Image?: string;
  /** Rendered canvas width (legacy fallback when pdfPageWidth is omitted). */
  imageWidth?: number;
  /** Rendered canvas height (legacy fallback when pdfPageHeight is omitted). */
  imageHeight?: number;
  /** Unscaled PDF page width in points (scale = 1). */
  pdfPageWidth?: number;
  /** Unscaled PDF page height in points (scale = 1). */
  pdfPageHeight?: number;
  /** Source PDF file used for high-res offscreen rendering, vector text, and GeoPDF parsing. */
  pdfFile?: File;
  /** Optional filename hint (e.g. "Champaign_Zoning_2025.pdf"). */
  sourceName?: string;
  /** Optional pre-extracted PDF page context. */
  extractedContext?: ExtractedPdfPageContext | null;
}

/** Adapter contract for suggesting georeference control point pairs. */
export interface GeorefSuggestionAdapter {
  suggestPoints(request: GeorefSuggestionRequest): Promise<GeorefSuggestion[]>;
}

/**
 * Resolves the active georeference suggestion source label in priority order.
 */
export function resolveGeorefSuggestionSource(
  proxyUrl: string,
  geminiApiKey: string
): GeorefSuggestionSource {
  if (proxyUrl) {
    return 'Proxy';
  }

  if (geminiApiKey) {
    return 'Gemini';
  }

  return 'Heuristic';
}

interface RemoteGeorefSuggestionResponse {
  suggestions: Array<{
    pdf: {
      x: number;
      y: number;
      page: number;
    };
    map: {
      lon: number;
      lat: number;
    };
    confidence: number;
    rationale: string;
  }>;
}

interface LegacyParsedSuggestion {
  pdf?: {
    x?: number;
    y?: number;
    page?: number;
  };
  map?: {
    lon?: number | string;
    lat?: number | string;
  };
  confidence?: number;
  rationale?: string;
}

interface GeminiLandmarkItem {
  street_1?: string;
  street_2?: string;
  /** Native Gemini 2D spatial coordinate [y, x] normalized to 0..1000. */
  point_2d?: number[];
  pdf?: {
    x?: number;
    y?: number;
    page?: number;
  };
  approximate_lon?: number | string;
  approximate_lat?: number | string;
  map?: {
    lon?: number | string;
    lat?: number | string;
  };
  confidence?: number;
  rationale?: string;
}

interface GeminiStructuredGeorefPayload {
  geographic_context?: {
    municipality?: string;
    county?: string;
    state?: string;
    country?: string;
    identified_region?: string;
    north_up?: boolean;
  };
  landmarks?: GeminiLandmarkItem[];
  suggestions?: LegacyParsedSuggestion[];
}

/** Parsed landmark candidate normalized to [0, 1] page fractions before scaling. */
export interface ParsedModelLandmark {
  street1: string;
  street2: string;
  /** Normalized X fraction in [0, 1]. */
  normX: number;
  /** Normalized Y fraction in [0, 1]. */
  normY: number;
  page: number;
  approxLon?: number;
  approxLat?: number;
  confidence: number;
  rationale: string;
}

/**
 * Parses legacy or structured model JSON into GeorefSuggestion items.
 */
export function parseGeorefSuggestionResponse(
  jsonStr: string,
  fallbackPage: number
): GeorefSuggestion[] {
  try {
    const cleaned = stripMarkdownCodeFence(jsonStr);
    const parsed = JSON.parse(cleaned) as GeminiStructuredGeorefPayload;
    if (!Array.isArray(parsed.suggestions)) {
      return [];
    }

    return parsed.suggestions
      .filter((suggestion) => suggestion?.pdf && suggestion?.map)
      .map((suggestion) => {
        const lon = Number(suggestion.map?.lon);
        const lat = Number(suggestion.map?.lat);
        return {
          id: nanoid(10),
          pdf: {
            x: Number(suggestion.pdf?.x) || 0,
            y: Number(suggestion.pdf?.y) || 0,
            page: Number(suggestion.pdf?.page) || fallbackPage
          },
          map: {
            lon: Number.isNaN(lon) ? 0 : lon,
            lat: Number.isNaN(lat) ? 0 : lat
          },
          confidence: clamp01(Number(suggestion.confidence) || 0),
          rationale: String(suggestion.rationale ?? '').trim()
        };
      })
      .filter(
        (suggestion) =>
          suggestion.map.lon !== 0 &&
          suggestion.map.lat !== 0 &&
          Number.isFinite(suggestion.map.lon) &&
          Number.isFinite(suggestion.map.lat)
      );
  } catch {
    return [];
  }
}

/**
 * Parses Gemini's structured geographic context and [y, x] 0..1000 landmark output.
 */
export function parseStructuredGeminiLandmarks(
  jsonStr: string,
  fallbackPage: number
): {
  context: NonNullable<GeminiStructuredGeorefPayload['geographic_context']>;
  landmarks: ParsedModelLandmark[];
} {
  try {
    const cleaned = stripMarkdownCodeFence(jsonStr);
    const parsed = JSON.parse(cleaned) as GeminiStructuredGeorefPayload;
    const context = parsed.geographic_context ?? {};
    const rawItems: GeminiLandmarkItem[] = Array.isArray(parsed.landmarks)
      ? parsed.landmarks
      : Array.isArray(parsed.suggestions)
        ? parsed.suggestions
        : [];

    const landmarks: ParsedModelLandmark[] = [];
    for (const item of rawItems) {
      let normX: number | null = null;
      let normY: number | null = null;

      if (Array.isArray(item.point_2d) && item.point_2d.length >= 2) {
        const rawY = Number(item.point_2d[0]);
        const rawX = Number(item.point_2d[1]);
        if (Number.isFinite(rawY) && Number.isFinite(rawX)) {
          // Native Gemini 0..1000 [y, x] integers (also tolerate 0..1 floats if returned)
          if (rawX <= 1.01 && rawY <= 1.01 && (rawX < 1 || rawY < 1)) {
            normX = rawX;
            normY = rawY;
          } else {
            normX = rawX / 1000;
            normY = rawY / 1000;
          }
        }
      } else if (item.pdf) {
        const px = Number(item.pdf.x);
        const py = Number(item.pdf.y);
        if (Number.isFinite(px) && Number.isFinite(py)) {
          if (px >= -0.01 && px <= 1.01 && py >= -0.01 && py <= 1.01) {
            normX = px;
            normY = py;
          } else if (px >= 0 && px <= 1000 && py >= 0 && py <= 1000) {
            normX = px / 1000;
            normY = py / 1000;
          }
        }
      }

      if (
        normX === null ||
        normY === null ||
        normX < -0.02 ||
        normX > 1.02 ||
        normY < -0.02 ||
        normY > 1.02
      ) {
        continue;
      }

      const clampedNormX = clamp01(normX);
      const clampedNormY = clamp01(normY);

      const rawLon = Number(item.approximate_lon ?? item.map?.lon);
      const rawLat = Number(item.approximate_lat ?? item.map?.lat);
      const hasApproxCoord =
        Number.isFinite(rawLon) &&
        Number.isFinite(rawLat) &&
        Math.abs(rawLat) <= 90 &&
        Math.abs(rawLon) <= 180 &&
        !(rawLon === 0 && rawLat === 0);

      const street1 = String(item.street_1 ?? '').trim();
      const street2 = String(item.street_2 ?? '').trim();

      landmarks.push({
        street1,
        street2,
        normX: clampedNormX,
        normY: clampedNormY,
        page: Number(item.pdf?.page) || fallbackPage,
        approxLon: hasApproxCoord ? rawLon : undefined,
        approxLat: hasApproxCoord ? rawLat : undefined,
        confidence: clamp01(Number(item.confidence) || 0.7),
        rationale:
          String(item.rationale ?? '').trim() ||
          (street1 && street2 ? `${street1} & ${street2}` : 'Map landmark')
      });
    }

    return { context, landmarks };
  } catch {
    return { context: {}, landmarks: [] };
  }
}

/**
 * Optional proxy-backed adapter configured from environment variables.
 */
export class RemoteGeorefSuggestionAdapter implements GeorefSuggestionAdapter {
  constructor(
    private readonly apiUrl: string,
    private readonly geminiApiKey = ''
  ) {}

  async suggestPoints(
    request: GeorefSuggestionRequest
  ): Promise<GeorefSuggestion[]> {
    // Strip non-serializable File object before JSON.stringify
    const {
      pdfFile: _pdfFile,
      extractedContext: _ctx,
      ...serializable
    } = request;
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.geminiApiKey ? { 'X-Gemini-Api-Key': this.geminiApiKey } : {})
      },
      body: JSON.stringify(serializable)
    });

    if (!response.ok) {
      throw new Error(
        `Georef suggestion API failed with status ${response.status}`
      );
    }

    const payload = (await response.json()) as RemoteGeorefSuggestionResponse;

    return payload.suggestions.map((suggestion) => ({
      id: nanoid(10),
      pdf: suggestion.pdf,
      map: suggestion.map,
      confidence: suggestion.confidence,
      rationale: suggestion.rationale,
      provenance: 'proxy'
    }));
  }
}

/**
 * Gemini-backed georeferencing adapter with GeoPDF metadata extraction, vector text
 * assistance, road-network intersection grounding, crop-level refinement, and RANSAC verification.
 */
export class GeminiGeorefSuggestionAdapter implements GeorefSuggestionAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly fallback: GeorefSuggestionAdapter = new HeuristicGeorefSuggestionAdapter(),
    private readonly geocoder: GeorefGeocoder = defaultGeorefGeocoder
  ) {}

  async suggestPoints(
    request: GeorefSuggestionRequest
  ): Promise<GeorefSuggestion[]> {
    const context = await resolvePageContext(request);
    const { pdfWidth, pdfHeight } = resolveTargetPdfDimensions(
      request,
      context
    );

    // 1. Exact embedded GeoPDF registration metadata takes priority when present
    if (context && context.embeddedGeoPoints.length >= 3) {
      return context.embeddedGeoPoints.slice(0, 4).map((pt, idx) => ({
        id: nanoid(10),
        pdf: {
          x: roundCoord(pt.pdf.x),
          y: roundCoord(pt.pdf.y),
          page: request.page
        },
        map: pt.map,
        confidence: 0.98,
        rationale: `Embedded GeoPDF registration point ${idx + 1}`,
        provenance: 'geopdf'
      }));
    }

    if (!this.apiKey) {
      return this.fallback.suggestPoints({
        ...request,
        extractedContext: context,
        pdfPageWidth: pdfWidth,
        pdfPageHeight: pdfHeight
      });
    }

    const genAI = new GoogleGenerativeAI(this.apiKey);

    try {
      const imageDataUrl = context?.highResBase64Image ?? request.base64Image;
      const prompt = buildLandmarkExtractionPrompt(request, context);

      const contentParts: Array<string | Part> = [prompt];
      if (imageDataUrl) {
        const inlinePart = dataUrlToGenerativePart(imageDataUrl);
        if (inlinePart) {
          contentParts.push(inlinePart);
        }
      }

      const rawResponseText = await this.generateJsonWithModelFallback(
        genAI,
        contentParts,
        GEMINI_SCHEMA,
        GEMINI_TIMEOUT_MS
      );

      const { context: geoContext, landmarks } = parseStructuredGeminiLandmarks(
        rawResponseText,
        request.page
      );

      if (landmarks.length === 0) {
        return this.fallback.suggestPoints({
          ...request,
          extractedContext: context,
          pdfPageWidth: pdfWidth,
          pdfPageHeight: pdfHeight
        });
      }

      // 2. Ground municipality/county/state and street intersections on real road geometry
      const jurisdiction = await this.geocoder.resolveJurisdiction({
        municipality: geoContext.municipality,
        county: geoContext.county,
        state: geoContext.state,
        country: geoContext.country || 'USA',
        rawRegionText: geoContext.identified_region,
        sourceName: request.sourceName ?? request.pdfFile?.name,
        viewportHint: {
          center: request.mapCenter,
          bounds: request.mapBounds
        }
      });

      const intersectionQueries = landmarks
        .map((lm, idx) => ({
          id: `lm-${idx}`,
          street1: lm.street1,
          street2: lm.street2
        }))
        .filter((q) => q.street1.length > 0 && q.street2.length > 0);

      const groundedMap =
        jurisdiction && intersectionQueries.length > 0
          ? await this.geocoder.resolveIntersections(
              intersectionQueries,
              jurisdiction
            )
          : new Map<string, GroundedIntersectionCandidate[]>();

      const regionLabel =
        jurisdiction && jurisdiction.source !== 'viewport'
          ? jurisdiction.displayName
          : [geoContext.municipality, geoContext.county, geoContext.state]
              .filter(Boolean)
              .join(', ') || geoContext.identified_region;

      interface LandmarkSelectionMeta {
        landmarkIndex: number;
        landmark: ParsedModelLandmark;
        grounded: boolean;
        matchedNames: string;
        sourceConfidence: number;
      }

      const groundedGroupCount = Array.from(groundedMap.values()).filter(
        (arr) => arr.length > 0
      ).length;

      const candidateGroups: CandidateControlPointOption<LandmarkSelectionMeta>[][] =
        [];

      landmarks.forEach((lm, idx) => {
        const pdfPt = {
          x: lm.normX * pdfWidth,
          y: lm.normY * pdfHeight
        };
        const groundedHits = groundedMap.get(`lm-${idx}`) ?? [];

        if (groundedHits.length > 0) {
          candidateGroups.push(
            groundedHits.map((hit) => ({
              pdf: pdfPt,
              map: { lon: hit.lon, lat: hit.lat },
              priorConfidence: hit.confidence,
              metadata: {
                landmarkIndex: idx,
                landmark: lm,
                grounded: true,
                matchedNames: hit.matchedNames,
                sourceConfidence: hit.confidence
              }
            }))
          );
          return;
        }

        // Only include ungrounded model coordinate estimates if fewer than 3 landmarks grounded on road network
        if (
          groundedGroupCount < 3 &&
          lm.approxLon !== undefined &&
          lm.approxLat !== undefined
        ) {
          const withinJurisdiction =
            !jurisdiction ||
            jurisdiction.source === 'viewport' ||
            (lm.approxLon >= jurisdiction.bbox.west - 0.15 &&
              lm.approxLon <= jurisdiction.bbox.east + 0.15 &&
              lm.approxLat >= jurisdiction.bbox.south - 0.15 &&
              lm.approxLat <= jurisdiction.bbox.north + 0.15);

          if (withinJurisdiction) {
            candidateGroups.push([
              {
                pdf: pdfPt,
                map: { lon: lm.approxLon, lat: lm.approxLat },
                priorConfidence: Math.min(0.48, lm.confidence * 0.55),
                metadata: {
                  landmarkIndex: idx,
                  landmark: lm,
                  grounded: false,
                  matchedNames: lm.rationale,
                  sourceConfidence: Math.min(0.48, lm.confidence * 0.55)
                }
              }
            ]);
          }
        }
      });

      const consistent =
        selectConsistentControlPoints(candidateGroups, {
          maxPoints: 4,
          expectedRotationDegrees:
            geoContext.north_up === false ? undefined : 0,
          maxRotationDeviationDegrees:
            geoContext.north_up === false ? undefined : 30,
          pdfSpanHint: Math.max(pdfWidth, pdfHeight)
        }) ??
        // Retry without strict North-up angle gate in case the map is rotated without a detected North arrow
        selectConsistentControlPoints(candidateGroups, {
          maxPoints: 4,
          pdfSpanHint: Math.max(pdfWidth, pdfHeight)
        });

      if (consistent && consistent.selected.length >= 3) {
        let finalPoints = consistent.selected.map((sel) => ({
          pdf: { ...sel.pdf },
          map: sel.map,
          residualMeters: sel.residualMeters,
          meta: sel.metadata!
        }));

        // 3. Zoomed high-DPI crop refinement on the PDF to snap onto exact road centerlines
        if (request.pdfFile) {
          finalPoints = await this.refinePdfPointsWithCrops(
            genAI,
            request.pdfFile,
            request.page,
            finalPoints
          );
        }

        return finalPoints.map((pt) => {
          const residualPenalty = Math.min(
            0.25,
            pt.residualMeters /
              Math.max(150, consistent.scaleMetersPerPdfUnit * 80)
          );
          const calibratedConfidence = pt.meta.grounded
            ? clamp01(
                Math.max(0.55, pt.meta.sourceConfidence - residualPenalty)
              )
            : clamp01(Math.min(0.48, pt.meta.sourceConfidence));

          const prefix = pt.meta.grounded
            ? 'Verified intersection'
            : 'Estimated landmark (unverified road match)';

          return {
            id: nanoid(10),
            pdf: {
              x: roundCoord(pt.pdf.x),
              y: roundCoord(pt.pdf.y),
              page: pt.meta.landmark.page
            },
            map: pt.map,
            confidence: calibratedConfidence,
            rationale: `${prefix}: ${pt.meta.matchedNames}${regionLabel ? ` (${regionLabel})` : ''}`,
            provenance: pt.meta.grounded
              ? 'gemini_grounded'
              : 'gemini_estimated',
            identifiedRegion: regionLabel
          };
        });
      }

      // If <3 consistent points were available, return any grounded intersections honestly with cautious confidence
      const fallbackGrounded: GeorefSuggestion[] = [];
      landmarks.forEach((lm, idx) => {
        const hit = groundedMap.get(`lm-${idx}`)?.[0];
        if (hit && fallbackGrounded.length < 4) {
          fallbackGrounded.push({
            id: nanoid(10),
            pdf: {
              x: roundCoord(lm.normX * pdfWidth),
              y: roundCoord(lm.normY * pdfHeight),
              page: lm.page
            },
            map: { lon: hit.lon, lat: hit.lat },
            confidence: 0.52,
            rationale: `Matched intersection (insufficient 3-point consensus): ${hit.matchedNames}`,
            provenance: 'gemini_grounded',
            identifiedRegion: regionLabel
          });
        }
      });

      if (fallbackGrounded.length > 0) {
        return fallbackGrounded;
      }

      return this.fallback.suggestPoints({
        ...request,
        extractedContext: context,
        pdfPageWidth: pdfWidth,
        pdfPageHeight: pdfHeight
      });
    } catch (error) {
      logAiError('georef', error);
      return this.fallback.suggestPoints({
        ...request,
        extractedContext: context,
        pdfPageWidth: pdfWidth,
        pdfPageHeight: pdfHeight
      });
    }
  }

  private async generateJsonWithModelFallback(
    genAI: GoogleGenerativeAI,
    parts: Array<string | Part>,
    responseSchema: Record<string, unknown>,
    timeoutMs: number
  ): Promise<string> {
    const modelsToTry = [
      aiEnv.GEMINI_MODEL,
      ...FALLBACK_GEMINI_MODELS.filter((m) => m !== aiEnv.GEMINI_MODEL)
    ];

    let lastError: unknown;
    for (const modelName of modelsToTry) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            responseSchema: responseSchema as any
          }
        });

        const result = await model.generateContent(parts, {
          signal: controller.signal
        });
        return result.response.text();
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isModelError = /404|not\s+found|not\s+supported/i.test(msg);
        if (!isModelError) {
          throw err;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Gemini georeference generation failed');
  }

  private async refinePdfPointsWithCrops<
    TMeta extends {
      landmark: ParsedModelLandmark;
    }
  >(
    genAI: GoogleGenerativeAI,
    pdfFile: File,
    page: number,
    points: Array<{
      pdf: { x: number; y: number };
      map: { lon: number; lat: number };
      residualMeters: number;
      meta: TMeta;
    }>
  ): Promise<typeof points> {
    try {
      const targets = points.map((pt, idx) => ({
        id: `c${idx}`,
        x: pt.pdf.x,
        y: pt.pdf.y
      }));
      const crops: PdfLandmarkCrop[] = await renderPdfLandmarkCrops(
        pdfFile,
        page,
        targets
      );
      if (crops.length !== points.length) {
        return points;
      }

      const cropDescriptions = points
        .map(
          (pt, idx) =>
            `Crop c${idx}: locate the exact road-centerline intersection of "${pt.meta.landmark.street1}" and "${pt.meta.landmark.street2}" (do NOT point at the street name text label — point at the exact center where the two road centerlines cross).`
        )
        .join('\n');

      const refinePrompt =
        `You are given ${crops.length} zoomed-in map crops in order (c0 to c${crops.length - 1}).\n` +
        `${cropDescriptions}\n` +
        `For each crop id, return 'found': true and 'point_2d': [y, x] normalized 0..1000 within that crop, or 'found': false if the intersection is not inside that crop.`;

      const parts: Array<string | Part> = [refinePrompt];
      for (const crop of crops) {
        const inline = dataUrlToGenerativePart(crop.base64Image);
        if (!inline) return points;
        parts.push(`Crop ${crop.id}:`);
        parts.push(inline);
      }

      const text = await this.generateJsonWithModelFallback(
        genAI,
        parts,
        CROP_REFINE_SCHEMA,
        CROP_REFINE_TIMEOUT_MS
      );

      const parsed = JSON.parse(stripMarkdownCodeFence(text)) as {
        refined?: Array<{
          id?: string;
          found?: boolean;
          point_2d?: number[];
        }>;
      };
      if (!Array.isArray(parsed.refined)) return points;

      const refinedCandidates = points.map((pt, idx) => {
        const match = parsed.refined?.find((r) => r.id === `c${idx}`);
        const crop = crops[idx];
        if (
          !match?.found ||
          !Array.isArray(match.point_2d) ||
          match.point_2d.length < 2
        ) {
          return pt;
        }
        const cy = Number(match.point_2d[0]);
        const cx = Number(match.point_2d[1]);
        if (
          !Number.isFinite(cy) ||
          !Number.isFinite(cx) ||
          cx < 0 ||
          cx > 1000 ||
          cy < 0 ||
          cy > 1000
        ) {
          return pt;
        }

        return {
          ...pt,
          pdf: {
            x: crop.cropMinX + (cx / 1000) * crop.cropWidth,
            y: crop.cropMinY + (cy / 1000) * crop.cropHeight
          }
        };
      });

      // Only adopt crop-refined coordinates if affine fit improves or stays consistent
      const beforeSolve = solveAffineTransform(points);
      const afterSolve = solveAffineTransform(refinedCandidates);
      if (afterSolve.rmsErrorMeters <= beforeSolve.rmsErrorMeters * 1.15 + 8) {
        return refinedCandidates.map((pt, idx) => ({
          ...pt,
          residualMeters: afterSolve.residuals[idx].errorMeters
        }));
      }

      return points;
    } catch {
      return points;
    }
  }
}

/**
 * Deterministic georeference suggestion adapter that uses embedded GeoPDF metadata
 * or vector PDF street-label crossings + road-network geocoding when available,
 * degrading gracefully to in-bounds viewport estimates otherwise.
 */
export class HeuristicGeorefSuggestionAdapter implements GeorefSuggestionAdapter {
  constructor(
    private readonly geocoder: GeorefGeocoder = defaultGeorefGeocoder
  ) {}

  async suggestPoints(
    request: GeorefSuggestionRequest
  ): Promise<GeorefSuggestion[]> {
    const context = await resolvePageContext(request);
    const { pdfWidth, pdfHeight } = resolveTargetPdfDimensions(
      request,
      context
    );

    // 1. Embedded GeoPDF fast path
    if (context && context.embeddedGeoPoints.length >= 3) {
      return context.embeddedGeoPoints.slice(0, 4).map((pt, idx) => ({
        id: nanoid(10),
        pdf: {
          x: roundCoord(pt.pdf.x),
          y: roundCoord(pt.pdf.y),
          page: request.page
        },
        map: pt.map,
        confidence: 0.98,
        rationale: `Embedded GeoPDF registration point ${idx + 1}`,
        provenance: 'geopdf'
      }));
    }

    // 2. Vector street-label crossing + OSM road intersection solver (no AI key needed!)
    if (context && context.streetTextItems.length >= 4) {
      const crossings = inferVectorStreetCrossings(
        context.streetTextItems,
        pdfWidth,
        pdfHeight,
        14
      );

      if (crossings.length >= 3) {
        const rawTitle = context.titleTextCandidates.slice(0, 5).join(' ');
        const jurisdiction = await this.geocoder.resolveJurisdiction({
          rawRegionText: rawTitle,
          sourceName: request.sourceName ?? request.pdfFile?.name,
          viewportHint: {
            center: request.mapCenter,
            bounds: request.mapBounds
          }
        });

        if (jurisdiction) {
          const queries = crossings.map((c, idx) => ({
            id: `vc-${idx}`,
            street1: c.street1,
            street2: c.street2
          }));
          const grounded = await this.geocoder.resolveIntersections(
            queries,
            jurisdiction
          );

          const groups: CandidateControlPointOption<{
            label: string;
            confidence: number;
          }>[][] = [];

          crossings.forEach((c, idx) => {
            const hits = grounded.get(`vc-${idx}`) ?? [];
            if (hits.length > 0) {
              groups.push(
                hits.map((h) => ({
                  pdf: c.pdf,
                  map: { lon: h.lon, lat: h.lat },
                  priorConfidence: h.confidence * 0.85,
                  metadata: {
                    label: h.matchedNames,
                    confidence: h.confidence * 0.82
                  }
                }))
              );
            }
          });

          const consistent = selectConsistentControlPoints(groups, {
            maxPoints: 4,
            pdfSpanHint: Math.max(pdfWidth, pdfHeight)
          });

          if (consistent && consistent.selected.length >= 3) {
            return consistent.selected.map((sel) => ({
              id: nanoid(10),
              pdf: {
                x: roundCoord(sel.pdf.x),
                y: roundCoord(sel.pdf.y),
                page: request.page
              },
              map: sel.map,
              confidence: clamp01(sel.metadata?.confidence ?? 0.72),
              rationale: `Vector street label crossing: ${sel.metadata?.label ?? ''}`,
              provenance: 'vector_text',
              identifiedRegion:
                jurisdiction.source !== 'viewport'
                  ? jurisdiction.displayName
                  : undefined
            }));
          }
        }
      }
    }

    // 3. Proportional in-bounds viewport placeholder fallback
    const { mapCenter, mapBounds, page } = request;
    const mapLonSpan = Math.max(mapBounds.east - mapBounds.west, 0.00001);
    const mapLatSpan = Math.max(mapBounds.north - mapBounds.south, 0.00001);

    const templates = [
      {
        pdf: {
          x: roundCoord(pdfWidth * 0.22),
          y: roundCoord(pdfHeight * 0.22)
        },
        map: {
          lon: mapCenter.lon - mapLonSpan * 0.22,
          lat: mapCenter.lat + mapLatSpan * 0.18
        },
        confidence: 0.32,
        rationale:
          'Fallback estimate (upper-left viewport placeholder — adjust on PDF and map before confirming)'
      },
      {
        pdf: {
          x: roundCoord(pdfWidth * 0.78),
          y: roundCoord(pdfHeight * 0.22)
        },
        map: {
          lon: mapCenter.lon + mapLonSpan * 0.22,
          lat: mapCenter.lat + mapLatSpan * 0.18
        },
        confidence: 0.3,
        rationale:
          'Fallback estimate (upper-right viewport placeholder — adjust on PDF and map before confirming)'
      },
      {
        pdf: {
          x: roundCoord(pdfWidth * 0.22),
          y: roundCoord(pdfHeight * 0.78)
        },
        map: {
          lon: mapCenter.lon - mapLonSpan * 0.22,
          lat: mapCenter.lat - mapLatSpan * 0.18
        },
        confidence: 0.28,
        rationale:
          'Fallback estimate (lower-left viewport placeholder — adjust on PDF and map before confirming)'
      },
      {
        pdf: {
          x: roundCoord(pdfWidth * 0.78),
          y: roundCoord(pdfHeight * 0.78)
        },
        map: {
          lon: mapCenter.lon + mapLonSpan * 0.22,
          lat: mapCenter.lat - mapLatSpan * 0.18
        },
        confidence: 0.26,
        rationale:
          'Fallback estimate (lower-right viewport placeholder — adjust on PDF and map before confirming)'
      }
    ];

    return templates.map((template) => ({
      id: nanoid(10),
      pdf: {
        ...template.pdf,
        page
      },
      map: template.map,
      confidence: template.confidence,
      rationale: template.rationale,
      provenance: 'heuristic'
    }));
  }
}

const GEMINI_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    geographic_context: {
      type: SchemaType.OBJECT,
      properties: {
        municipality: { type: SchemaType.STRING },
        county: { type: SchemaType.STRING },
        state: { type: SchemaType.STRING },
        country: { type: SchemaType.STRING },
        identified_region: { type: SchemaType.STRING },
        north_up: { type: SchemaType.BOOLEAN }
      },
      required: [
        'municipality',
        'county',
        'state',
        'country',
        'identified_region',
        'north_up'
      ]
    },
    landmarks: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          street_1: { type: SchemaType.STRING },
          street_2: { type: SchemaType.STRING },
          point_2d: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.NUMBER }
          },
          approximate_lon: { type: SchemaType.NUMBER },
          approximate_lat: { type: SchemaType.NUMBER },
          confidence: { type: SchemaType.NUMBER },
          rationale: { type: SchemaType.STRING }
        },
        required: [
          'street_1',
          'street_2',
          'point_2d',
          'approximate_lon',
          'approximate_lat',
          'confidence',
          'rationale'
        ]
      }
    }
  },
  required: ['geographic_context', 'landmarks']
};

const CROP_REFINE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    refined: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: { type: SchemaType.STRING },
          found: { type: SchemaType.BOOLEAN },
          point_2d: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.NUMBER }
          }
        },
        required: ['id', 'found', 'point_2d']
      }
    }
  },
  required: ['refined']
};

function buildLandmarkExtractionPrompt(
  request: GeorefSuggestionRequest,
  context: ExtractedPdfPageContext | null
): string {
  const filenameHint = request.sourceName ?? request.pdfFile?.name ?? '';
  const titleHint =
    context && context.titleTextCandidates.length > 0
      ? `EXTRACTED PDF HEADER/TITLE TEXT:\n${context.titleTextCandidates
          .slice(0, 20)
          .map((t) => `- "${t}"`)
          .join('\n')}\n\n`
      : '';

  const streetHints =
    context && context.streetTextItems.length > 0
      ? `EXTRACTED VECTOR STREET LABELS ON PAGE (with [y, x] in 0..1000):\n${context.streetTextItems
          .slice(0, 45)
          .map(
            (s) =>
              `- "${s.text}" near [y=${s.normY}, x=${s.normX}] (angle ${Math.round(s.angleDegrees)}°)`
          )
          .join('\n')}\n\n`
      : '';

  const lonSpan = Math.abs(request.mapBounds.east - request.mapBounds.west);
  const isLocalViewport =
    lonSpan > 0 &&
    lonSpan < 2.5 &&
    !(
      Math.abs(request.mapCenter.lon) < 0.05 &&
      Math.abs(request.mapCenter.lat) < 0.05
    );

  const viewportNote = isLocalViewport
    ? `OPTIONAL TIE-BREAKER ONLY (user's current map camera, ignore completely if the PDF names a different city/county/state): Lon ${request.mapCenter.lon.toFixed(4)}, Lat ${request.mapCenter.lat.toFixed(4)}.\n\n`
    : '';

  return (
    `You are an expert GIS cartographer georeferencing a municipal or county zoning PDF map.\n\n` +
    (filenameHint ? `PDF FILENAME: "${filenameHint}"\n\n` : '') +
    titleHint +
    streetHints +
    viewportNote +
    `STEP 1 — EXACT JURISDICTION:\n` +
    `Read the title block, municipal seal, notes, highway shields, and street names to determine the exact municipality (city/village/town/township), county, state/province, and country, plus whether the map is oriented North-up ('north_up': true/false).\n\n` +
    `STEP 2 — 6 TO 8 WIDELY SPACED ROAD INTERSECTIONS:\n` +
    `Identify 6 to 8 distinct, well-distributed 2-street intersections across all quadrants of the map area (avoid clustering in one corner, and stay inside the actual map neatline—never pick points in the legend or title block).\n` +
    `CRITICAL PRECISION RULES:\n` +
    `1. Every landmark MUST be the exact point where TWO named streets, highways, or railroads physically cross ('street_1' and 'street_2'). Include full street names and route numbers if shown (e.g., street_1: "West Springfield Avenue", street_2: "South Neil Street (US-45)").\n` +
    `2. 'point_2d' MUST be [y, x] in integer coordinates from 0 to 1000 (0,0 = top-left corner of the entire image; 1000,1000 = bottom-right corner of the entire image).\n` +
    `3. Place 'point_2d' at the EXACT geometric intersection where the two road centerlines cross—NEVER on the offset street name text label!\n` +
    `4. Provide your best real-world WGS-84 estimate in 'approximate_lon' and 'approximate_lat' (never [0, 0]). Downstream GIS software will verify and snap each (street_1, street_2) intersection against the OpenStreetMap road network.\n`
  );
}

async function resolvePageContext(
  request: GeorefSuggestionRequest
): Promise<ExtractedPdfPageContext | null> {
  if (request.extractedContext !== undefined) {
    return request.extractedContext;
  }
  if (request.pdfFile) {
    return extractPdfPageGeorefData(request.pdfFile, request.page);
  }
  return null;
}

function resolveTargetPdfDimensions(
  request: GeorefSuggestionRequest,
  context: ExtractedPdfPageContext | null
): { pdfWidth: number; pdfHeight: number } {
  const pdfWidth =
    (context?.pdfPageWidth && context.pdfPageWidth > 0
      ? context.pdfPageWidth
      : undefined) ??
    (request.pdfPageWidth && request.pdfPageWidth > 0
      ? request.pdfPageWidth
      : undefined) ??
    (request.imageWidth && request.imageWidth > 0
      ? request.imageWidth
      : undefined) ??
    DEFAULT_PDF_WIDTH_PT;

  const pdfHeight =
    (context?.pdfPageHeight && context.pdfPageHeight > 0
      ? context.pdfPageHeight
      : undefined) ??
    (request.pdfPageHeight && request.pdfPageHeight > 0
      ? request.pdfPageHeight
      : undefined) ??
    (request.imageHeight && request.imageHeight > 0
      ? request.imageHeight
      : undefined) ??
    DEFAULT_PDF_HEIGHT_PT;

  return { pdfWidth, pdfHeight };
}

function dataUrlToGenerativePart(dataUrl: string): Part | null {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return null;
  const header = dataUrl.slice(0, commaIdx);
  const base64Data = dataUrl.slice(commaIdx + 1);
  if (!base64Data) return null;
  const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
  return {
    inlineData: {
      data: base64Data,
      mimeType
    }
  };
}

function stripMarkdownCodeFence(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Creates the default georeference suggestion adapter in Proxy -> Gemini -> Heuristic order.
 */
export function createDefaultGeorefSuggestionAdapter(
  proxyUrl: string,
  geminiApiKey: string
): GeorefSuggestionAdapter {
  if (proxyUrl) {
    return new RemoteGeorefSuggestionAdapter(proxyUrl, geminiApiKey);
  }

  if (geminiApiKey) {
    return new GeminiGeorefSuggestionAdapter(geminiApiKey);
  }

  return new HeuristicGeorefSuggestionAdapter();
}

/** Default singleton georeference suggestion adapter. */
export const defaultGeorefSuggestionAdapter: GeorefSuggestionAdapter =
  createDefaultGeorefSuggestionAdapter(
    aiEnv.GEOREF_SUGGESTION_PROXY_URL,
    aiEnv.GEMINI_API_KEY
  );

/** Active source badge label for the default georeference suggestion adapter. */
export const defaultGeorefSuggestionSource: GeorefSuggestionSource =
  resolveGeorefSuggestionSource(
    aiEnv.GEOREF_SUGGESTION_PROXY_URL,
    aiEnv.GEMINI_API_KEY
  );
