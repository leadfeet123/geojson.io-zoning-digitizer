import {
  calibrateLegendSwatches,
  ciede2000,
  createLegendColorLut,
  parseCssOrHexColor,
  rgbToHex,
  rgbToLab
} from 'app/lib/color_calibration';
import { describe, expect, it } from 'vitest';

describe('color_calibration', () => {
  it('parses hex and CSS rgb strings and converts back to hex', () => {
    expect(parseCssOrHexColor('#f4a460')).toEqual({ r: 244, g: 164, b: 96 });
    expect(parseCssOrHexColor('#abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseCssOrHexColor('rgb(12, 34, 56)')).toEqual({
      r: 12,
      g: 34,
      b: 56
    });
    expect(rgbToHex({ r: 244, g: 164, b: 96 })).toBe('#f4a460');
  });

  it('computes accurate CIEDE2000 distances including across red 0/360 hue wrap-around', () => {
    // Classic Sharma-Wu-Dalal (2005) test pair #1:
    // (50.0000, 2.6772, -79.7751) vs (50.0000, 0.0000, -82.7485) => 2.0425
    const d1 = ciede2000(
      { l: 50.0, a: 2.6772, b: -79.7751 },
      { l: 50.0, a: 0.0, b: -82.7485 }
    );
    expect(d1).toBeCloseTo(2.0425, 3);

    // Red slightly above 0 deg (#ff1408) vs slightly below 360 deg (#ff0820)
    const warmRed = rgbToLab({ r: 255, g: 20, b: 8 });
    const coolRed = rgbToLab({ r: 255, g: 8, b: 32 });
    expect(ciede2000(warmRed, coolRed)).toBeLessThan(8);
  });

  it('calibrates LLM-guessed hex codes to exact swatch pixels via swatch_box and patch discovery', () => {
    const width = 100;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4).fill(255); // white paper

    // Paint swatch 1 at y:[10..30], x:[10..30] with exact pastel yellow #f7eeb5 (247, 238, 181)
    // and black border at outer 1px
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) {
        const idx = (y * width + x) * 4;
        const isBorder = y === 10 || y === 29 || x === 10 || x === 29;
        data[idx] = isBorder ? 0 : 247;
        data[idx + 1] = isBorder ? 0 : 238;
        data[idx + 2] = isBorder ? 0 : 181;
        data[idx + 3] = 255;
      }
    }

    // Paint swatch 2 at y:[50..75], x:[10..35] with exact rose-red #d84356 (216, 67, 86), no swatch_box
    for (let y = 50; y < 75; y++) {
      for (let x = 10; x < 35; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 216;
        data[idx + 1] = 67;
        data[idx + 2] = 86;
        data[idx + 3] = 255;
      }
    }

    const uncalibrated = {
      boundary_line: '#000000',
      zones: [
        {
          code: 'R-1',
          description: 'Single Family',
          color: '#ffffcc', // imprecise LLM guess
          swatch_box: [100, 100, 300, 300] as [number, number, number, number]
        },
        {
          code: 'C-2',
          description: 'General Commercial',
          color: '#cc3344' // imprecise LLM guess without swatch_box
        }
      ]
    };

    const calibrated = calibrateLegendSwatches(
      { width, height, data },
      uncalibrated
    );

    expect(calibrated.zones[0].color).toBe('#f7eeb5');
    expect(calibrated.zones[1].color).toBe('#d84356');
  });

  it('classifies pastel, red-wrapped, and ink/paper pixels accurately via LUT', () => {
    const lut = createLegendColorLut(
      [
        { code: 'R-1', description: 'Residential', color: '#f7eeb5' },
        { code: 'C-1', description: 'Commercial', color: '#ff0a1e' },
        { code: 'M-1', description: 'Industrial', color: '#b8c4cc' }
      ],
      '#000000'
    );

    // Slight anti-aliased shift of #ff0a1e across hue wrap (#fc1205) still matches C-1
    const redMatch = lut.classifyPixel(252, 18, 5);
    expect(redMatch.zoneIndex).toBe(1);
    expect(redMatch.confidence).toBeGreaterThan(0.5);

    // Pastel yellow matches R-1 and not blank white paper
    const pastelMatch = lut.classifyPixel(246, 237, 182);
    expect(pastelMatch.zoneIndex).toBe(0);

    // Black text / parcel border is flagged as dark ink, not Industrial gray
    const inkCheck = lut.classifyPixel(15, 15, 15);
    expect(inkCheck.isDarkInk).toBe(true);
    expect(inkCheck.zoneIndex).toBe(-1);

    // Pure white paper background returns -1
    const paperCheck = lut.classifyPixel(255, 255, 255);
    expect(paperCheck.zoneIndex).toBe(-1);
  });
});
