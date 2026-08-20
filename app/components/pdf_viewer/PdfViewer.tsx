import type {
  PDFDocumentProxy,
  RenderTask
} from 'pdfjs-dist/types/src/display/api';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  MinusIcon,
  PlusIcon,
  ResetIcon
} from '@radix-ui/react-icons';
import type { ChangeEvent, DragEvent, MouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { extractedLegendAtom } from 'state/digitizer';
import { ocrAdapter } from 'app/lib/ocr_adapter';
import { spatialExtractionEngine } from '../../lib/spatial_extraction_engine';
import { digitizerFeaturesAtom } from 'state/digitizer_features';
import { solveTransform, transformPoint } from '../../lib/transform_engine';
import { newFeatureId as generateId } from '../../lib/id';
import type { DigitizerFeature } from 'types/digitizer';
import type { ControlPointPair } from 'state/control_points';

interface PdfViewerProps {
  file: File | null;
  page?: number;
  isPickingPdfPoint?: boolean;
  pendingPdfPoint?: {
    x: number;
    y: number;
    page: number;
  } | null;
  controlPoints?: ControlPointPair[];
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
  pendingPdfPoint = null,
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
  /** null = fit to container width; number = explicit scale factor */
  const [zoomFactor, setZoomFactor] = useState<number | null>(null);
  const fitScaleRef = useRef(1);
  const panRef = useRef<{
    startX: number;
    startY: number;
    scrollX: number;
    scrollY: number;
  } | null>(null);
  const panMovedRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [docState, setDocState] = useState<PDFDocumentProxy | null>(null);
  const [renderedScale, setRenderedScale] = useState(1);
  const [renderedSize, setRenderedSize] = useState({ width: 0, height: 0 });

  const [extractedLegend, setExtractedLegend] = useAtom(extractedLegendAtom);
  const [digitizerFeatures, setDigitizerFeatures] = useAtom(
    digitizerFeaturesAtom
  );
  const [isExtractingShapes, setIsExtractingShapes] = useState(false);
  const [isCroppingMode, setIsCroppingMode] = useState(false);
  const [isDrawingCrop, setIsDrawingCrop] = useState(false);
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(
    null
  );
  const [cropEnd, setCropEnd] = useState<{ x: number; y: number } | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [legendCropMessage, setLegendCropMessage] = useState<string | null>(
    null
  );
  const [isWorkflowOpen, setIsWorkflowOpen] = useState(false);
  const [pageInput, setPageInput] = useState('1');

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
  const totalControlPointCount = controlPoints.length;
  const confirmedControlPointCount = useMemo(
    () => controlPoints.filter((point) => point.confirmed).length,
    [controlPoints]
  );
  const hasLegend = Boolean(
    extractedLegend && extractedLegend.zones.length > 0
  );
  const canRunSpatialExtraction =
    confirmedControlPointCount >= 3 && hasLegend && !isExtractingShapes;
  const extractionBlockedReason = !hasLegend
    ? 'Crop and extract the legend before extracting shapes'
    : confirmedControlPointCount < 3
      ? `Confirm ${3 - confirmedControlPointCount} more control point${3 - confirmedControlPointCount === 1 ? '' : 's'}`
      : 'Extract zoning shapes based on the legend and confirmed control points';

  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  }, [onPageChange]);

  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
  }, [onPageCountChange]);

  useEffect(() => {
    setPageInput(String(activePage));
  }, [activePage]);

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
        const fitScale = containerWidth / Math.max(unscaledViewport.width, 1);
        fitScaleRef.current = fitScale;
        const scale = zoomFactor ?? fitScale;

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
  }, [activePage, docState, pageCount, zoomFactor]);

  // Attach wheel zoom to the scroll container (must be non-passive to preventDefault).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !file) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoomFactor((prev) => {
        const current = prev ?? fitScaleRef.current;
        return Math.min(8, Math.max(0.25, current * step));
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [file]);

  const fileLabel = useMemo(() => {
    return file?.name ?? 'No PDF selected';
  }, [file]);

  const pointsOnPage = useMemo(
    () => controlPoints.filter((point) => point.pdf.page === activePage),
    [activePage, controlPoints]
  );

  const pendingPointOnPage = useMemo(() => {
    if (!pendingPdfPoint || pendingPdfPoint.page !== activePage) {
      return null;
    }

    return pendingPdfPoint;
  }, [activePage, pendingPdfPoint]);

  const handleCanvasMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (isCroppingMode) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        setCropStart({ x, y });
        setCropEnd({ x, y });
        setIsDrawingCrop(true);
        return;
      }
      // Begin grab-to-pan
      panRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        scrollX: containerRef.current?.scrollLeft ?? 0,
        scrollY: containerRef.current?.scrollTop ?? 0
      };
      panMovedRef.current = false;
      setIsDragging(true);
    },
    [isCroppingMode]
  );

  const handleCanvasMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (panRef.current && !isCroppingMode) {
        const dx = event.clientX - panRef.current.startX;
        const dy = event.clientY - panRef.current.startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) panMovedRef.current = true;
        if (containerRef.current) {
          containerRef.current.scrollLeft = panRef.current.scrollX - dx;
          containerRef.current.scrollTop = panRef.current.scrollY - dy;
        }
        return;
      }
      if (!isDrawingCrop || !cropStart) return;
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setCropEnd({ x, y });
    },
    [isDrawingCrop, cropStart]
  );

  const handleCanvasMouseUp = useCallback(
    async (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (panRef.current) {
        panRef.current = null;
        setIsDragging(false);
        return;
      }
      if (!isDrawingCrop || !cropStart || !cropEnd) return;
      setIsDrawingCrop(false);

      const canvas = canvasRef.current;
      if (!canvas) return;

      // Calculate crop dimensions
      const x = Math.min(cropStart.x, cropEnd.x);
      const y = Math.min(cropStart.y, cropEnd.y);
      const width = Math.abs(cropEnd.x - cropStart.x);
      const height = Math.abs(cropEnd.y - cropStart.y);

      if (width < 10 || height < 10) {
        // Too small to be a real crop
        setLegendCropMessage(
          'Crop area was too small. Drag a larger box around the legend.'
        );
        setCropStart(null);
        setCropEnd(null);
        return;
      }

      setIsExtracting(true);
      try {
        // Create a temporary canvas to extract the image data
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const ctx = tempCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
          const base64Image = tempCanvas.toDataURL('image/jpeg');
          const legend = await ocrAdapter.extractLegend(base64Image);
          if (!legend) {
            setExtractedLegend(null);
            setLegendCropMessage(
              'Legend extraction returned no data. Try a tighter crop around only the legend rows, then retry.'
            );
            return;
          }

          setExtractedLegend(legend);
          if (legend.zones.length > 0) {
            setLegendCropMessage(
              `Legend captured: found ${legend.zones.length} zone${legend.zones.length === 1 ? '' : 's'}.`
            );
          } else {
            setLegendCropMessage(
              'Legend crop completed, but no zones were detected. Try zooming in and cropping tighter around the legend rows.'
            );
          }
        }
      } catch (err) {
        console.error('Failed to extract legend', err);
        setLegendCropMessage(
          err instanceof Error
            ? `Legend extraction failed: ${err.message}`
            : 'Legend extraction failed. Try another crop area.'
        );
      } finally {
        setIsExtracting(false);
        setIsCroppingMode(false);
        setCropStart(null);
        setCropEnd(null);
      }
    },
    [isDrawingCrop, cropStart, cropEnd, setExtractedLegend]
  );

  const handleExtractShapes = useCallback(async () => {
    if (
      !canvasRef.current ||
      !extractedLegend ||
      extractedLegend.zones.length === 0
    )
      return;

    // Check if we have enough confirmed GCPs for transform
    const confirmedGCPs = controlPoints.filter((p) => p.confirmed);
    if (confirmedGCPs.length < 3) {
      alert(
        'Cannot extract shapes: Please confirm at least 3 Ground Control Points (GCPs) first to allow coordinate transformation.'
      );
      return;
    }

    setIsExtractingShapes(true);
    try {
      const transformResult = solveTransform(confirmedGCPs);
      const extractedPolygons = await spatialExtractionEngine.extractShapes(
        canvasRef.current,
        extractedLegend.zones
      );

      const newFeatures: DigitizerFeature[] = extractedPolygons.map((poly) => {
        // Transform coordinates
        const mapCoords = poly.pdfCoordinates.map((pt) => {
          const mapPt = transformPoint(transformResult.transform, pt);
          return [mapPt.lon, mapPt.lat];
        });

        // Ensure polygon is closed
        if (mapCoords.length > 0) {
          const first = mapCoords[0];
          const last = mapCoords[mapCoords.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) {
            mapCoords.push([...first]);
          }
        }

        // Generate the base feature
        const feature: DigitizerFeature = {
          id: generateId(),
          geometry: {
            type: 'Polygon',
            coordinates: [mapCoords]
          },
          properties: {
            planning_class: poly.legendItem.description,
            raw_zoning_label: poly.legendItem.code,
            confidence: 0.5,
            source_type: 'digitized',
            source_name: file ? file.name : 'extracted_shapes',
            human_confirmed: false
          }
        };

        return feature;
      });

      setDigitizerFeatures((prev) => [...prev, ...newFeatures]);
      alert(`Successfully extracted ${newFeatures.length} shapes.`);
    } catch (err) {
      console.error('Failed to extract shapes:', err);
      alert('Failed to extract shapes. See console for details.');
    } finally {
      setIsExtractingShapes(false);
    }
  }, [extractedLegend, controlPoints, file, setDigitizerFeatures]);

  const removeLegendItem = useCallback(
    (indexToRemove: number) => {
      if (!extractedLegend) return;
      const newZones = [...extractedLegend.zones];
      newZones.splice(indexToRemove, 1);
      setExtractedLegend({ ...extractedLegend, zones: newZones });
    },
    [extractedLegend, setExtractedLegend]
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const startLegendCrop = useCallback(() => {
    setIsWorkflowOpen(true);
    setLegendCropMessage(null);
    setIsCroppingMode(true);
  }, []);

  const cancelLegendCrop = useCallback(() => {
    setIsCroppingMode(false);
    setIsDrawingCrop(false);
    setCropStart(null);
    setCropEnd(null);
  }, []);

  const commitPageInput = useCallback(() => {
    const requestedPage = Number.parseInt(pageInput, 10);

    if (Number.isFinite(requestedPage)) {
      setPage(requestedPage);
      return;
    }

    setPageInput(String(activePage));
  }, [activePage, pageInput, setPage]);

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
      if (panMovedRef.current) {
        panMovedRef.current = false;
        return;
      }
      if (isCroppingMode || isDrawingCrop) {
        return;
      }

      if (!onPdfCoordinatePick) return;

      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const scale = Number(canvas.dataset.pdfScale ?? '1');

      const x = (event.clientX - rect.left) / Math.max(scale, 0.0001);
      const y = (event.clientY - rect.top) / Math.max(scale, 0.0001);

      // TODO(phase-2): Extend this interface for linked GCP placement with map coordinates.
      onPdfCoordinatePick({ x, y, page: activePage });
    },
    [activePage, isCroppingMode, isDrawingCrop, onPdfCoordinatePick]
  );

  return (
    <section className="min-h-0 flex-1 w-full flex flex-col border-r border-gray-200 bg-gray-50 dark:bg-gray-900 dark:border-gray-700">
      <header className="min-h-12 px-3 py-2 flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-gray-700">
        <div className="min-w-0 flex items-center gap-2">
          <strong className="shrink-0 text-sm text-gray-800 dark:text-gray-100">
            PDF Viewer
          </strong>
          <span
            className="truncate text-xs text-gray-500 dark:text-gray-400"
            title={fileLabel}
          >
            {fileLabel}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {file && (
            <button
              type="button"
              onClick={handleUploadClick}
              className="px-2 py-1 text-xs font-medium text-gray-700 border border-gray-300 rounded hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Replace PDF
            </button>
          )}
          {file && (
            <div
              className="flex items-center overflow-hidden border border-gray-300 rounded dark:border-gray-600"
              aria-label="Zoom controls"
            >
              <button
                type="button"
                onClick={() =>
                  setZoomFactor((previousZoom) =>
                    Math.max(0.25, (previousZoom ?? fitScaleRef.current) / 1.25)
                  )
                }
                className="grid w-7 h-7 place-items-center text-gray-700 hover:bg-white dark:text-gray-200 dark:hover:bg-gray-800"
                aria-label="Zoom out"
                title="Zoom out"
              >
                <MinusIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setZoomFactor(null)}
                className="grid w-7 h-7 place-items-center border-x border-gray-300 text-gray-700 hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                aria-label="Fit page to panel"
                title="Fit page to panel"
              >
                <ResetIcon aria-hidden="true" />
              </button>
              <span
                className="w-12 text-xs text-center tabular-nums text-gray-600 dark:text-gray-400"
                aria-live="polite"
              >
                {zoomFactor !== null ? `${Math.round(zoomFactor * 100)}%` : 'Fit'}
              </span>
              <button
                type="button"
                onClick={() =>
                  setZoomFactor((previousZoom) =>
                    Math.min(8, (previousZoom ?? fitScaleRef.current) * 1.25)
                  )
                }
                className="grid w-7 h-7 place-items-center border-l border-gray-300 text-gray-700 hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                aria-label="Zoom in"
                title="Zoom in"
              >
                <PlusIcon aria-hidden="true" />
              </button>
            </div>
          )}
          {file && (
            <div
              className="flex items-center overflow-hidden border border-gray-300 rounded dark:border-gray-600"
              aria-label="Page controls"
            >
              <button
                type="button"
                onClick={() => setPage(activePage - 1)}
                disabled={!canGoPrev}
                className="grid w-7 h-7 place-items-center text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-800"
                aria-label="Previous page"
                title="Previous page"
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <label className="sr-only" htmlFor="pdf-page-number">
                Current page
              </label>
              <input
                id="pdf-page-number"
                type="number"
                min="1"
                max={Math.max(pageCount, 1)}
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={commitPageInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
                disabled={pageCount === 0}
                className="w-9 h-7 border-x border-gray-300 bg-transparent text-center text-xs tabular-nums text-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
              />
              <span className="w-8 text-xs text-center tabular-nums text-gray-600 dark:text-gray-400">
                / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage(activePage + 1)}
                disabled={!canGoNext}
                className="grid w-7 h-7 place-items-center border-l border-gray-300 text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                aria-label="Next page"
                title="Next page"
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        onChange={handleFileInput}
        className="hidden"
      />

      {(isCroppingMode || isPickingPdfPoint) && (
        <div
          className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          role="status"
          aria-live="polite"
        >
          <div>
            <p className="text-xs font-semibold">
              {isCroppingMode
                ? isExtracting
                  ? 'Extracting legend'
                  : 'Legend crop active'
                : 'Control point placement active'}
            </p>
            <p className="text-xs">
              {isCroppingMode
                ? isExtracting
                  ? 'Reading the selected legend area.'
                  : 'Drag a box around the zoning legend on this page.'
                : 'Click the matching location on this PDF page, then select it on the map.'}
            </p>
          </div>
          {isCroppingMode && !isExtracting && (
            <button
              type="button"
              onClick={cancelLegendCrop}
              className="shrink-0 px-2 py-1 text-xs font-medium border border-amber-400 rounded hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
            >
              Cancel crop
            </button>
          )}
        </div>
      )}

      {file && (
        <section className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <button
            type="button"
            onClick={() => setIsWorkflowOpen((open) => !open)}
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
            aria-expanded={isWorkflowOpen}
            aria-controls="pdf-extraction-workflow"
          >
            <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">
              Legend &amp; shape extraction
            </span>
            <span className="ml-auto text-xs tabular-nums text-gray-500 dark:text-gray-400">
              {confirmedControlPointCount}/3 GCPs ·{' '}
              {hasLegend ? extractedLegend?.zones.length ?? 0 : 0} zones
            </span>
            {isWorkflowOpen ? (
              <ChevronUpIcon aria-hidden="true" />
            ) : (
              <ChevronDownIcon aria-hidden="true" />
            )}
          </button>
          {isWorkflowOpen && (
            <div
              id="pdf-extraction-workflow"
              className="space-y-3 border-t border-gray-200 px-3 py-3 dark:border-gray-700"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-gray-800 dark:text-gray-100">
                    Capture the zoning legend
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    Select only the legend rows used for zoning areas.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={startLegendCrop}
                  disabled={isCroppingMode || isExtracting}
                  className="px-2.5 py-1.5 text-xs font-medium text-gray-800 border border-gray-300 rounded hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
                >
                  {isExtracting ? 'Extracting legend...' : 'Crop legend'}
                </button>
              </div>

              {legendCropMessage && (
                <p
                  className="text-xs text-gray-700 dark:text-gray-200"
                  role="status"
                >
                  {legendCropMessage}
                </p>
              )}

              {hasLegend && extractedLegend && (
                <div>
                  <p className="mb-1 text-xs font-medium text-gray-800 dark:text-gray-100">
                    Legend filters
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {extractedLegend.zones.map((zone, index) => (
                      <li
                        key={index}
                        className="flex items-center gap-1.5 border border-gray-300 bg-gray-50 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full border border-gray-400"
                          style={{ backgroundColor: zone.color }}
                        />
                        <span className="font-medium text-gray-700 dark:text-gray-200">
                          {zone.code || zone.description}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeLegendItem(index)}
                          className="grid w-4 h-4 place-items-center text-gray-500 hover:text-red-600"
                          aria-label={`Exclude ${zone.code || zone.description} from shape extraction`}
                          title="Exclude this legend color from shape extraction"
                        >
                          &times;
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                <div>
                  <p className="text-xs font-medium text-gray-800 dark:text-gray-100">
                    Extract zoning shapes
                  </p>
                  <p
                    className={
                      canRunSpatialExtraction
                        ? 'text-xs text-emerald-700 dark:text-emerald-300'
                        : 'text-xs text-amber-700 dark:text-amber-300'
                    }
                  >
                    {canRunSpatialExtraction
                      ? 'Ready to create map polygons from the selected legend.'
                      : extractionBlockedReason}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleExtractShapes}
                  disabled={!canRunSpatialExtraction}
                  className="px-3 py-1.5 text-xs font-semibold text-blue-800 bg-blue-100 border border-blue-300 rounded hover:bg-blue-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-700 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800"
                  title={extractionBlockedReason}
                >
                  {isExtractingShapes
                    ? 'Extracting shapes...'
                    : 'Extract shapes'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

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
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              className={
                isCroppingMode
                  ? 'mx-auto bg-white shadow-sm cursor-crosshair ring-2 ring-amber-300'
                  : isPickingPdfPoint
                    ? 'mx-auto bg-white shadow-sm cursor-crosshair ring-2 ring-amber-300'
                    : isDragging
                      ? 'mx-auto bg-white shadow-sm cursor-grabbing select-none'
                      : 'mx-auto bg-white shadow-sm cursor-grab'
              }
              aria-label="Rendered PDF page"
            />
            {isCroppingMode && cropStart && cropEnd && (
              <div
                className="absolute border-2 border-amber-500 bg-amber-500/20 pointer-events-none"
                style={{
                  left: Math.min(cropStart.x, cropEnd.x),
                  top: Math.min(cropStart.y, cropEnd.y),
                  width: Math.abs(cropEnd.x - cropStart.x),
                  height: Math.abs(cropEnd.y - cropStart.y)
                }}
              />
            )}
            {(pointsOnPage.length > 0 || pendingPointOnPage) &&
              renderedSize.width > 0 && (
                <div className="absolute inset-0 pointer-events-none">
                  {pointsOnPage.map((point, index) => {
                    const left = point.pdf.x * renderedScale;
                    const top = point.pdf.y * renderedScale;
                    const isActive = point.id === activeControlPointId;
                    const pointStyle = isActive
                      ? {
                          left,
                          top,
                          backgroundImage:
                            'repeating-linear-gradient(135deg, #ffffff 0px, #ffffff 3px, #111111 3px, #111111 6px)',
                          boxShadow:
                            '0 0 0 2px rgba(245, 158, 11, 0.9), 0 2px 8px rgba(0,0,0,0.4)'
                        }
                      : point.confirmed
                        ? {
                            left,
                            top,
                            backgroundImage:
                              'repeating-linear-gradient(135deg, #86efac 0px, #86efac 3px, #166534 3px, #166534 6px)',
                            boxShadow:
                              '0 0 0 1px rgba(21, 128, 61, 0.9), 0 2px 6px rgba(0,0,0,0.35)'
                          }
                        : {
                            left,
                            top,
                            backgroundImage:
                              'repeating-linear-gradient(135deg, #bae6fd 0px, #bae6fd 3px, #0c4a6e 3px, #0c4a6e 6px)',
                            boxShadow:
                              '0 0 0 1px rgba(3, 105, 161, 0.85), 0 2px 6px rgba(0,0,0,0.35)'
                          };

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
                            ? 'absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 border-black text-[10px] font-semibold text-black pointer-events-auto shadow'
                            : point.confirmed
                              ? 'absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-black/70 bg-emerald-400 text-[10px] font-semibold text-black pointer-events-auto shadow'
                              : 'absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-black/70 bg-sky-300 text-[10px] font-semibold text-black pointer-events-auto shadow'
                        }
                        style={pointStyle}
                        aria-label={`Control point ${index + 1} on page ${activePage}`}
                        title={`Control point ${index + 1}`}
                      >
                        {index + 1}
                      </button>
                    );
                  })}
                  {pendingPointOnPage && (
                    <div
                      className="absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-black shadow"
                      style={{
                        left: pendingPointOnPage.x * renderedScale,
                        top: pendingPointOnPage.y * renderedScale,
                        backgroundImage:
                          'repeating-linear-gradient(135deg, #fde68a 0px, #fde68a 3px, #78350f 3px, #78350f 6px)'
                      }}
                      aria-label="Pending control point on PDF"
                      title="Pending control point"
                    />
                  )}
                </div>
              )}
          </div>
        </div>
      )}
    </section>
  );
}
