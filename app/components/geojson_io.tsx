import { Dialogs } from 'app/components/dialogs';
import Drop from 'app/components/drop';
import { ControlPointMapCapture } from 'app/components/control_points/ControlPointMapCapture';
import { ControlPointsPanel } from 'app/components/control_points/ControlPointsPanel';
import { PdfViewer } from 'app/components/pdf_viewer/PdfViewer';
import { DigitizerFeaturePanel } from 'app/components/feature_editor';
import { MapComponent } from 'app/components/map_component';
import { MenuBar } from 'app/components/menu_bar';
import FeatureEditor from './panels/feature_editor';
import Modes from 'app/components/modes';
import type PMap from 'app/lib/pmap';
import 'styles/globals.css';
import 'core-js/features/array/at';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { restrictToWindowEdges } from '@dnd-kit/modifiers';
import { UpdateIcon } from '@radix-ui/react-icons';
import ContextActions from 'app/components/context_actions';
import { ErrorBoundary } from 'app/components/elements';
import { Keybindings } from 'app/components/keybindings';
import { Legend } from 'app/components/legend';
import Notifications from 'app/components/notifications';
import { SidePanel, BottomPanel } from 'app/components/panels';
import {
  BottomResizer,
  Resizer,
  useBigScreen,
  useWindowResizeSplits
} from 'app/components/resizer';
import { MapContext } from 'app/context/map_context';
import clsx from 'clsx';
import { atom, useAtom, useAtomValue } from 'jotai';
import debounce from 'lodash/debounce';
import { Tooltip as T } from 'radix-ui';
import SearchBoxButton from './search/search_box_button';
import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { Button } from './elements';
import { FeatureEditorFolder } from './panels/feature_editor/feature_editor_folder';
import { Visual } from './visual';
import { UrlAPI } from './url_api';
import {
  activePdfAtom,
  activePdfPageAtom,
  digitizerModeAtom
} from 'state/digitizer';
import {
  activeControlPointIdAtom,
  controlPointPlacementModeAtom,
  controlPointsAtom,
  pendingPdfPointAtom
} from 'state/control_points';
import { splitsAtom, styleOptionsAtom } from 'state/jotai';
import mapboxgl from 'mapbox-gl';

export type ResolvedLayout = 'HORIZONTAL' | 'VERTICAL';

interface Transform {
  x: number;
  y: number;
}

const persistentTransformAtom = atom<Transform>({
  x: 5,
  y: 5
});

function createControlPointFocusMarkerElement(): HTMLDivElement {
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className = 'geojsonio-control-point-marker';

  return marker;
}

function updateControlPointMarkerElement(
  marker: HTMLButtonElement,
  index: number,
  isConfirmed: boolean,
  isActive: boolean
): void {
  marker.className = [
    'geojsonio-control-point-marker',
    isConfirmed
      ? 'geojsonio-control-point-marker-confirmed'
      : 'geojsonio-control-point-marker-unconfirmed',
    isActive ? 'geojsonio-control-point-marker-active' : ''
  ]
    .filter(Boolean)
    .join(' ');

  marker.textContent = String(index + 1);
  marker.setAttribute('aria-label', `Control point ${index + 1}`);
  marker.title = `Control point ${index + 1}`;
}

function clearControlPointMarkers(markers: Map<string, mapboxgl.Marker>): void {
  markers.forEach((marker) => {
    marker.remove();
  });
  markers.clear();
}

