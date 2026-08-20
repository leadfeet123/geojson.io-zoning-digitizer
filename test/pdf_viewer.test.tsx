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
});