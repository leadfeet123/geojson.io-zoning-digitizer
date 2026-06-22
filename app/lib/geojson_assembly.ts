import { transformPoint, type AffineTransform, type PdfCoordinate } from './transform_engine';
import type { FeatureCollection, Feature, Polygon, Position } from 'geojson';

export interface OptimizedPolygon {
  zoning_id: string;
  coordinates: PdfCoordinate[];
}

export interface ZoningMetadata {
  [zoning_id: string]: {
    zone_code: string;
    color: string;
    description?: string;
    [key: string]: any; // Allow other properties like notes, confidence, etc.
  };
}

/**
 * Converts optimized pixel-based polygons into a final GeoJSON FeatureCollection,
 * applying the affine transform for coordinates and injecting metadata.
 *
 * @param pixelPolygons The optimized array of pixel-based polygons.
 * @param transform The Affine Transformation Matrix.
 * @param metadata The JSON object of zoning metadata.
 * @returns A valid GeoJSON FeatureCollection.
 */
export function assembleZoningGeoJSON(
  pixelPolygons: OptimizedPolygon[],
  transform: AffineTransform,
  metadata: ZoningMetadata
): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = pixelPolygons.map((poly) => {
    // 1. Transform coordinates
    const geoCoords: Position[] = poly.coordinates.map((pixelCoord) => {
      const lonLat = transformPoint(transform, pixelCoord);
      return [lonLat.lon, lonLat.lat];
    });

    // 2. Ensure properly closed geometries
    if (geoCoords.length > 0) {
      const firstCoord = geoCoords[0];
      const lastCoord = geoCoords[geoCoords.length - 1];
      if (firstCoord[0] !== lastCoord[0] || firstCoord[1] !== lastCoord[1]) {
        geoCoords.push([...firstCoord]);
      }
    }

    // 3. Match zoning identifier and inject properties
    const polyMetadata = metadata[poly.zoning_id] || {};

    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [geoCoords] // Polygons have an array of linear rings
      },
      properties: {
        zoning_id: poly.zoning_id, // keep the id just in case
        ...polyMetadata
      }
    };
  });

  return {
    type: 'FeatureCollection',
    features
  };
}
