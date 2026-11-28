import type { LegendItem, LegendResult } from 'app/lib/ocr_adapter';

/** 8-bit sRGB color tuple with channels in [0, 255]. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** CIE L*a*b* color under D65 standard illuminant. */
export interface LabColor {
  l: number;
  a: number;
  b: number;
}

/** Minimal RGBA pixel buffer compatible with browser ImageData. */
export interface RgbaImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Result of matching an RGB color against calibrated zoning legend swatches. */
export interface LegendColorMatch {
  zoneIndex: number;
  deltaE: number;
  secondBestDeltaE: number;
  confidence: number;
}

/** Precomputed 64x64x64 CIEDE2000 lookup table and exact matcher for legend colors. */
export interface LegendColorLut {
  readonly zoneCount: number;
  /** Fast 6-bit-per-channel LUT classification for multi-megapixel raster scans. */
  classifyPixel(
    r: number,
    g: number,
    b: number
  ): {
    zoneIndex: number;
    confidence: number;
    isDarkInk: boolean;
  };
  /** Exact floating-point CIEDE2000 match for vector PDF fill colors. */
  classifyExact(rgb: RgbColor): LegendColorMatch | null;
}

const DEFAULT_MAX_DELTA_E = 21;
const LUT_BITS = 6;
const LUT_SIDE = 1 << LUT_BITS; // 64
const LUT_SIZE = LUT_SIDE * LUT_SIDE * LUT_SIDE; // 262,144
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const POW_25_7 = Math.pow(25, 7);

/**
 * Parses a hex (#RGB, #RRGGBB) or CSS rgb()/rgba() string into 8-bit sRGB.
 */
export function parseCssOrHexColor(input: string): RgbColor | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();

  const hex6 = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(trimmed);
  if (hex6) {
    return {
      r: parseInt(hex6[1], 16),
      g: parseInt(hex6[2], 16),
      b: parseInt(hex6[3], 16)
    };
  }

  const hex3 = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(trimmed);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16)
    };
  }

  const rgbMatch =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(
      trimmed
    );
  if (rgbMatch) {
    return {
      r: clampByte(Number(rgbMatch[1])),
      g: clampByte(Number(rgbMatch[2])),
      b: clampByte(Number(rgbMatch[3]))
    };
  }

  return null;
}

/**
 * Formats an 8-bit sRGB color as a lowercase #rrggbb hex string.
 */
