// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cv = vi.hoisted(() => {
  class Mat {
    delete() {}
  }
  return {
    Mat,
    imread: vi.fn(() => new Mat()),
    cvtColor: vi.fn(),
    COLOR_RGBA2RGB: 1,
    COLOR_RGB2HSV: 2
  };
});

vi.mock('@techstark/opencv-js', () => ({
  default: Promise.resolve(cv)
}));

describe('OpenCV initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits asynchronous OpenCV initialization before extracting shapes', async () => {
    const { OpenCvExtractionEngine } =
      await import('./spatial_extraction_engine');
    const result = await new OpenCvExtractionEngine().extractShapes(
      document.createElement('canvas'),
      []
    );
    expect(result).toEqual([]);
    expect(cv.imread).toHaveBeenCalledOnce();
  });
});
