import { MapContext } from 'app/context/map_context';
import mapboxgl from 'mapbox-gl';
import { useAtom, useSetAtom } from 'jotai';
import { nanoid } from 'nanoid';
import { useContext, useEffect } from 'react';
import {
  controlPointPlacementModeAtom,
  controlPointsAtom,
  pendingPdfPointAtom,
  relocatingTargetAtom
} from 'state/control_points';

/**
 * Listens for a single map click while a PDF point is pending and records a control point pair.
 */
export function ControlPointMapCapture() {
  const pmap = useContext(MapContext);
  const [placementMode, setPlacementMode] = useAtom(
    controlPointPlacementModeAtom
  );
  const [pendingPdfPoint, setPendingPdfPoint] = useAtom(pendingPdfPointAtom);
  const setControlPoints = useSetAtom(controlPointsAtom);
  const [relocatingTarget] = useAtom(relocatingTargetAtom);

  useEffect(() => {
    const map = pmap?.map;

    // Do not add a new point while a relocation is in progress.
    if (
      !map ||
      placementMode !== 'awaiting_map' ||
      !pendingPdfPoint ||
      relocatingTarget !== null
    ) {
      return;
    }

    const priorCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = 'crosshair';

    const onClick = (event: mapboxgl.MapMouseEvent) => {
      setControlPoints((current) => [
        ...current,
        {
          id: nanoid(10),
          pdf: pendingPdfPoint,
          map: {
            lon: event.lngLat.lng,
            lat: event.lngLat.lat
          },
          confirmed: false
        }
      ]);
      setPendingPdfPoint(null);
      setPlacementMode('idle');
    };

    map.once('click', onClick);

    return () => {
      map.off('click', onClick);
      map.getCanvas().style.cursor = priorCursor;
    };
  }, [
    pmap,
    placementMode,
    pendingPdfPoint,
    relocatingTarget,
    setControlPoints,
    setPendingPdfPoint,
    setPlacementMode
  ]);

  return null;
}
