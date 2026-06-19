import type {
  PDFDocumentProxy,
  RenderTask
} from 'pdfjs-dist/types/src/display/api';
import type { ChangeEvent, DragEvent, MouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ZoomMode = 'fit' | '100%';

interface PdfViewerProps {
  file: File | null;
  page?: number;
  isPickingPdfPoint?: boolean;
  controlPoints?: Array<{
    id: string;
    pdf: {
      x: number;
      y: number;
      page: number;
    };
    confirmed: boolean;
  }>;
  activeControlPointId?: string | null;
  onPageChange?: (page: number) => void;
  onPageCountChange?: (pageCount: number) => void;
  onFileSelect?: (file: File) => void;
  onControlPointClick?: (controlPointId: string) => void;
  onPdfCoordinatePick?: (coords: {
    x: number;
    y: number;
    page: number;
  }) => void;
}

/**
 * Minimal Phase 1 PDF viewer scaffold with upload, render, and page controls.
 */
export function PdfViewer({
  file,
  page,
  isPickingPdfPoint = false,
  controlPoints = [],
  activeControlPointId = null,
  onPageChange,
  onPageCountChange,
  onFileSelect,
  onControlPointClick,
  onPdfCoordinatePick
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onPageChangeRef = useRef(onPageChange);
  const onPageCountChangeRef = useRef(onPageCountChange);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [internalPage, setInternalPage] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');
  const [docState, setDocState] = useState<PDFDocumentProxy | null>(null);
  const [renderedScale, setRenderedScale] = useState(1);
  const [renderedSize, setRenderedSize] = useState({ width: 0, height: 0 });

  const activePage = page ?? internalPage;

  const setPage = useCallback(
    (nextPage: number) => {
      const clamped = Math.min(Math.max(nextPage, 1), Math.max(pageCount, 1));
      if (onPageChange) {
        onPageChange(clamped);
      } else {
        setInternalPage(clamped);
      }
    },
    [onPageChange, pageCount]
  );

  const canGoPrev = activePage > 1;
  const canGoNext = activePage < pageCount;

  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  }, [onPageChange]);

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
  }, [onPageCountChange]);

  useEffect(() => {
    let cancelled = false;

    if (!file) {
      setDocState(null);
      setPageCount(0);
      setInternalPage(1);
      setError(null);
      return;
    }

    const activeFile = file;

    async function loadDocument() {
      setLoading(true);
      setError(null);

      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();

        const data = await activeFile.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data });
        const loadedDoc = await loadingTask.promise;

        if (cancelled) {
          await loadingTask.destroy();
          return;
        }

        setDocState(loadedDoc);

        setPageCount(loadedDoc.numPages);
        onPageCountChangeRef.current?.(loadedDoc.numPages);

        if (onPageChangeRef.current) {
          onPageChangeRef.current(1);
        } else {
          setInternalPage(1);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load PDF document'
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadDocument();

    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    let renderTask: RenderTask | null = null;
    let cancelled = false;

    async function renderPage() {
      if (
        !docState ||
        !canvasRef.current ||
        !containerRef.current ||
        pageCount === 0
      ) {
        return;
      }

      try {
        const currentPage = await docState.getPage(activePage);
        const unscaledViewport = currentPage.getViewport({ scale: 1 });

        const containerWidth = Math.max(
          containerRef.current.clientWidth - 24,
          320
        );
        const scale =
          zoomMode === 'fit'
            ? containerWidth / Math.max(unscaledViewport.width, 1)
            : 1;

        const viewport = currentPage.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');

        if (!context) {
          setError('Canvas context is unavailable');
          return;
        }

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        renderTask = currentPage.render({
          canvas,
          canvasContext: context,
          viewport
        });

        await renderTask.promise;

        if (cancelled) {
          return;
        }

        canvas.dataset.pdfScale = String(scale);
        canvas.dataset.pdfPage = String(activePage);
        setRenderedScale(scale);
        setRenderedSize({
          width: Math.ceil(viewport.width),
          height: Math.ceil(viewport.height)
        });
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to render PDF page'
          );
        }
      }
    }

    renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [activePage, docState, pageCount, zoomMode]);

  const fileLabel = useMemo(() => {
    return file?.name ?? 'No PDF selected';
  }, [file]);

  const pointsOnPage = useMemo(
    () => controlPoints.filter((point) => point.pdf.page === activePage),
    [activePage, controlPoints]
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) return;
      onFileSelect?.(selectedFile);
      event.target.value = '';
    },
    [onFileSelect]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const dropped = event.dataTransfer.files?.[0];
      if (!dropped) return;
      onFileSelect?.(dropped);
    },
    [onFileSelect]
  );

  const handleCanvasClick = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      if (!onPdfCoordinatePick) return;

      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const scale = Number(canvas.dataset.pdfScale ?? '1');

      const x = (event.clientX - rect.left) / Math.max(scale, 0.0001);
      const y = (event.clientY - rect.top) / Math.max(scale, 0.0001);

      // TODO(phase-2): Extend this interface for linked GCP placement with map coordinates.
      onPdfCoordinatePick({ x, y, page: activePage });
    },
    [activePage, onPdfCoordinatePick]
  );

  return (
    <section className="h-full w-full flex flex-col border-r border-gray-200 bg-gray-50 dark:bg-gray-900 dark:border-gray-700">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
        <strong className="text-sm text-gray-800 dark:text-gray-100">
          PDF Viewer
        </strong>
        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {fileLabel}
        </span>
        {isPickingPdfPoint && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Pick mode: click a PDF point
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setZoomMode('fit')}
            className="px-2 py-1 text-xs border rounded border-gray-300 dark:border-gray-600"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={() => setZoomMode('100%')}
            className="px-2 py-1 text-xs border rounded border-gray-300 dark:border-gray-600"
          >
            100%
          </button>
          <button
            type="button"
            onClick={() => setPage(activePage - 1)}
            disabled={!canGoPrev}
            className="px-2 py-1 text-xs border rounded border-gray-300 disabled:opacity-50 dark:border-gray-600"
          >
            Prev
          </button>
          <span className="text-xs text-gray-700 dark:text-gray-300">
            {pageCount === 0 ? '0 / 0' : `${activePage} / ${pageCount}`}
          </span>
          <button
            type="button"
            onClick={() => setPage(activePage + 1)}
            disabled={!canGoNext}
            className="px-2 py-1 text-xs border rounded border-gray-300 disabled:opacity-50 dark:border-gray-600"
          >
            Next
          </button>
        </div>
      </header>

      {!file ? (
        <div
          className="flex-1 grid place-items-center p-6"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="w-full max-w-md border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center bg-white dark:bg-gray-800">
            <p className="text-sm text-gray-700 dark:text-gray-200">
              Drop a PDF or click to open
            </p>
            <button
              type="button"
              onClick={handleUploadClick}
              className="mt-4 px-3 py-2 text-sm border rounded border-gray-300 dark:border-gray-600"
            >
              Open PDF
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={handleFileInput}
              className="hidden"
            />
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-auto p-3">
          {loading && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Loading PDF...
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div
            className="relative mx-auto"
            style={{
              width: renderedSize.width > 0 ? renderedSize.width : undefined,
              height: renderedSize.height > 0 ? renderedSize.height : undefined
            }}
          >
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              className={
                isPickingPdfPoint
                  ? 'mx-auto bg-white shadow-sm cursor-crosshair ring-2 ring-amber-300'
                  : 'mx-auto bg-white shadow-sm'
              }
              aria-label="Rendered PDF page"
            />
            {pointsOnPage.length > 0 && renderedSize.width > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                {pointsOnPage.map((point, index) => {
                  const left = point.pdf.x * renderedScale;
                  const top = point.pdf.y * renderedScale;
                  const isActive = point.id === activeControlPointId;

                  return (
                    <button
                      key={point.id}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onControlPointClick?.(point.id);
                      }}
                      className={
                        isActive
                          ? 'absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 border-white bg-amber-500 text-[10px] font-semibold text-white pointer-events-auto shadow'
                          : point.confirmed
                            ? 'absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-white bg-emerald-500 text-[10px] font-semibold text-white pointer-events-auto shadow'
                            : 'absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-white bg-sky-500 text-[10px] font-semibold text-white pointer-events-auto shadow'
                      }
                      style={{ left, top }}
                      aria-label={`Control point ${index + 1} on page ${activePage}`}
                      title={`Control point ${index + 1}`}
                    >
                      {index + 1}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
