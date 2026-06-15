import { nanoid } from 'nanoid';

export interface GeorefSuggestion {
  id: string;
  pdf: {
    x: number;
    y: number;
    page: number;
  };
  map: {
    lon: number;
    lat: number;
  };
  confidence: number;
  rationale: string;
}

export interface GeorefSuggestionRequest {
  page: number;
  mapCenter: {
    lon: number;
    lat: number;
  };
  mapBounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
}

export interface GeorefSuggestionAdapter {
  suggestPoints(request: GeorefSuggestionRequest): Promise<GeorefSuggestion[]>;
}

/**
 * TODO(phase-3): Replace heuristic output with model-backed landmark matching.
 */
export class HeuristicGeorefSuggestionAdapter
  implements GeorefSuggestionAdapter
{
  async suggestPoints(
    request: GeorefSuggestionRequest
  ): Promise<GeorefSuggestion[]> {
    const { mapCenter, mapBounds, page } = request;
    const width = Math.max(mapBounds.east - mapBounds.west, 0.00001);
    const height = Math.max(mapBounds.north - mapBounds.south, 0.00001);

    const templates = [
      {
        pdf: { x: 300, y: 220 },
        map: {
          lon: mapCenter.lon - width * 0.22,
          lat: mapCenter.lat + height * 0.18
        },
        confidence: 0.52,
        rationale: 'Estimated from upper-left landmark cluster and viewport extent'
      },
      {
        pdf: { x: 980, y: 240 },
        map: {
          lon: mapCenter.lon + width * 0.21,
          lat: mapCenter.lat + height * 0.19
        },
        confidence: 0.49,
        rationale: 'Estimated from upper-right landmark cluster and viewport extent'
      },
      {
        pdf: { x: 320, y: 980 },
        map: {
          lon: mapCenter.lon - width * 0.2,
          lat: mapCenter.lat - height * 0.2
        },
        confidence: 0.47,
        rationale: 'Estimated from lower-left landmark cluster and viewport extent'
      },
      {
        pdf: { x: 980, y: 1020 },
        map: {
          lon: mapCenter.lon + width * 0.2,
          lat: mapCenter.lat - height * 0.2
        },
        confidence: 0.45,
        rationale: 'Estimated from lower-right landmark cluster and viewport extent'
      }
    ];

    return templates.map((template) => ({
      id: nanoid(10),
      pdf: {
        ...template.pdf,
        page
      },
      map: template.map,
      confidence: template.confidence,
      rationale: template.rationale
    }));
  }
}

export const defaultGeorefSuggestionAdapter: GeorefSuggestionAdapter =
  new HeuristicGeorefSuggestionAdapter();
