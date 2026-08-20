// @vitest-environment jsdom

import { DigitizerSplitResizer } from 'app/components/resizer';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface MoveHandlers {
  onMoveStart: () => void;
  onMove: (event: { deltaX: number }) => void;
  onMoveEnd: () => void;
}

vi.mock('@react-aria/interactions', () => ({
  useMove: (handlers: MoveHandlers) => ({
    moveProps: {
      onPointerDown: () => {
        handlers.onMoveStart();
        handlers.onMove({ deltaX: 500 });
        handlers.onMoveEnd();
      }
    }
  })
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('DigitizerSplitResizer', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  it('resizes the PDF pane without leaving the map below its minimum width', () => {
    const onResize = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <div>
          <div data-testid="pdf-pane" />
          <DigitizerSplitResizer onResize={onResize} />
          <div />
        </div>
      );
    });

    const workspace = container.firstElementChild as HTMLDivElement;
    const pdfPane = workspace.firstElementChild as HTMLDivElement;
    Object.defineProperty(workspace, 'clientWidth', {
      configurable: true,
      value: 1000
    });
    vi.spyOn(pdfPane, 'getBoundingClientRect').mockReturnValue({
      bottom: 0,
      height: 0,
      left: 0,
      right: 500,
      top: 0,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    const divider = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resize PDF and map workspaces"]'
    );
    expect(divider).not.toBeNull();

    act(() => {
      divider?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(onResize).toHaveBeenCalledWith(672);

    act(() => {
      root.unmount();
    });
  });
});