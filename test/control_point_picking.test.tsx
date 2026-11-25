// @vitest-environment jsdom

import { ControlPointsPanel } from 'app/components/control_points/ControlPointsPanel';
import { ControlPointMapCapture } from 'app/components/control_points/ControlPointMapCapture';
import { MapContext } from 'app/context/map_context';
import type PMap from 'app/lib/pmap';
import { createStore, Provider } from 'jotai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  controlPointPlacementModeAtom,
  controlPointsAtom,
  pendingPdfPointAtom,
  relocatingTargetAtom
} from 'state/control_points';
import { digitizerWorkspaceViewAtom } from 'state/digitizer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { suggestPoints } = vi.hoisted(() => ({ suggestPoints: vi.fn() }));
vi.mock('app/lib/georef_suggestion_adapter', () => ({
  defaultGeorefSuggestionSource: 'Heuristic',
  defaultGeorefSuggestionAdapter: { suggestPoints }
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('control point picking', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let mapClick:
    | ((event: { lngLat: { lng: number; lat: number } }) => void)
    | null;
  let canvas: HTMLCanvasElement;

  function button(label: string): HTMLButtonElement {
    const result = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === label
    );
    if (!result) throw new Error(`Button not found: ${label}`);
    return result;
  }

  beforeEach(() => {
    store = createStore();
    mapClick = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    canvas = document.createElement('canvas');
    canvas.dataset.pdfPage = '1';
    canvas.dataset.pdfScale = '2';
    canvas.toDataURL = () => 'data:image/png;base64,test';
    document.body.appendChild(canvas);
    const map = {
      getCanvas: () => canvas,
      getCenter: () => ({ lng: -72, lat: 42 }),
      getBounds: () => ({
        getWest: () => -73,
        getEast: () => -71,
        getSouth: () => 41,
        getNorth: () => 43
      }),
      once: (_name: string, handler: typeof mapClick) => {
        mapClick = handler;
      },
      off: (_name: string, handler: typeof mapClick) => {
        if (mapClick === handler) mapClick = null;
      }
    };
    const pmap = { map } as PMap;
    root = createRoot(container);
    act(() => {
      root.render(
        <Provider store={store}>
          <MapContext.Provider value={pmap}>
            <ControlPointsPanel />
            <ControlPointMapCapture />
          </MapContext.Provider>
        </Provider>
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    canvas.remove();
    suggestPoints.mockReset();
  });

  it('updates a suggested PDF location without adding it and keeps PDF units across zoom changes', async () => {
    suggestPoints.mockResolvedValue([
      {
        id: 'suggestion',
        pdf: { x: 100, y: 120, page: 1 },
        map: { lon: -72, lat: 42 },
        confidence: 0.8,
        rationale: 'review'
      }
    ]);
    act(() => button('Show AI Suggestion').click());
    await act(async () => {
      button('Suggest Points').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('PDF (100.0, 120.0) p1');

    act(() => button('Pick on map').click());
    expect(store.get(relocatingTargetAtom)).toEqual({
      type: 'suggestion',
      id: 'suggestion'
    });
    act(() => button('Pick on PDF').click());
    expect(store.get(relocatingTargetAtom)).toBeNull();
    act(() => {
      store.set(pendingPdfPointAtom, { x: 25, y: 35, page: 1 });
      store.set(controlPointPlacementModeAtom, 'awaiting_map');
    });
    expect(store.get(controlPointsAtom)).toEqual([]);
    expect(container.textContent).toContain('PDF (25.0, 35.0) p1');
    expect(store.get(controlPointPlacementModeAtom)).toBe('idle');

    canvas.dataset.pdfScale = '4';
    act(() => button('Add as Control Point').click());
    expect(store.get(controlPointsAtom)[0]).toMatchObject({
      pdf: { x: 25, y: 35, page: 1 },
      map: { lon: -72, lat: 42 },
      confirmed: false
    });
  });

  it('cancels relocation when starting a new pair and clears confirmation when moving a point', () => {
    act(() => {
      store.set(controlPointsAtom, [
        {
          id: 'point',
          pdf: { x: 10, y: 20, page: 1 },
          map: { lon: -72, lat: 42 },
          confirmed: true
        }
      ]);
    });
    act(() => button('Pick on map').click());
    expect(store.get(relocatingTargetAtom)).toEqual({
      type: 'point',
      id: 'point'
    });
    act(() => button('Add Control Point').click());
    expect(store.get(relocatingTargetAtom)).toBeNull();
    act(() => {
      store.set(pendingPdfPointAtom, { x: 5, y: 6, page: 1 });
      store.set(controlPointPlacementModeAtom, 'awaiting_map');
    });
    act(() => mapClick?.({ lngLat: { lng: -71, lat: 41 } }));
    expect(store.get(controlPointsAtom)).toHaveLength(2);
    expect(store.get(controlPointsAtom)[0].confirmed).toBe(true);

    act(() => button('Pick on map').click());
    act(() => mapClick?.({ lngLat: { lng: -70, lat: 40 } }));
    expect(store.get(controlPointsAtom)[0]).toMatchObject({
      map: { lon: -70, lat: 40 },
      confirmed: false
    });
  });

  it('disables map picking while the map is hidden and cancels an active pick', () => {
    act(() => {
      store.set(controlPointsAtom, [
        {
          id: 'point',
          pdf: { x: 10, y: 20, page: 1 },
          map: { lon: -72, lat: 42 },
          confirmed: false
        }
      ]);
    });
    act(() => button('Pick on map').click());
    act(() => store.set(digitizerWorkspaceViewAtom, 'pdf'));
    expect(store.get(relocatingTargetAtom)).toBeNull();
    expect(button('Pick on map').disabled).toBe(true);
    act(() => store.set(digitizerWorkspaceViewAtom, 'split'));
    expect(button('Pick on map').disabled).toBe(false);
  });

  it('requires reconfirmation when existing point coordinates are edited', () => {
    act(() => {
      store.set(controlPointsAtom, [
        {
          id: 'point',
          pdf: { x: 10, y: 20, page: 1 },
          map: { lon: -72, lat: 42 },
          confirmed: true
        }
      ]);
    });
    const changeInput = (label: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(
        `input[aria-label="${label}"]`
      );
      if (!input) throw new Error(`Input not found: ${label}`);
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      act(() => {
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    changeInput('PDF X coordinate', '15');
    expect(store.get(controlPointsAtom)[0]).toMatchObject({
      pdf: { x: 15 },
      confirmed: false
    });
    act(() => {
      store.set(controlPointsAtom, (points) =>
        points.map((point) => ({ ...point, confirmed: true }))
      );
    });
    changeInput('Map longitude', '-71');
    expect(store.get(controlPointsAtom)[0]).toMatchObject({
      map: { lon: -71 },
      confirmed: false
    });
  });
});
