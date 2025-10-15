// AUTO-GENERATED from schemas. DO NOT EDIT.

/**
 * Feature vector used for prioritising triage submissions. All values are normalised to the range [0, 1] unless specified otherwise.
 */
export interface TriageCoreFeatures {
  /**
   * Semantic version of the feature payload. Bump on backwards-incompatible changes.
   */
  schemaVersion: string;
  /**
   * Timestamp when the feature vector was produced (UTC).
   */
  generatedAt: string;
  /**
   * Predicted emergency probability or severity score.
   */
  acuity?: number;
  /**
   * Risk-of-deterioration signal derived from patient history.
   */
  risk?: number;
  /**
   * Operational complexity estimate capturing comorbidities and care coordination needs.
   */
  complexity?: number;
  /**
   * Time-sensitivity score (e.g., symptom onset, follow-up deadlines).
   */
  time?: number;
  /**
   * Signal representing provider/network capacity constraints.
   */
  capacity?: number;
  /**
   * Weighted score computed from the component features.
   */
  compositeScore?: number;
  /**
   * Identifier of the pipeline or model that produced the feature vector.
   */
  source?: string;
  /**
   * Optional expiry timestamp (UTC) after which the vector should be refreshed.
   */
  expiresAt?: string;
  /**
   * Reserved for additive signals that do not yet justify a schema bump. Keys must be lowerCamelCase.
   */
  extensions?: {
    [k: string]: number | string | boolean | null;
  };
}
