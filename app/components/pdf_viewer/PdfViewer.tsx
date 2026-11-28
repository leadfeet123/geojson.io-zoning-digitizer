import type {
  PDFDocumentProxy,
  RenderTask
} from 'pdfjs-dist/types/src/display/api';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EnterFullScreenIcon,
  ExitFullScreenIcon,
  MinusIcon,
  PlusIcon,
  ResetIcon
} from '@radix-ui/react-icons';
import type { ChangeEvent, DragEvent, MouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { extractedLegendAtom } from 'state/digitizer';
import type { ParcelExtractionMode } from 'app/lib/parcel_zoning_classifier';
import {
  extractCalibratedLegendFromCrop,
  runZoningExtractionPipeline
} from 'app/lib/zoning_extraction_pipeline';
import { digitizerFeaturesAtom } from 'state/digitizer_features';
import type { ControlPointPair } from 'state/control_points';
import type { GeorefSuggestion } from 'app/lib/georef_suggestion_adapter';

interface PdfViewerProps {
  file: File | null;
  page?: number;
  isMaximized?: boolean;
  isPickingPdfPoint?: boolean;
  pendingPdfPoint?: {
    x: number;
    y: number;
    page: number;
  } | null;
  controlPoints?: ControlPointPair[];
  suggestions?: GeorefSuggestion[];
  activeControlPointId?: string | null;
  onPageChange?: (page: number) => void;
  onPageCountChange?: (pageCount: number) => void;
  onFileSelect?: (file: File) => void;
  onToggleMaximize?: () => void;
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
  isMaximized = false,
  isPickingPdfPoint = false,
  pendingPdfPoint = null,
  controlPoints = [],
  suggestions = [],
  activeControlPointId = null,
  onPageChange,
  onPageCountChange,
  onFileSelect,
  onToggleMaximize,
  onControlPointClick,
  onPdfCoordinatePick
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const parcelFileInputRef = useRef<HTMLInputElement | null>(null);
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
  const [parcelFile, setParcelFile] = useState<File | null>(null);
  const [parcelMode, setParcelMode] =
    useState<ParcelExtractionMode>('classify_parcels');
  const [parcelStatus, setParcelStatus] = useState<string | null>(null);
  const [snapToleranceInput, setSnapToleranceInput] = useState('5');
  const [shapeExtractionMessage, setShapeExtractionMessage] = useState<
    string | null
  >(null);
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
  const extractionInputsRef = useRef({
    file,
    parcelFile,
    parcelMode,
    controlPoints,
    activePage,
    snapToleranceInput,
    extractedLegend,
    renderedScale
  });
  extractionInputsRef.current = {
    file,
    parcelFile,
    parcelMode,
    controlPoints,
    activePage,
    snapToleranceInput,
    extractedLegend,
    renderedScale
  };

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
    () =>
      controlPoints.filter(
        (point) => point.confirmed && point.pdf.page === activePage
      ).length,
    [controlPoints, activePage]
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
        canvas.dataset.pdfPageWidth = String(unscaledViewport.width);
        canvas.dataset.pdfPageHeight = String(unscaledViewport.height);
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

  const suggestionsOnPage = useMemo(
    () =>
      suggestions
        .map((suggestion, index) => ({ suggestion, index }))
        .filter((entry) => entry.suggestion.pdf.page === activePage),
    [activePage, suggestions]
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
    [isCroppingMode, isDrawingCrop, cropStart]
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
        const pdfPage = docState ? await docState.getPage(activePage) : null;
        const scale = Number(canvas.dataset.pdfScale ?? renderedScale) || 1;
        const legend = await extractCalibratedLegendFromCrop({
          pdfPage,
          displayCanvas: canvas,
          cropBoxPx: { x, y, width, height },
          displayScale: scale
        });

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
            `Legend captured & calibrated: found ${legend.zones.length} zone${legend.zones.length === 1 ? '' : 's'}.`
          );
        } else {
          setLegendCropMessage(
            'Legend crop completed, but no zones were detected. Try zooming in and cropping tighter around the legend rows.'
          );
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
    [
      activePage,
      cropEnd,
      cropStart,
      docState,
      isDrawingCrop,
      renderedScale,
      setExtractedLegend
    ]
  );

  const handleExtractShapes = useCallback(async () => {
    if (
      !canvasRef.current ||
      !extractedLegend ||
      extractedLegend.zones.length === 0
    )
      return;

    const confirmedGCPs = controlPoints.filter(
      (p) => p.confirmed && p.pdf.page === activePage
    );
    if (confirmedGCPs.length < 3) {
      alert(
        'Cannot extract shapes: Please confirm at least 3 Ground Control Points (GCPs) first to allow coordinate transformation.'
      );
      return;
    }

    const snapToleranceMeters = Number(snapToleranceInput);
    if (
      parcelFile &&
      (!Number.isFinite(snapToleranceMeters) ||
        snapToleranceMeters < 0.5 ||
        snapToleranceMeters > 100)
    ) {
      setShapeExtractionMessage(
        'Parcel snap tolerance must be between 0.5 and 100 meters.'
      );
      return;
    }

    setIsExtractingShapes(true);
    try {
      const inputs = extractionInputsRef.current;
      const canvas = canvasRef.current;
      const scale = Number(canvas.dataset.pdfScale);
      if (
        canvas.dataset.pdfPage !== String(activePage) ||
        !Number.isFinite(scale) ||
        scale <= 0
      ) {
        throw new Error('Wait for the current PDF page to finish rendering.');
      }

      const pdfPage = docState ? await docState.getPage(activePage) : null;
      const pipelineResult = await runZoningExtractionPipeline({
        pdfPage,
        displayCanvas: canvas,
        displayScale: scale,
        legend: extractedLegend,
        confirmedControlPoints: confirmedGCPs,
        sourceName: file ? file.name : 'extracted_shapes',
        parcelFile,
        parcelMode,
        snapToleranceMeters,
        onStatus: (statusText) => {
          setShapeExtractionMessage(statusText);
          if (parcelFile) setParcelStatus(statusText);
        }
      });

      const currentInputs = extractionInputsRef.current;
      if (
        currentInputs.file !== inputs.file ||
        currentInputs.parcelFile !== inputs.parcelFile ||
        currentInputs.parcelMode !== inputs.parcelMode ||
        currentInputs.controlPoints !== inputs.controlPoints ||
        currentInputs.activePage !== inputs.activePage ||
        currentInputs.snapToleranceInput !== inputs.snapToleranceInput ||
        currentInputs.extractedLegend !== inputs.extractedLegend
      ) {
        throw new Error(
          'Extraction inputs changed. Please run extraction again.'
        );
      }

      if (pipelineResult.parcelStatusMessage) {
        setParcelStatus(pipelineResult.parcelStatusMessage);
      }

      setDigitizerFeatures((prev) => [...prev, ...pipelineResult.features]);
      setShapeExtractionMessage(pipelineResult.summaryMessage);
      alert(pipelineResult.summaryMessage);
    } catch (err) {
      console.error('Failed to extract shapes:', err);
      const message =
        err instanceof Error
          ? `Failed to extract shapes: ${err.message}`
          : 'Failed to extract shapes. See console for details.';
      setShapeExtractionMessage(message);
      if (parcelFile) setParcelStatus(message);
      alert(message);
    } finally {
      setIsExtractingShapes(false);
    }
  }, [
    activePage,
    controlPoints,
    docState,
    extractedLegend,
    file,
    parcelFile,
    parcelMode,
    setDigitizerFeatures,
    snapToleranceInput
  ]);

  const handleParcelFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const nextFile = input.files?.[0];
      if (!nextFile) return;
      setParcelFile(nextFile);
      setParcelStatus(
        `Selected ${nextFile.name}. Parcels will be scanned when shapes are extracted.`
      );
      setShapeExtractionMessage(null);
      input.value = '';
    },
    []
  );

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

  useEffect(() => {
    if (isPickingPdfPoint) cancelLegendCrop();
  }, [isPickingPdfPoint, cancelLegendCrop]);

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
      const pageWidth = Number(canvas.dataset.pdfPageWidth ?? '0');
      const pageHeight = Number(canvas.dataset.pdfPageHeight ?? '0');

      const x =
        pageWidth > 0 && rect.width > 0
          ? ((event.clientX - rect.left) / rect.width) * pageWidth
          : (event.clientX - rect.left) / Math.max(scale, 0.0001);
      const y =
        pageHeight > 0 && rect.height > 0
          ? ((event.clientY - rect.top) / rect.height) * pageHeight
          : (event.clientY - rect.top) / Math.max(scale, 0.0001);

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
          {onToggleMaximize && (
            <button
              type="button"
              onClick={onToggleMaximize}
              className="grid w-7 h-7 place-items-center text-gray-700 border border-gray-300 rounded hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
              aria-label={
                isMaximized
                  ? 'Restore split workspace'
                  : 'Maximize PDF workspace'
              }
              aria-pressed={isMaximized}
              title={
                isMaximized
                  ? 'Restore split workspace'
                  : 'Maximize PDF workspace'
              }
            >
              {isMaximized ? (
                <ExitFullScreenIcon aria-hidden="true" />
              ) : (
                <EnterFullScreenIcon aria-hidden="true" />
              )}
            </button>
          )}
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
                {zoomFactor !== null
                  ? `${Math.round(zoomFactor * 100)}%`
                  : 'Fit'}
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
      <input
        ref={parcelFileInputRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        onChange={handleParcelFileInput}
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
                : 'Click the matching location on this PDF page.'}
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
              {hasLegend ? (extractedLegend?.zones.length ?? 0) : 0} zones
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
                  disabled={isCroppingMode || isExtracting || isPickingPdfPoint}
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

              <div className="space-y-2 border-t border-gray-200 pt-3 dark:border-gray-700">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-100">
                      Parcel zoning &amp; boundary assistance
                    </p>
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      Streams parcels in the georeferenced PDF footprint and
                      classifies each parcel&apos;s interior zoning from vector
                      and high-DPI PDF layers (or snaps PDF outlines).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => parcelFileInputRef.current?.click()}
                    disabled={isExtractingShapes}
                    className="px-2.5 py-1.5 text-xs font-medium text-gray-800 border border-gray-300 rounded hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
                  >
                    {parcelFile
                      ? 'Replace parcel GeoJSON'
                      : 'Load parcel GeoJSON'}
                  </button>
                </div>
                {parcelStatus && (
                  <p
                    className="text-xs text-gray-700 dark:text-gray-200"
                    role="status"
                    aria-live="polite"
                  >
                    {parcelStatus}
                  </p>
                )}
                {parcelFile && (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <label
                        className="text-xs text-gray-700 dark:text-gray-200"
                        htmlFor="parcel-extraction-mode"
                      >
                        Parcel mode
                      </label>
                      <select
                        id="parcel-extraction-mode"
                        value={parcelMode}
                        onChange={(event) =>
                          setParcelMode(
                            event.currentTarget.value as ParcelExtractionMode
                          )
                        }
                        className="rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                      >
                        <option value="classify_parcels">
                          Classify individual parcels (highest accuracy)
                        </option>
                        <option value="dissolve_parcels">
                          Merge adjacent same-zone parcels
                        </option>
                        <option value="snap_outlines">
                          Snap PDF outlines only
                        </option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label
                        className="text-xs text-gray-700 dark:text-gray-200"
                        htmlFor="parcel-snap-tolerance"
                      >
                        Snap tolerance (meters)
                      </label>
                      <input
                        id="parcel-snap-tolerance"
                        type="number"
                        min="0.5"
                        max="100"
                        step="0.5"
                        value={snapToleranceInput}
                        onChange={(event) =>
                          setSnapToleranceInput(event.currentTarget.value)
                        }
                        className="w-20 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                      />
                    </div>
                  </div>
                )}
                {shapeExtractionMessage && (
                  <p
                    className="text-xs text-gray-700 dark:text-gray-200"
                    role="status"
                    aria-live="polite"
                  >
                    {shapeExtractionMessage}
                  </p>
                )}
              </div>

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
            {(pointsOnPage.length > 0 ||
              suggestionsOnPage.length > 0 ||
              pendingPointOnPage) &&
              renderedSize.width > 0 && (
                <div className="absolute inset-0 pointer-events-none">
                  {suggestionsOnPage.map(({ suggestion, index }) => (
                    <div
                      key={suggestion.id}
                      className="absolute -translate-x-1/2 -translate-y-1/2 px-1 h-5 min-w-5 rounded-full border border-dashed border-white bg-purple-600/90 text-[9px] font-bold text-white flex items-center justify-center shadow"
                      style={{
                        left: suggestion.pdf.x * renderedScale,
                        top: suggestion.pdf.y * renderedScale
                      }}
                      aria-label={`Suggested point S${index + 1} on page ${activePage}`}
                      title={`S${index + 1}: ${suggestion.rationale}`}
                    >
                      S{index + 1}
                    </div>
                  ))}
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
                        disabled={isPickingPdfPoint}
                        onClick={(event) => {
                          event.stopPropagation();
                          onControlPointClick?.(point.id);
                        }}
                        className={`${
                          isActive
                            ? 'absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 border-black text-[10px] font-semibold text-black shadow'
                            : point.confirmed
                              ? 'absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-black/70 bg-emerald-400 text-[10px] font-semibold text-black shadow'
                              : 'absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-black/70 bg-sky-300 text-[10px] font-semibold text-black shadow'
                        } ${isPickingPdfPoint ? 'pointer-events-none' : 'pointer-events-auto'}`}
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
