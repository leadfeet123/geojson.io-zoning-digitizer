import { inflateSync, unzlibSync } from 'fflate';
import {
  selectConsistentControlPoints,
  type CandidateControlPointOption
} from 'app/lib/transform_engine';

const TARGET_HIGH_RES_LONG_EDGE_PX = 2200;
const CROP_OUTPUT_SIZE_PX = 448;
const CROP_SPAN_FRACTION = 0.14;
const MAX_OBJSTM_BYTES = 2 * 1024 * 1024;

const STREET_KEYWORD_REGEX =
  /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|cir|circle|pkwy|parkway|hwy|highway|way|ter|terrace|trl|trail|pike|turnpike|tpke|expy|expressway|fwy|freeway|route|rte|interstate|us[\s-]?\d+|i[\s-]?\d+|sr[\s-]?\d+|cr[\s-]?\d+|co\.?\s*rd)\b/i;

const TITLE_KEYWORD_REGEX =
  /\b(city|village|town|township|borough|county|parish|municipality|state|zoning|district|official|illinois|wisconsin|michigan|indiana|ohio|minnesota|iowa|missouri|california|texas|new\s+york|pennsylvania|florida|washington|oregon|colorado|massachusetts|virginia|north\s+carolina|georgia|new\s+jersey|maryland)\b/i;

/** Minimal viewport projection interface compatible with PDF.js PageViewport. */
export interface PdfViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