export function GeojsonIO() {
  const [map, setMap] = useState<PMap | null>(null);
  useWindowResizeSplits();
  const splits = useAtomValue(splitsAtom);
  const [activePdf, setActivePdf] = useAtom(activePdfAtom);
  const [activePdfPage, setActivePdfPage] = useAtom(activePdfPageAtom);
  const [controlPointPlacementMode, setControlPointPlacementMode] = useAtom(
    controlPointPlacementModeAtom
  );
  const [controlPoints] = useAtom(controlPointsAtom);
  const [activeControlPointId, setActiveControlPointId] = useAtom(
    activeControlPointIdAtom
  );
  const [pendingPdfPoint, setPendingPdfPoint] = useAtom(pendingPdfPointAtom);
  const digitizerMode = useAtomValue(digitizerModeAtom);
  const [styleOptions, setStyleOptions] = useAtom(styleOptionsAtom);
  const isBigScreen = useBigScreen();
  const controlPointMarkersRef = useRef<Map<string, mapboxgl.Marker>>(
    new globalThis.Map()
  );
  const projectionBeforeDigitizerRef = useRef<'globe' | 'mercator' | null>(
    null
  );

  const layout: ResolvedLayout = isBigScreen ? 'HORIZONTAL' : 'VERTICAL';

  const sensor = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 2
      }
    })
  );

  const [persistentTransform, setPersistentTransform] = useAtom(
    persistentTransformAtom
  );

  const focusControlPoint = useCallback(
    (controlPointId: string) => {
      const point = controlPoints.find((entry) => entry.id === controlPointId);
      if (!point) {
        return;
      }

      setActiveControlPointId(controlPointId);

      const mapboxMap = map?.map;
      if (!mapboxMap) {
        return;
      }

      const nextZoom = Math.max(mapboxMap.getZoom(), 14);
      mapboxMap.flyTo({
        center: [point.map.lon, point.map.lat],
        zoom: nextZoom,
        essential: true
      });
    },
    [controlPoints, map, setActiveControlPointId]
  );

  useEffect(() => {
    if (digitizerMode) {
      if (styleOptions.mapProjection !== 'mercator') {
        if (projectionBeforeDigitizerRef.current === null) {
          projectionBeforeDigitizerRef.current = styleOptions.mapProjection;
        }

        setStyleOptions((current) => ({
          ...current,
          mapProjection: 'mercator'
        }));
      }

      return;
    }

    const previousProjection = projectionBeforeDigitizerRef.current;
    if (
      previousProjection &&
      styleOptions.mapProjection === 'mercator' &&
      previousProjection !== 'mercator'
    ) {
      setStyleOptions((current) => ({
        ...current,
        mapProjection: previousProjection
      }));
    }
    projectionBeforeDigitizerRef.current = null;
  }, [digitizerMode, setStyleOptions, styleOptions.mapProjection]);

  useEffect(() => {
    const mapboxMap = map?.map;
    const markerMap = controlPointMarkersRef.current;

    if (!mapboxMap) {
      clearControlPointMarkers(markerMap);
      return;
    }

    const markerIds = new Set(controlPoints.map((point) => point.id));

    markerMap.forEach((marker, markerId) => {
      if (markerIds.has(markerId)) {
        return;
      }

      marker.remove();
      markerMap.delete(markerId);
    });

    controlPoints.forEach((point, index) => {
      const existing = markerMap.get(point.id);
      const isActive = point.id === activeControlPointId;

      if (existing) {
        existing.setLngLat([point.map.lon, point.map.lat]);
        const existingElement = existing.getElement();
        if (existingElement instanceof HTMLButtonElement) {
          updateControlPointMarkerElement(
            existingElement,
            index,
            point.confirmed,
            isActive
          );
        }
        return;
      }

      const markerElement = createControlPointFocusMarkerElement();
      updateControlPointMarkerElement(
        markerElement,
        index,
        point.confirmed,
        isActive
      );
      markerElement.addEventListener('click', () => {
        focusControlPoint(point.id);
      });

      const marker = new mapboxgl.Marker({
        element: markerElement,
        anchor: 'center'
      })
        .setLngLat([point.map.lon, point.map.lat])
        .addTo(mapboxMap);

      markerMap.set(point.id, marker);
    });
  }, [activeControlPointId, controlPoints, focusControlPoint, map]);

  useEffect(() => {
    if (
      activeControlPointId &&
      !controlPoints.some((point) => point.id === activeControlPointId)
    ) {
      setActiveControlPointId(null);
    }
  }, [activeControlPointId, controlPoints, setActiveControlPointId]);

  useEffect(() => {
    const markerMap = controlPointMarkersRef.current;

    return () => {
      clearControlPointMarkers(markerMap);
    };
  }, []);

  return (
    <main className="h-screen flex flex-col bg-white dark:bg-gray-800">
      <T.Provider>
        <MapContext.Provider value={map}>
          <ErrorBoundary
            fallback={(props) => {
              return (
                <div className="h-20 flex items-center justify-center px-2 gap-x-2">
                  An error occurred
                  <Button onClick={() => props.resetError()}>
                    <UpdateIcon /> Try again
                  </Button>
                </div>
              );
            }}
          >
            <div>
              <MenuBar />
              <div
                className="flex flex-row items-center justify-start overflow-x-auto sm:overflow-visible
          border-t border-gray-200 dark:border-gray-900 px-2 h-12"
              >
                <Modes replaceGeometryForId={null} />
                <div className="flex-auto" />
                <ContextActions />
                <div className="flex-auto" />
                <div className="flex items-center space-x-2">
                  <Visual />
                </div>
              </div>
            </div>
          </ErrorBoundary>
          {digitizerMode ? (
            <div className="flex flex-auto relative border-t border-gray-200 dark:border-gray-900 overflow-hidden">
              <div className="w-[45%] min-w-[320px] max-w-[720px] flex flex-col">
                <PdfViewer
                  file={activePdf?.file ?? null}
                  page={activePdfPage}
                  isPickingPdfPoint={
                    controlPointPlacementMode === 'awaiting_pdf'
                  }
                  pendingPdfPoint={pendingPdfPoint}
                  controlPoints={controlPoints}
                  activeControlPointId={activeControlPointId}
                  onPageChange={setActivePdfPage}
                  onPageCountChange={(pageCount) => {
                    setActivePdf((current) => {
                      if (!current) {
                        return current;
                      }

                      return {
                        ...current,
                        pageCount
                      };
                    });
                  }}
                  onFileSelect={(file) => {
                    setActivePdf({
                      file,
                      pageCount: 1
                    });
                    setActivePdfPage(1);
                  }}
                  onPdfCoordinatePick={(coords) => {
                    if (controlPointPlacementMode !== 'awaiting_pdf') {
                      return;
                    }

                    setPendingPdfPoint(coords);
                    setControlPointPlacementMode('awaiting_map');
                  }}
                  onControlPointClick={focusControlPoint}
                />
                <ControlPointsPanel onControlPointClick={focusControlPoint} />
              </div>
              <div className="flex-1 flex relative overflow-hidden">
                <LayoutWorkspace
                  digitizerMode={digitizerMode}
                  layout={layout}
                  persistentTransform={persistentTransform}
                  sensor={sensor}
                  setPersistentTransform={setPersistentTransform}
                  setMap={setMap}
                />
              </div>
              <ControlPointMapCapture />
            </div>
          ) : (
            <LayoutWorkspace
              digitizerMode={digitizerMode}
              layout={layout}
              persistentTransform={persistentTransform}
              sensor={sensor}
              setPersistentTransform={setPersistentTransform}
              setMap={setMap}
            />
          )}
          <Drop />
          <UrlAPI />
          <Dialogs />
          <Suspense fallback={null}>
            <Keybindings />
          </Suspense>
          <Notifications />
        </MapContext.Provider>
      </T.Provider>
    </main>
  );
}

