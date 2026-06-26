import type { MultiPolygon, Polygon } from 'types';

export interface AiSuggestionDecision {
  action: 'accepted' | 'rejected' | 'overridden';
  timestamp: string;
}

export interface AiSuggestion {
  field: 'raw_zoning_label' | 'planning_class';
  value: string;
  confidence: number;
  accepted: boolean | null;
  decision_history?: AiSuggestionDecision[];
}

export interface DigitizerFeature {
  id: string;
  geometry: Polygon | MultiPolygon;
  properties: {
    planning_class: string;
    raw_zoning_label: string;
    confidence: number;
    source_type: 'digitized';
    source_name: string;
    human_confirmed: boolean;
    notes?: string;
    digitized_at?: string;
    digitized_by?: string;
    ai_suggestions?: AiSuggestion[];
  };
}

export interface ValidationResult {
  featureId: string | null;
  severity: 'error' | 'warning';
  message: string;
  field?: string;
}