/** Raw PDF text fragment before glyph-run merging. */
export interface RawPdfTextFragment {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Merged vector text item positioned in unscaled PDF viewport coordinates. */
export interface ExtractedPdfTextItem {
  text: string;
  /** Unscaled PDF viewport center coordinates (scale = 1, top-left origin). */
  x: number;
  y: number;
  /** Normalized coordinates in [0, 1000]. */
  normX: number;
  normY: number;
  fontSize: number;
  angleDegrees: number;
}

/** Embedded GeoPDF ground control point extracted from ISO 32000 /VP metadata. */
export interface EmbeddedGeoPdfPoint {
  pdf: { x: number; y: number };
  map: { lon: number; lat: number };
}

/** Candidate crossing inferred purely from angled PDF street labels. */
export interface VectorStreetCrossingCandidate {
  street1: string;
  street2: string;
  pdf: { x: number; y: number };
}

/** Extracted georeferencing context for a single PDF page. */
export interface ExtractedPdfPageContext {
  page: number;
  pdfPageWidth: number;
  pdfPageHeight: number;
  highResBase64Image?: string;
  renderedWidth?: number;
  renderedHeight?: number;
  embeddedGeoPoints: EmbeddedGeoPdfPoint[];
  titleTextCandidates: string[];
  streetTextItems: ExtractedPdfTextItem[];
  allTextItems: ExtractedPdfTextItem[];
}

/** Zoomed crop around a candidate landmark on a PDF page for sub-point refinement. */
export interface PdfLandmarkCrop {
  id: string;
  cropMinX: number;
  cropMinY: number;
  cropWidth: number;
  cropHeight: number;
  base64Image: string;
}

/**
 * Extracts and merges PDF vector text items into unscaled top-left PDF coordinates.
 */
export function extractAndMergePdfTextItems(
  rawItems: ReadonlyArray<RawPdfTextFragment>,
  viewport: PdfViewportLike
): ExtractedPdfTextItem[] {
  interface PositionedRun {
    text: string;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    ux: number;
    uy: number;
    fontSize: number;
    angleDeg: number;
  }

  const runs: PositionedRun[] = [];

  for (const item of rawItems) {
    if (!item.str || (!item.str.trim() && item.str !== ' ')) continue;
    const tr = item.transform;
    if (!Array.isArray(tr) || tr.length < 6) continue;

    const [a, b, c, d, tx, ty] = tr;
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    const fontSize = Math.max(scaleX, scaleY, item.height || 0, 1);

    const [vx0, vy0] = viewport.convertToViewportPoint(tx, ty);
    const advPdfX =
      scaleX > 1e-6
        ? (a / scaleX) * Math.max(item.width, 0)
        : Math.max(item.width, 0);
    const advPdfY = scaleX > 1e-6 ? (b / scaleX) * Math.max(item.width, 0) : 0;
    const [vx1Raw, vy1Raw] = viewport.convertToViewportPoint(
      tx + advPdfX,
      ty + advPdfY
    );

    const dx = vx1Raw - vx0;
    const dy = vy1Raw - vy0;
    const segLen = Math.hypot(dx, dy);
    let ux = 1;
    let uy = 0;
    if (segLen > 1e-4) {
      ux = dx / segLen;
      uy = dy / segLen;
    } else if (scaleX > 1e-6) {
      const [dirX, dirY] = viewport.convertToViewportPoint(
        tx + a / scaleX,
        ty + b / scaleX
      );
      const dLen = Math.hypot(dirX - vx0, dirY - vy0);
      if (dLen > 1e-6) {
        ux = (dirX - vx0) / dLen;
        uy = (dirY - vy0) / dLen;
      }
    }

    const estLen = segLen > 1e-4 ? segLen : item.str.length * fontSize * 0.5;
    const endX = vx0 + ux * estLen;
    const endY = vy0 + uy * estLen;
    const angleDeg = (Math.atan2(uy, ux) * 180) / Math.PI;

    // Try merging with the previous run if colinear and adjacent
    const prev = runs.length > 0 ? runs[runs.length - 1] : null;
    if (prev) {
      const angleDiff = Math.abs(wrapDegrees(angleDeg - prev.angleDeg));
      const sizeRatio =
        Math.max(fontSize, prev.fontSize) /
        Math.max(0.1, Math.min(fontSize, prev.fontSize));
      const relX = vx0 - prev.endX;
      const relY = vy0 - prev.endY;
      const forwardGap = relX * prev.ux + relY * prev.uy;
      const perpOffset = Math.abs(-relX * prev.uy + relY * prev.ux);
      const avgFont = (fontSize + prev.fontSize) / 2;

      if (
        angleDiff <= 5 &&
        sizeRatio <= 1.35 &&
        perpOffset <= avgFont * 0.45 &&
        forwardGap >= -avgFont * 0.35 &&
        forwardGap <= avgFont * 1.8
      ) {
        const needsSpace =
          forwardGap > avgFont * 0.22 &&
          !prev.text.endsWith(' ') &&
          !prev.text.endsWith('-') &&
          !item.str.startsWith(' ');
        prev.text += (needsSpace ? ' ' : '') + item.str;
        prev.endX = endX;
        prev.endY = endY;
        prev.fontSize = Math.max(prev.fontSize, fontSize);
        continue;
      }
    }

    runs.push({
      text: item.str,
      startX: vx0,
      startY: vy0,
      endX,
      endY,
      ux,
      uy,
      fontSize,
      angleDeg
    });
  }

  const pageW = Math.max(viewport.width, 1);
  const pageH = Math.max(viewport.height, 1);

  return runs
    .map((run) => {
      const text = run.text.replace(/\s+/g, ' ').trim();
      // Shift slightly from baseline toward cap-height center
      const capShift = run.fontSize * 0.3;
      const cx = (run.startX + run.endX) / 2 + run.uy * capShift;
      const cy = (run.startY + run.endY) / 2 - run.ux * capShift;
      return {
        text,
        x: cx,
        y: cy,
        normX: Math.max(0, Math.min(1000, Math.round((cx / pageW) * 1000))),
        normY: Math.max(0, Math.min(1000, Math.round((cy / pageH) * 1000))),
        fontSize: run.fontSize,
        angleDegrees: run.angleDeg
      };
    })
    .filter((item) => item.text.length >= 2);
}

/**
 * Splits merged PDF text items into jurisdiction/title candidates and street labels.
 */
export function classifyPdfTextItems(
  items: ReadonlyArray<ExtractedPdfTextItem>
): {
  titleTextCandidates: string[];
  streetTextItems: ExtractedPdfTextItem[];
} {
  if (items.length === 0) {
    return { titleTextCandidates: [], streetTextItems: [] };
  }

  const bySizeDesc = [...items].sort((a, b) => b.fontSize - a.fontSize);
  const titleSet = new Set<string>();

  // Top largest-font strings almost always include Municipality / County / Title
  for (const item of bySizeDesc.slice(0, 18)) {
    if (item.text.length >= 3 && item.text.length <= 120) {
      titleSet.add(item.text);
    }
  }
  for (const item of bySizeDesc) {
    if (titleSet.size >= 28) break;
    if (
      item.text.length >= 4 &&
      item.text.length <= 120 &&
      TITLE_KEYWORD_REGEX.test(item.text)
    ) {
      titleSet.add(item.text);
    }
  }

  const streetTextItems = items.filter((item) => {
    if (item.text.length < 3 || item.text.length > 55) return false;
    // Exclude long sentences or pure legend descriptions
    if (
      /\b(district|residential|commercial|industrial|agricultural|single\s+family|multi\s+family|legend|scale|feet|miles|copyright|prepared\s+by|ordinance)\b/i.test(
        item.text
      )
    ) {
      return false;
    }
    return STREET_KEYWORD_REGEX.test(item.text);
  });

  return {
    titleTextCandidates: Array.from(titleSet),
    streetTextItems
  };
}

/**
 * Infers candidate street intersection positions on a vector PDF by intersecting
 * the projection axes of angled/perpendicular street name labels.
 */
export function inferVectorStreetCrossings(
  streetItems: ReadonlyArray<ExtractedPdfTextItem>,
  pdfPageWidth: number,
  pdfPageHeight: number,
  maxCandidates = 12
): VectorStreetCrossingCandidate[] {
  if (streetItems.length < 2) return [];

  // Deduplicate repeated labels along the same road axis, keeping representative labels
  const candidates: Array<VectorStreetCrossingCandidate & { score: number }> =
    [];
  const marginX = pdfPageWidth * 0.03;
  const marginY = pdfPageHeight * 0.03;
  const pageDiag = Math.hypot(pdfPageWidth, pdfPageHeight);

  for (let i = 0; i < streetItems.length; i++) {
    const a = streetItems[i];
    const radA = (a.angleDegrees * Math.PI) / 180;
    const uxA = Math.cos(radA);
    const uyA = Math.sin(radA);

    for (let j = i + 1; j < streetItems.length; j++) {
      const b = streetItems[j];
      if (a.text.toLowerCase() === b.text.toLowerCase()) continue;

      const radB = (b.angleDegrees * Math.PI) / 180;
      const uxB = Math.cos(radB);
      const uyB = Math.sin(radB);

      const sinAngle = Math.abs(uxA * uyB - uyA * uxB);
      // Require roads to cross at >= ~35° angle
      if (sinAngle < 0.57) continue;

      const denom = uxA * uyB - uyA * uxB;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = (dx * uyB - dy * uxB) / denom;
      const ix = a.x + t * uxA;
      const iy = a.y + t * uyA;

      if (
        ix < marginX ||
        ix > pdfPageWidth - marginX ||
        iy < marginY ||
        iy > pdfPageHeight - marginY
      ) {
        continue;
      }

      const distFromLabels =
        Math.hypot(ix - a.x, iy - a.y) + Math.hypot(ix - b.x, iy - b.y);
      // Prefer crossings where both street labels are reasonably close to the crossing
      if (distFromLabels > pageDiag * 1.1) continue;

      const score = sinAngle * 2 - distFromLabels / pageDiag;
      candidates.push({
        street1: a.text,
        street2: b.text,
        pdf: { x: ix, y: iy },
        score
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const unique: VectorStreetCrossingCandidate[] = [];
  const seenPairs = new Set<string>();
  for (const cand of candidates) {
    const pairKey = [cand.street1.toLowerCase(), cand.street2.toLowerCase()]
      .sort()
      .join('||');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    unique.push({
      street1: cand.street1,
      street2: cand.street2,
      pdf: cand.pdf
    });
    if (unique.length >= maxCandidates) break;
  }

  return unique;
}

/**
 * Parses ISO 32000 GeoPDF /VP viewport registration dictionaries (/BBox, /LPTS, /GPTS)
 * from raw PDF bytes and converts them to validated unscaled PDF control points.
 */
export function parseEmbeddedGeoPdfControlPoints(
  pdfBytes: Uint8Array,
  viewport: PdfViewportLike
): EmbeddedGeoPdfPoint[] {
  try {
    const objectMap = extractPdfObjects(pdfBytes);
    const fullText = Array.from(objectMap.values()).join('\n');

    const bboxCandidates = findAllNumberArraysForKey(
      fullText,
      'BBox',
      objectMap
    )
      .filter((arr) => arr.length === 4)
      .filter((arr) => {
        const w = Math.abs(arr[2] - arr[0]);
        const h = Math.abs(arr[3] - arr[1]);
        // Must represent a substantive map frame on the page (at least 25% of page width & height)
        return w >= viewport.width * 0.2 && h >= viewport.height * 0.2;
      });

    const gptsCandidates = findAllNumberArraysForKey(
      fullText,
      'GPTS',
      objectMap
    ).filter((arr) => arr.length >= 6 && arr.length % 2 === 0);

    if (gptsCandidates.length === 0 || bboxCandidates.length === 0) {
      return [];
    }

    const lptsCandidates = findAllNumberArraysForKey(
      fullText,
      'LPTS',
      objectMap
    );
    const boundsCandidates = findAllNumberArraysForKey(
      fullText,
      'Bounds',
      objectMap
    );

    // Choose largest qualifying map viewport BBox
    const bbox = bboxCandidates.sort(
      (a, b) =>
        Math.abs((b[2] - b[0]) * (b[3] - b[1])) -
        Math.abs((a[2] - a[0]) * (a[3] - a[1]))
    )[0];

    const minX = Math.min(bbox[0], bbox[2]);
    const maxX = Math.max(bbox[0], bbox[2]);
    const minY = Math.min(bbox[1], bbox[3]);
    const maxY = Math.max(bbox[1], bbox[3]);

    for (const gpts of gptsCandidates) {
      // Validate geographic [lat, lon] pairs in WGS84/NAD83 range
      const geoPairs: Array<{ lon: number; lat: number }> = [];
      let validGeo = true;
      for (let i = 0; i < gpts.length; i += 2) {
        const lat = gpts[i];
        const lon = gpts[i + 1];
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180 ||
          (lat === 0 && lon === 0)
        ) {
          validGeo = false;
          break;
        }
        geoPairs.push({ lon, lat });
      }
      if (!validGeo || geoPairs.length < 3) continue;

      const matchingLpts =
        lptsCandidates.find((arr) => arr.length === gpts.length) ??
        boundsCandidates.find((arr) => arr.length === gpts.length) ??
        (gpts.length === 8 ? [0, 0, 0, 1, 1, 1, 1, 0] : null);

      if (!matchingLpts) continue;

      // Test standard ISO bottom-left LPTS origin (invertV = false) and top-left variant (invertV = true)
      for (const invertV of [false, true]) {
        const groups: CandidateControlPointOption<EmbeddedGeoPdfPoint>[][] = [];
        for (let i = 0; i < geoPairs.length; i++) {
          const u = matchingLpts[i * 2];
          const rawV = matchingLpts[i * 2 + 1];
          if (u < -0.05 || u > 1.05 || rawV < -0.05 || rawV > 1.05) {
            continue;
          }
          const v = invertV ? 1 - rawV : rawV;
          const pdfX = minX + u * (maxX - minX);
          const pdfY = minY + v * (maxY - minY);
          const [vx, vy] = viewport.convertToViewportPoint(pdfX, pdfY);
          const entry: EmbeddedGeoPdfPoint = {
            pdf: { x: vx, y: vy },
            map: geoPairs[i]
          };
          groups.push([
            {
              pdf: entry.pdf,
              map: entry.map,
              priorConfidence: 0.99,
              metadata: entry
            }
          ]);
        }

        const consistent = selectConsistentControlPoints(groups, {
          maxPoints: 4,
          pdfSpanHint: Math.max(viewport.width, viewport.height)
        });
        if (consistent && consistent.selected.length >= 3) {
          return consistent.selected.map((s) => ({
            pdf: s.pdf,
            map: s.map
          }));
        }
      }
    }

    return [];
  } catch {
    return [];
  }
}

function extractPdfObjects(pdfBytes: Uint8Array): Map<number, string> {
  const objects = new Map<number, string>();
  const rawLatin1 = decodeLatin1(pdfBytes);

  const objRegex = /(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g;
  let match: RegExpExecArray | null;
  while ((match = objRegex.exec(rawLatin1)) !== null) {
    const objNum = Number(match[1]);
    const body = match[2];

    const streamIdx = body.indexOf('stream');
    if (streamIdx === -1) {
      objects.set(objNum, body);
      continue;
    }

    const dictPart = body.slice(0, streamIdx);
    objects.set(objNum, dictPart);

    // Decompress /ObjStm streams so modern PDF 1.5+ compressed dictionaries are visible
    if (/\/ObjStm\b/.test(dictPart) && /\/FlateDecode\b/.test(dictPart)) {
      const objStartOffset = match.index + match[0].indexOf('stream');
      const decompressed = tryInflatePdfStream(pdfBytes, objStartOffset);
      if (decompressed) {
        const text = decodeLatin1(decompressed);
        const firstMatch = dictPart.match(/\/First\s+(\d+)/);
        const firstOffset = firstMatch ? Number(firstMatch[1]) : 0;
        if (firstOffset > 0 && firstOffset < text.length) {
          const headerTokens = text
            .slice(0, firstOffset)
            .trim()
            .split(/\s+/)
            .map(Number);
          const content = text.slice(firstOffset);
          for (let i = 0; i + 1 < headerTokens.length; i += 2) {
            const subObjNum = headerTokens[i];
            const subOffset = headerTokens[i + 1];
            const nextOffset =
              i + 3 < headerTokens.length
                ? headerTokens[i + 3]
                : content.length;
            if (
              Number.isFinite(subObjNum) &&
              Number.isFinite(subOffset) &&
              subOffset >= 0 &&
              subOffset < content.length
            ) {
              objects.set(subObjNum, content.slice(subOffset, nextOffset));
            }
          }
        } else {
          objects.set(-objNum - 1, text);
        }
      }
    }
  }

  return objects;
}

function tryInflatePdfStream(
  pdfBytes: Uint8Array,
  streamKeywordOffset: number
): Uint8Array | null {
  let start = streamKeywordOffset + 6; // after 'stream'
  if (pdfBytes[start] === 0x0d && pdfBytes[start + 1] === 0x0a) {
    start += 2;
  } else if (pdfBytes[start] === 0x0a || pdfBytes[start] === 0x0d) {
    start += 1;
  }

  // Locate 'endstream' within MAX_OBJSTM_BYTES
  const searchEnd = Math.min(pdfBytes.length - 9, start + MAX_OBJSTM_BYTES);
  let end = -1;
  for (let i = start; i <= searchEnd; i++) {
    if (
      pdfBytes[i] === 0x65 && // 'e'
      pdfBytes[i + 1] === 0x6e && // 'n'
      pdfBytes[i + 2] === 0x64 && // 'd'
      pdfBytes[i + 3] === 0x73 && // 's'
      pdfBytes[i + 4] === 0x74 && // 't'
      pdfBytes[i + 5] === 0x72 && // 'r'
      pdfBytes[i + 6] === 0x65 && // 'e'
      pdfBytes[i + 7] === 0x61 && // 'a'
      pdfBytes[i + 8] === 0x6d // 'm'
    ) {
      end = i;
      break;
    }
  }
  if (end <= start) return null;

  // Trim trailing CR/LF before endstream
  while (
    end > start &&
    (pdfBytes[end - 1] === 0x0a || pdfBytes[end - 1] === 0x0d)
  ) {
    end--;
  }

  const slice = pdfBytes.subarray(start, end);
  try {
    return unzlibSync(slice);
  } catch {
    try {
      return inflateSync(slice);
    } catch {
      return null;
    }
  }
}

function findAllNumberArraysForKey(
  text: string,
  key: string,
  objectMap: Map<number, string>
): number[][] {
  const results: number[][] = [];
  const directRegex = new RegExp(`\\/${key}\\s*\\[([^\\]]+)\\]`, 'g');
  let m: RegExpExecArray | null;
  while ((m = directRegex.exec(text)) !== null) {
    const nums = parsePdfNumberList(m[1]);
    if (nums.length > 0) results.push(nums);
  }

  const refRegex = new RegExp(`\\/${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`, 'g');
  while ((m = refRegex.exec(text)) !== null) {
    const target = objectMap.get(Number(m[1]));
    if (target) {
      const bracketMatch = target.match(/\[([^\]]+)\]/);
      if (bracketMatch) {
        const nums = parsePdfNumberList(bracketMatch[1]);
        if (nums.length > 0) results.push(nums);
      }
    }
  }

  return results;
}

function parsePdfNumberList(raw: string): number[] {
  const matches = raw.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (!matches) return [];
  return matches.map(Number).filter((n) => Number.isFinite(n));
}

function decodeLatin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    parts.push(String.fromCharCode(...sub));
  }
  return parts.join('');
}

function wrapDegrees(angle: number): number {
  let wrapped = ((((angle + 180) % 360) + 360) % 360) - 180;
  if (wrapped === -180) wrapped = 180;
  return wrapped;
}

/**
 * Extracts high-resolution image data, vector text labels, and embedded GeoPDF
 * registration points for a specific page of a PDF file.
 */
export async function extractPdfPageGeorefData(
  file: File,
  pageNumber: number
): Promise<ExtractedPdfPageContext | null> {
  try {
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
    }

    const buffer = await file.arrayBuffer();
    const pdfBytes = new Uint8Array(buffer);
    const loadingTask = pdfjs.getDocument({ data: pdfBytes.slice() });
    const doc = await loadingTask.promise;

    try {
      const clampedPage = Math.min(Math.max(1, pageNumber), doc.numPages);
      const pdfPage = await doc.getPage(clampedPage);
      const unscaledViewport = pdfPage.getViewport({ scale: 1 });

      const embeddedGeoPoints =
        doc.numPages === 1 || clampedPage === 1
          ? parseEmbeddedGeoPdfControlPoints(pdfBytes, unscaledViewport)
          : [];

      const textContent = await pdfPage.getTextContent();
      const rawFragments: RawPdfTextFragment[] = [];
      for (const item of textContent.items) {
        if ('str' in item) {
          rawFragments.push({
            str: item.str,
            transform: item.transform,
            width: item.width,
            height: item.height
          });
        }
      }

      const allTextItems = extractAndMergePdfTextItems(
        rawFragments,
        unscaledViewport
      );
      const { titleTextCandidates, streetTextItems } =
        classifyPdfTextItems(allTextItems);

      let highResBase64Image: string | undefined;
      let renderedWidth: number | undefined;
      let renderedHeight: number | undefined;

      if (typeof document !== 'undefined') {
        const maxDim = Math.max(
          unscaledViewport.width,
          unscaledViewport.height,
          1
        );
        const renderScale = Math.min(
          3.0,
          Math.max(1.25, TARGET_HIGH_RES_LONG_EDGE_PX / maxDim)
        );
        const renderViewport = pdfPage.getViewport({ scale: renderScale });
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.ceil(renderViewport.width);
        offscreen.height = Math.ceil(renderViewport.height);
        const ctx = offscreen.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, offscreen.width, offscreen.height);
          await pdfPage.render({
            canvas: offscreen,
            canvasContext: ctx,
            viewport: renderViewport
          }).promise;
          highResBase64Image = offscreen.toDataURL('image/jpeg', 0.88);
          renderedWidth = offscreen.width;
          renderedHeight = offscreen.height;
        }
      }

      return {
        page: clampedPage,
        pdfPageWidth: unscaledViewport.width,
        pdfPageHeight: unscaledViewport.height,
        highResBase64Image,
        renderedWidth,
        renderedHeight,
        embeddedGeoPoints,
        titleTextCandidates,
        streetTextItems,
        allTextItems
      };
    } finally {
      await loadingTask.destroy();
    }
  } catch {
    return null;
  }
}