function LayoutWorkspace({
  digitizerMode,
  layout,
  setMap,
  sensor,
  setPersistentTransform,
  persistentTransform
}: {
  digitizerMode: boolean;
  layout: ResolvedLayout;
  setMap: (arg0: PMap | null) => void;
  sensor: ReturnType<typeof useSensors>;
  persistentTransform: Transform;
  setPersistentTransform: (
    updater: (transform: Transform) => Transform
  ) => void;
}) {
  return (
    <div
      className={clsx(
        layout === 'VERTICAL' && 'flex-col',
        'flex flex-auto relative border-t border-gray-200 dark:border-gray-900 overflow-hidden'
      )}
    >
      {layout === 'HORIZONTAL' ? <FeatureEditorFolder /> : null}
      <DndContext
        sensors={sensor}
        modifiers={[restrictToWindowEdges]}
        onDragEnd={(end) => {
          setPersistentTransform((transform) => {
            return {
              x: transform.x + end.delta.x,
              y: transform.y + end.delta.y
            };
          });
        }}
      >
        <Map
          digitizerMode={digitizerMode}
          persistentTransform={persistentTransform}
          setMap={setMap}
          layout={layout}
        />
      </DndContext>
      {layout === 'HORIZONTAL' ? (
        <>
          <SidePanel />
          <Resizer side="left" />
          <Resizer side="right" />
        </>
      ) : layout === 'VERTICAL' ? (
        <>
          <BottomPanel layout={layout} />
          <BottomResizer />
        </>
      ) : null}
    </div>
  );
}

function Map({
  digitizerMode,
  layout,
  setMap
}: {
  digitizerMode: boolean;
  layout: ResolvedLayout;
  setMap: (arg0: PMap | null) => void;
  persistentTransform: Transform;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { setNodeRef } = useDraggable({
    id: 'map'
  });

  useMapResize(containerRef.current);

  return (
    <div
      className={'relative flex-auto flex flex-col overflow-hidden'}
      ref={(elem) => {
        setNodeRef(elem);
        containerRef.current = elem;
      }}
    >
      <div className="flex-auto relative">
        <SearchBoxButton />
        <MapComponent setMap={setMap} />
        <Legend />
      </div>
      {/* Feature Editor bottom of map */}
      {layout === 'HORIZONTAL' &&
        (digitizerMode ? (
          <DigitizerFeaturePanel />
        ) : (
          <FeatureEditor layout={layout} />
        ))}
    </div>
  );
}

function useMapResize(element: HTMLElement | null) {
  const pmap = useContext(MapContext);

  useLayoutEffect(() => {
    if (element) {
      element.style.width = '';
      element.style.height = '';
    }
    pmap?.map?.resize();
  }, [element, pmap]);

  useLayoutEffect(() => {
    if (element) {
      const callback = debounce((entries: ResizeObserverEntry[]) => {
        if (!Array.isArray(entries)) {
          return;
        }

        if (!entries.length) {
          return;
        }

        pmap?.map?.resize();
      }, 50);

      const resizeObserver = new ResizeObserver(callback);
      resizeObserver.observe(element, { box: 'border-box' });
      return () => resizeObserver.unobserve(element);
    } else {
      // Nothing
    }
  }, [element, pmap]);
}