export function rgbToHex(rgb: RgbColor): string {
  const to2 = (v: number) => clampByte(v).toString(16).padStart(2, '0');
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`;
}

/**
 * Converts an 8-bit sRGB color into CIE L*a*b* (D65 reference white).
 */
export function rgbToLab(rgb: RgbColor): LabColor {
  const rl = srgbChannelToLinear(rgb.r / 255);
  const gl = srgbChannelToLinear(rgb.g / 255);
  const bl = srgbChannelToLinear(rgb.b / 255);

  // sRGB -> XYZ (D65), normalized by D65 white (Xn=0.95047, Yn=1.0, Zn=1.08883)
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;

  const fx = labForwardTransform(x);
  const fy = labForwardTransform(y);
  const fz = labForwardTransform(z);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

/**
 * Computes the perceptual CIEDE2000 (Delta E 2000) color difference between two CIE L*a*b* colors.
 */
export function ciede2000(lab1: LabColor, lab2: LabColor): number {
  const l1 = lab1.l;
  const a1 = lab1.a;
  const b1 = lab1.b;
  const l2 = lab2.l;
  const a2 = lab2.a;
  const b2 = lab2.b;

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const meanC = (c1 + c2) / 2;
  const meanC7 = Math.pow(meanC, 7);
  const g = 0.5 * (1 - Math.sqrt(meanC7 / (meanC7 + POW_25_7)));

  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);

  const h1Prime = computeHuePrimeDegrees(a1Prime, b1, c1Prime);
  const h2Prime = computeHuePrimeDegrees(a2Prime, b2, c2Prime);

  const deltaLPrime = l2 - l1;
  const deltaCPrime = c2Prime - c1Prime;

  let deltahPrime = 0;
  if (c1Prime * c2Prime !== 0) {
    const diff = h2Prime - h1Prime;
    if (Math.abs(diff) <= 180) {
      deltahPrime = diff;
    } else if (diff > 180) {
      deltahPrime = diff - 360;
    } else {
      deltahPrime = diff + 360;
    }
  }

  const deltaHPrime =
    2 * Math.sqrt(c1Prime * c2Prime) * Math.sin((deltahPrime * DEG_TO_RAD) / 2);

  const meanLPrime = (l1 + l2) / 2;
  const meanCPrime = (c1Prime + c2Prime) / 2;

  let meanhPrime = h1Prime + h2Prime;
  if (c1Prime * c2Prime !== 0) {
    if (Math.abs(h1Prime - h2Prime) <= 180) {
      meanhPrime = (h1Prime + h2Prime) / 2;
    } else if (h1Prime + h2Prime < 360) {
      meanhPrime = (h1Prime + h2Prime + 360) / 2;
    } else {
      meanhPrime = (h1Prime + h2Prime - 360) / 2;
    }
  }

  const t =
    1 -
    0.17 * Math.cos((meanhPrime - 30) * DEG_TO_RAD) +
    0.24 * Math.cos(2 * meanhPrime * DEG_TO_RAD) +
    0.32 * Math.cos((3 * meanhPrime + 6) * DEG_TO_RAD) -
    0.2 * Math.cos((4 * meanhPrime - 63) * DEG_TO_RAD);

  const deltaTheta = 30 * Math.exp(-Math.pow((meanhPrime - 275) / 25, 2));
  const meanCPrime7 = Math.pow(meanCPrime, 7);
  const rc = 2 * Math.sqrt(meanCPrime7 / (meanCPrime7 + POW_25_7));

  const lDiffSq = Math.pow(meanLPrime - 50, 2);
  const sl = 1 + (0.015 * lDiffSq) / Math.sqrt(20 + lDiffSq);
  const sc = 1 + 0.045 * meanCPrime;
  const sh = 1 + 0.015 * meanCPrime * t;
  const rt = -Math.sin(2 * deltaTheta * DEG_TO_RAD) * rc;

  const termL = deltaLPrime / sl;
  const termC = deltaCPrime / sc;
  const termH = deltaHPrime / sh;

  return Math.sqrt(
    Math.max(
      0,
      termL * termL + termC * termC + termH * termH + rt * termC * termH
    )
  );
}

/**
 * Calibrates legend zone hex colors directly from the rendered legend crop pixels
 * so downstream matching uses actual PDF swatch RGB values rather than LLM hex guesses.
 */
export function calibrateLegendSwatches(
  imageData: RgbaImageLike,
  legend: LegendResult
): LegendResult {
  if (
    !imageData ||
    imageData.width <= 0 ||
    imageData.height <= 0 ||
    imageData.data.length < imageData.width * imageData.height * 4 ||
    legend.zones.length === 0
  ) {
    return legend;
  }

  const discoveredPatches = discoverUniformColorPatches(imageData);
  const usedPatchIndices = new Set<number>();

  const calibratedZones: LegendItem[] = legend.zones.map((zone) => {
    const fallbackRgb = parseCssOrHexColor(zone.color);
    const fallbackLab = fallbackRgb ? rgbToLab(fallbackRgb) : null;

    if (zone.swatch_box && zone.swatch_box.length === 4) {
      const boxSampled = sampleSwatchBoxMedoid(imageData, zone.swatch_box);
      if (boxSampled) {
        return {
          ...zone,
          color: rgbToHex(boxSampled)
        };
      }
    }

    if (fallbackLab && discoveredPatches.length > 0) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < discoveredPatches.length; i++) {
        if (usedPatchIndices.has(i)) continue;
        const dist = ciede2000(fallbackLab, discoveredPatches[i].lab);
        if (dist < bestDist && dist <= 24) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        usedPatchIndices.add(bestIdx);
        return {
          ...zone,
          color: rgbToHex(discoveredPatches[bestIdx].rgb)
        };
      }
    }

    return fallbackRgb ? { ...zone, color: rgbToHex(fallbackRgb) } : zone;
  });

  return {
    ...legend,
    zones: calibratedZones
  };
}

/**
 * Builds a precomputed 64x64x64 RGB -> Legend Zone CIEDE2000 classifier LUT
 * and exact perceptual matcher for both raster and vector PDF extraction.
 */
export function createLegendColorLut(
  zones: ReadonlyArray<LegendItem>,
  boundaryHex?: string | null,
  maxDeltaE = DEFAULT_MAX_DELTA_E
): LegendColorLut {
  const parsedZones = zones.map((zone) => {
    const rgb = parseCssOrHexColor(zone.color) ?? { r: 0, g: 0, b: 0 };
    const lab = rgbToLab(rgb);
    const chroma = Math.hypot(lab.a, lab.b);
    return {
      rgb,
      lab,
      chroma,
      isVeryDark: lab.l < 24 && chroma < 12,
      isNearWhite: lab.l > 96.5 && chroma < 3.5
    };
  });

  const boundaryRgb = boundaryHex ? parseCssOrHexColor(boundaryHex) : null;
  const boundaryLab = boundaryRgb ? rgbToLab(boundaryRgb) : null;
  const hasDarkZone = parsedZones.some((z) => z.isVeryDark);
  const hasWhiteZone = parsedZones.some((z) => z.isNearWhite);

  const classifyExactWithInk = (
    rgb: RgbColor
  ): { match: LegendColorMatch | null; isDarkInk: boolean } => {
    const lab = rgbToLab(rgb);
    const chroma = Math.hypot(lab.a, lab.b);

    let bestIndex = -1;
    let bestDeltaE = Infinity;
    let secondBestDeltaE = Infinity;

    for (let i = 0; i < parsedZones.length; i++) {
      const de = ciede2000(lab, parsedZones[i].lab);
      if (de < bestDeltaE) {
        secondBestDeltaE = bestDeltaE;
        bestDeltaE = de;
        bestIndex = i;
      } else if (de < secondBestDeltaE) {
        secondBestDeltaE = de;
      }
    }

    const isDarkInk =
      !hasDarkZone &&
      ((lab.l < 25 && chroma < 14 && bestDeltaE > 8) ||
        (boundaryLab !== null &&
          boundaryLab.l < 45 &&
          ciede2000(lab, boundaryLab) < 10 &&
          bestDeltaE > 8));

    if (isDarkInk) {
      return { match: null, isDarkInk: true };
    }

    const isBlankPaper =
      !hasWhiteZone && lab.l > 97 && chroma < 3 && bestDeltaE > 4.5;
    if (isBlankPaper || bestIndex < 0 || bestDeltaE > maxDeltaE) {
      return { match: null, isDarkInk: false };
    }

    const distScore = Math.max(0, Math.min(1, 1 - bestDeltaE / maxDeltaE));
    const marginScore = Number.isFinite(secondBestDeltaE)
      ? Math.max(
          0.15,
          Math.min(
            1,
            (secondBestDeltaE - bestDeltaE) / Math.max(6, bestDeltaE + 4)
          )
        )
      : 1;
    const confidence = Math.max(
      0.1,
      Math.min(0.99, 0.55 * distScore + 0.45 * marginScore)
    );

    return {
      match: {
        zoneIndex: bestIndex,
        deltaE: bestDeltaE,
        secondBestDeltaE,
        confidence
      },
      isDarkInk: false
    };
  };

  // -2 denotes uncomputed cell; -1 denotes non-zone (ink/paper/out-of-tolerance); >= 0 denotes zoneIndex
  const zoneIndices = new Int16Array(LUT_SIZE).fill(-2);
  const confidences = new Uint8Array(LUT_SIZE);
  const inkFlags = new Uint8Array(LUT_SIZE);

  return {
    zoneCount: parsedZones.length,
    classifyPixel(r: number, g: number, b: number) {
      const qr = clampByte(r) >> 2;
      const qg = clampByte(g) >> 2;
      const qb = clampByte(b) >> 2;
      const idx = (qr << 12) | (qg << 6) | qb;

      if (zoneIndices[idx] === -2) {
        const sampleRgb = {
          r: Math.min(255, qr * 4 + 2),
          g: Math.min(255, qg * 4 + 2),
          b: Math.min(255, qb * 4 + 2)
        };
        if (parsedZones.length === 0) {
          const lab = rgbToLab(sampleRgb);
          zoneIndices[idx] = -1;
          inkFlags[idx] = lab.l < 25 && Math.hypot(lab.a, lab.b) < 14 ? 1 : 0;
        } else {
          const { match, isDarkInk } = classifyExactWithInk(sampleRgb);
          if (isDarkInk) {
            zoneIndices[idx] = -1;
            inkFlags[idx] = 1;
          } else if (match) {
            zoneIndices[idx] = match.zoneIndex;
            confidences[idx] = Math.round(match.confidence * 255);
          } else {
            zoneIndices[idx] = -1;
          }
        }
      }

      return {
        zoneIndex: zoneIndices[idx],
        confidence: confidences[idx] / 255,
        isDarkInk: inkFlags[idx] === 1
      };
    },
    classifyExact(rgb: RgbColor): LegendColorMatch | null {
      return classifyExactWithInk(rgb).match;
    }
  };
}

function sampleSwatchBoxMedoid(
  imageData: RgbaImageLike,
  swatchBox: [number, number, number, number]
): RgbColor | null {
  const [rawYMin, rawXMin, rawYMax, rawXMax] = swatchBox;
  if (
    !Number.isFinite(rawYMin) ||
    !Number.isFinite(rawXMin) ||
    !Number.isFinite(rawYMax) ||
    !Number.isFinite(rawXMax)
  ) {
    return null;
  }

  const y0 = Math.max(0, Math.min(1000, Math.min(rawYMin, rawYMax)));
  const y1 = Math.max(0, Math.min(1000, Math.max(rawYMin, rawYMax)));
  const x0 = Math.max(0, Math.min(1000, Math.min(rawXMin, rawXMax)));
  const x1 = Math.max(0, Math.min(1000, Math.max(rawXMin, rawXMax)));

  const boxW = ((x1 - x0) / 1000) * imageData.width;
  const boxH = ((y1 - y0) / 1000) * imageData.height;
  if (boxW < 2 || boxH < 2) return null;

  // Inset by 20% to avoid black outline borders around legend swatches
  const insetX = boxW * 0.2;
  const insetY = boxH * 0.2;
  const pxStart = Math.max(
    0,
    Math.floor((x0 / 1000) * imageData.width + insetX)
  );
  const pxEnd = Math.min(
    imageData.width - 1,
    Math.ceil((x1 / 1000) * imageData.width - insetX)
  );
  const pyStart = Math.max(
    0,
    Math.floor((y0 / 1000) * imageData.height + insetY)
  );
  const pyEnd = Math.min(
    imageData.height - 1,
    Math.ceil((y1 / 1000) * imageData.height - insetY)
  );

  if (pxEnd < pxStart || pyEnd < pyStart) return null;

  const nonInkSamples: RgbColor[] = [];
  const colorfulSamples: RgbColor[] = [];
  const strideX = Math.max(1, Math.floor((pxEnd - pxStart + 1) / 16));
  const strideY = Math.max(1, Math.floor((pyEnd - pyStart + 1) / 16));

  for (let y = pyStart; y <= pyEnd; y += strideY) {
    for (let x = pxStart; x <= pxEnd; x += strideX) {
      const offset = (y * imageData.width + x) * 4;
      const a = imageData.data[offset + 3];
      if (a < 128) continue;
      const rgb = {
        r: imageData.data[offset],
        g: imageData.data[offset + 1],
        b: imageData.data[offset + 2]
      };
      const lab = rgbToLab(rgb);
      const chroma = Math.hypot(lab.a, lab.b);
      if (lab.l < 20 && chroma < 10) continue; // border/text ink
      nonInkSamples.push(rgb);
      if (!(lab.l > 97 && chroma < 2.5)) {
        colorfulSamples.push(rgb);
      }
    }
  }

  const pool = colorfulSamples.length >= 3 ? colorfulSamples : nonInkSamples;
  if (pool.length === 0) return null;

  // Component median + medoid snap gives exact rendered pixel color immune to outliers
  const sortedR = pool.map((p) => p.r).sort((a, b) => a - b);
  const sortedG = pool.map((p) => p.g).sort((a, b) => a - b);
  const sortedB = pool.map((p) => p.b).sort((a, b) => a - b);
  const mid = Math.floor(pool.length / 2);
  const medianLab = rgbToLab({
    r: sortedR[mid],
    g: sortedG[mid],
    b: sortedB[mid]
  });

  let bestPixel = pool[0];
  let bestDist = Infinity;
  for (const candidate of pool) {
    const d = ciede2000(medianLab, rgbToLab(candidate));
    if (d < bestDist) {
      bestDist = d;
      bestPixel = candidate;
    }
  }

  return bestPixel;
}

function discoverUniformColorPatches(
  imageData: RgbaImageLike
): { rgb: RgbColor; lab: LabColor; count: number }[] {
  const bins = new Map<
    number,
    { sumR: number; sumG: number; sumB: number; count: number }
  >();
  const stride = Math.max(
    1,
    Math.floor(Math.min(imageData.width, imageData.height) / 250)
  );

  for (let y = 0; y < imageData.height; y += stride) {
    for (let x = 0; x < imageData.width; x += stride) {
      const idx = (y * imageData.width + x) * 4;
      if (imageData.data[idx + 3] < 128) continue;
      const r = imageData.data[idx];
      const g = imageData.data[idx + 1];
      const b = imageData.data[idx + 2];

      const lab = rgbToLab({ r, g, b });
      const chroma = Math.hypot(lab.a, lab.b);
      if ((lab.l < 22 && chroma < 12) || (lab.l > 97 && chroma < 3)) {
        continue;
      }

      // Quantize to 5 bits/channel (8-level bins) to group flat swatch pixels
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const entry = bins.get(key);
      if (entry) {
        entry.sumR += r;
        entry.sumG += g;
        entry.sumB += b;
        entry.count++;
      } else {
        bins.set(key, { sumR: r, sumG: g, sumB: b, count: 1 });
      }
    }
  }

  const minCount = Math.max(
    6,
    Math.floor(
      (imageData.width / stride) * (imageData.height / stride) * 0.0015
    )
  );

  return Array.from(bins.values())
    .filter((b) => b.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, 48)
    .map((b) => {
      const rgb = {
        r: Math.round(b.sumR / b.count),
        g: Math.round(b.sumG / b.count),
        b: Math.round(b.sumB / b.count)
      };
      return { rgb, lab: rgbToLab(rgb), count: b.count };
    });
}

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labForwardTransform(t: number): number {
  const delta = 6 / 29;
  const delta3 = delta * delta * delta;
  return t > delta3 ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

function computeHuePrimeDegrees(
  aPrime: number,
  b: number,
  cPrime: number
): number {
  if (cPrime === 0) return 0;
  const angle = Math.atan2(b, aPrime) * RAD_TO_DEG;
  return angle < 0 ? angle + 360 : angle;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}