/**
 * Renders high-DPI zoomed crops around candidate unscaled PDF points so a vision
 * model can pinpoint the exact street centerline intersection rather than a label.
 */
export async function renderPdfLandmarkCrops(
  file: File,
  pageNumber: number,
  targets: ReadonlyArray<{ id: string; x: number; y: number }>
): Promise<PdfLandmarkCrop[]> {
  if (targets.length === 0 || typeof document === 'undefined') {
    return [];
  }

  try {
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjs.getDocument({ data });
    const doc = await loadingTask.promise;

    try {
      const clampedPage = Math.min(Math.max(1, pageNumber), doc.numPages);
      const pdfPage = await doc.getPage(clampedPage);
      const unscaled = pdfPage.getViewport({ scale: 1 });

      const cropSpanPdf =
        Math.max(unscaled.width, unscaled.height) * CROP_SPAN_FRACTION;
      const scale = Math.min(
        6,
        Math.max(1.5, CROP_OUTPUT_SIZE_PX / Math.max(cropSpanPdf, 1))
      );
      const scaledViewport = pdfPage.getViewport({ scale });

      // Render page once at crop DPI (or capped at 3600px max dimension for memory safety)
      const maxCanvasDim = Math.max(
        scaledViewport.width,
        scaledViewport.height
      );
      const safeScale =
        maxCanvasDim > 3600 ? scale * (3600 / maxCanvasDim) : scale;
      const finalViewport = pdfPage.getViewport({ scale: safeScale });

      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = Math.ceil(finalViewport.width);
      fullCanvas.height = Math.ceil(finalViewport.height);
      const fullCtx = fullCanvas.getContext('2d');
      if (!fullCtx) return [];

      fullCtx.fillStyle = '#ffffff';
      fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);
      await pdfPage.render({
        canvas: fullCanvas,
        canvasContext: fullCtx,
        viewport: finalViewport
      }).promise;

      const crops: PdfLandmarkCrop[] = [];
      for (const target of targets) {
        const halfSpan = cropSpanPdf / 2;
        const cropMinX = Math.max(
          0,
          Math.min(unscaled.width - cropSpanPdf, target.x - halfSpan)
        );
        const cropMinY = Math.max(
          0,
          Math.min(unscaled.height - cropSpanPdf, target.y - halfSpan)
        );
        const cropWidth = Math.min(cropSpanPdf, unscaled.width - cropMinX);
        const cropHeight = Math.min(cropSpanPdf, unscaled.height - cropMinY);
        if (cropWidth <= 1 || cropHeight <= 1) continue;

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = CROP_OUTPUT_SIZE_PX;
        cropCanvas.height = CROP_OUTPUT_SIZE_PX;
        const cropCtx = cropCanvas.getContext('2d');
        if (!cropCtx) continue;

        cropCtx.fillStyle = '#ffffff';
        cropCtx.fillRect(0, 0, CROP_OUTPUT_SIZE_PX, CROP_OUTPUT_SIZE_PX);
        cropCtx.drawImage(
          fullCanvas,
          cropMinX * safeScale,
          cropMinY * safeScale,
          cropWidth * safeScale,
          cropHeight * safeScale,
          0,
          0,
          CROP_OUTPUT_SIZE_PX,
          CROP_OUTPUT_SIZE_PX
        );

        crops.push({
          id: target.id,
          cropMinX,
          cropMinY,
          cropWidth,
          cropHeight,
          base64Image: cropCanvas.toDataURL('image/jpeg', 0.9)
        });
      }

      return crops;
    } finally {
      await loadingTask.destroy();
    }
  } catch {
    return [];
  }
}
