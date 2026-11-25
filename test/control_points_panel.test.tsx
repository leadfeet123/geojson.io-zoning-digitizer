// @vitest-environment jsdom

import { ControlPointsPanel } from 'app/components/control_points/ControlPointsPanel';
import { MapContext } from 'app/context/map_context';
import { defaultGeorefSuggestionAdapter } from 'app/lib/georef_suggestion_adapter';
import type PMap from 'app/lib/pmap';
import { createStore, Provider } from 'jotai';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { controlPointsAtom } from 'state/control_points';
import { activePdfPageAtom } from 'state/digitizer';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ControlPointsPanel georef suggestions', () => {
  let container: HTMLDivElement;
  let pdfCanvas: HTMLCanvasElement;

  afterEach(() => {
    vi.restoreAllMocks();
    container?.remove();
    pdfCanvas?.remove();
  });

  it('preserves unscaled PDF coordinates regardless of zoomed canvas scale and auto-frames map on grounded suggestions', async () => {
    const store = createStore();
    store.set(activePdfPageAtom, 1);

    // Simulate a PDF page (792x612 pt) zoomed to 2.5x on screen (1980x1530 px)
    pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = 1980;
    pdfCanvas.height = 1530;
    pdfCanvas.dataset.pdfPage = '1';
    pdfCanvas.dataset.pdfScale = '2.5';
    pdfCanvas.dataset.pdfPageWidth = '792';
    pdfCanvas.dataset.pdfPageHeight = '612';
    vi.spyOn(pdfCanvas, 'toDataURL').mockReturnValue(
      'data:image/png;base64,AAAA'
    );
    document.body.appendChild(pdfCanvas);

    const fitBoundsMock = vi.fn();
    const fakeMap = {
      getCenter: () => ({ lng: -74.006, lat: 40.7128 }),
      getBounds: () => ({
        getWest: () => -74.1,
        getSouth: () => 40.6,
        getEast: () => -73.9,
        getNorth: () => 40.8
      }),
      getZoom: () => 10,
      fitBounds: fitBoundsMock,
      flyTo: vi.fn(),
      getCanvas: () => document.createElement('canvas'),
      once: vi.fn(),
      off: vi.fn()
    };

    const suggestSpy = vi
      .spyOn(defaultGeorefSuggestionAdapter, 'suggestPoints')
      .mockResolvedValue([
        {
          id: 'sug-1',
          pdf: { x: 158.4, y: 122.4, page: 1 },
          map: { lon: -88.2434, lat: 40.1164 },
          confidence: 0.91,
          rationale: 'Verified intersection: W Springfield Ave & S Neil St',
          provenance: 'gemini_grounded',
          identifiedRegion: 'Champaign, Illinois, USA'
        },
        {
          id: 'sug-2',
          pdf: { x: 633.6, y: 489.6, page: 1 },
          map: { lon: -88.218, lat: 40.098 },
          confidence: 0.89,
          rationale: 'Verified intersection: E Windsor Rd & S Philo Rd',
          provenance: 'gemini_grounded',
          identifiedRegion: 'Champaign, Illinois, USA'
        }
      ]);

    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <Provider store={store}>
          <MapContext.Provider value={{ map: fakeMap } as unknown as PMap}>
            <ControlPointsPanel />
          </MapContext.Provider>
        </Provider>
      );
    });

    const toggleBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).find((btn) => btn.textContent?.includes('Show AI Suggestion'));
    expect(toggleBtn).toBeDefined();

    act(() => {
      toggleBtn!.click();
    });

    const suggestBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).find((btn) => btn.textContent?.includes('Suggest Points'));
    expect(suggestBtn).toBeDefined();

    await act(async () => {
      suggestBtn!.click();
      await Promise.resolve();
    });

    expect(suggestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pdfPageWidth: 792,
        pdfPageHeight: 612
      })
    );
    expect(fitBoundsMock).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      'Matched region: Champaign, Illinois, USA'
    );

    // Simulate user zooming the PDF viewer to 4.0x BEFORE clicking "Add as Control Point"
    pdfCanvas.dataset.pdfScale = '4.0';

    const addBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).find((btn) => btn.textContent?.includes('Add as Control Point'));
    expect(addBtn).toBeDefined();

    act(() => {
      addBtn!.click();
    });

    const addedPoints = store.get(controlPointsAtom);
    expect(addedPoints).toHaveLength(1);
    // Must preserve exact unscaled PDF coordinates (158.4, 122.4) without dividing by 2.5 or 4.0!
    expect(addedPoints[0].pdf.x).toBeCloseTo(158.4, 4);
    expect(addedPoints[0].pdf.y).toBeCloseTo(122.4, 4);
    expect(addedPoints[0].map.lon).toBeCloseTo(-88.2434, 5);
    expect(addedPoints[0].confirmed).toBe(false);

    act(() => {
      root.unmount();
    });
  });
});
