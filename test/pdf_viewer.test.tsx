// @vitest-environment jsdom

import { PdfViewer } from 'app/components/pdf_viewer/PdfViewer';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('app/lib/spatial_extraction_engine', () => ({
  spatialExtractionEngine: {
    extractShapes: vi.fn()
  }
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: () =>
        Promise.resolve({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 320 * scale,
            height: 400 * scale
          }),
          render: () => ({ promise: Promise.resolve(), cancel: vi.fn() })
        })
    }),
    destroy: vi.fn()
  })
}));

describe('PdfViewer workspace control', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  it('toggles the PDF workspace and reflects the current view', () => {
    const onToggleMaximize = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PdfViewer file={null} onToggleMaximize={onToggleMaximize} />
      );
    });

    const maximizeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Maximize PDF workspace"]'
    );
    expect(maximizeButton).not.toBeNull();

    act(() => {
      maximizeButton?.click();
    });
    expect(onToggleMaximize).toHaveBeenCalledOnce();

    act(() => {
      root.render(
        <PdfViewer
          file={null}
          isMaximized
          onToggleMaximize={onToggleMaximize}
        />
      );
    });

    expect(
      container.querySelector('button[aria-label="Restore split workspace"]')
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('switches from cropping to point picking and lets clicks pass through point markers', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const file = new File(['pdf'], 'map.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.resolve(new ArrayBuffer(0))
    });
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    context.mockReturnValue({} as CanvasRenderingContext2D);
    const onPdfCoordinatePick = vi.fn();
    const point = {
      id: 'existing',
      pdf: { x: 10, y: 20, page: 1 },
      map: { lon: -72, lat: 42 },
      confirmed: true
    };
    const render = (isPickingPdfPoint: boolean) => (
      <PdfViewer
        file={file}
        isPickingPdfPoint={isPickingPdfPoint}
        controlPoints={[point]}
        onPdfCoordinatePick={onPdfCoordinatePick}
      />
    );

    await act(async () => {
      root.render(render(false));
      await Promise.resolve();
    });
    const workflow = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.includes('Legend & shape extraction')
    );
    act(() => workflow?.click());
    const crop = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Crop legend'
    );
    expect(crop).toBeDefined();
    act(() => crop?.click());
    expect(container.textContent).toContain('Legend crop active');

    await act(async () => {
      root.render(render(true));
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Legend crop active');
    expect(crop?.disabled).toBe(true);
    const marker = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Control point 1 on page 1"]'
    );
    expect(marker?.disabled).toBe(true);
    expect(marker?.classList.contains('pointer-events-none')).toBe(true);
    const pdfCanvas = container.querySelector<HTMLCanvasElement>('canvas');
    expect(pdfCanvas).not.toBeNull();
    act(() => {
      pdfCanvas?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 })
      );
    });
    expect(onPdfCoordinatePick).toHaveBeenCalledWith({ x: 10, y: 20, page: 1 });
    act(() => root.unmount());
    context.mockRestore();
  });

  it('defaults parcel GeoJSON extraction mode to individual parcel classification', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const file = new File(['pdf'], 'map.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.resolve(new ArrayBuffer(0))
    });
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D);

    await act(async () => {
      root.render(<PdfViewer file={file} />);
      await Promise.resolve();
    });

    const workflow = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.includes('Legend & shape extraction')
    );
    act(() => workflow?.click());

    const parcelInput = container.querySelector<HTMLInputElement>(
      'input[accept*="geojson"]'
    );
    expect(parcelInput).not.toBeNull();

    const parcelGeoJson = new File(
      [JSON.stringify({ type: 'FeatureCollection', features: [] })],
      'parcels.geojson',
      { type: 'application/geo+json' }
    );
    Object.defineProperty(parcelInput!, 'files', {
      value: [parcelGeoJson],
      configurable: true
    });

    act(() => {
      parcelInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const modeSelect = container.querySelector<HTMLSelectElement>(
      '#parcel-extraction-mode'
    );
    expect(modeSelect).not.toBeNull();
    expect(modeSelect?.value).toBe('classify_parcels');
    expect(Array.from(modeSelect!.options).map((opt) => opt.value)).toEqual([
      'classify_parcels',
      'dissolve_parcels',
      'snap_outlines'
    ]);

    act(() => root.unmount());
    context.mockRestore();
  });
});
