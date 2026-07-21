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

/** How an overlap between two features is classified. */
export type OverlapType =
  | 'duplicate'
  | 'containment'
  | 'sliver'
  | 'significant';

/** A detected overlap between two digitizer features. */
export interface OverlapIssue {
  /** ID of the first feature. */
  featureAId: string;
  /** ID of the second feature. */
  featureBId: string;
  /** Classification of the overlap severity and kind. */
  overlapType: OverlapType;
  /** Overlap area in square meters. */
  overlapAreaM2: number;
  /**
   * Fraction of the smaller feature's area covered by the overlap (0–1).
   * High values indicate near-duplicate or containment.
   */
  overlapFraction: number;
  /** Human-readable description suitable for display in a UI error panel. */
  description: string;
}

/** The result of running overlap detection and optional auto-repair on a feature set. */
export interface OverlapRepairResult {
  /** All overlap issues detected before any repair was attempted. */
  issues: OverlapIssue[];
  /**
   * Features as they stand after auto-repair.
   * Only features that were mutated appear here.
   * A `null` value means the feature was removed (e.g., the losing half of a duplicate pair).
   */
  repairedFeatures: Map<string, DigitizerFeature | null>;
  /**
   * Issues that could not be auto-repaired and require human intervention.
   * These must be resolved before export.
   */
  unresolvedIssues: OverlapIssue[];
}
