// AUTO-GENERATED from schemas. DO NOT EDIT.

/**
 * Authoritative registry of feature entities, join keys, and materialisation rules.
 */
export interface FeatureRegistry {
  /**
   * Semantic version of the registry metadata.
   */
  version: string;
  /**
   * Entity definitions used as join keys for feature sets.
   *
   * @minItems 1
   */
  entities: [Entity, ...Entity[]];
  /**
   * Registered feature sets and their schemas.
   *
   * @minItems 1
   */
  featureSets: [FeatureSet, ...FeatureSet[]];
}
export interface Entity {
  /**
   * CamelCase entity identifier (e.g., patient, triageCase).
   */
  name: string;
  /**
   * Summary of the entity and how it is derived.
   */
  description: string;
  /**
   * Primary join keys (ordered by precedence).
   *
   * @minItems 1
   */
  keys: [string, ...string[]];
  /**
   * Optional surrogate identifiers stored alongside natural keys.
   */
  surrogateKeys?: string[];
  /**
   * PII/PHI classification for the entity identifiers.
   */
  piiClassification: "none" | "limited" | "phi";
}
export interface FeatureSet {
  /**
   * Kebab-case feature set identifier.
   */
  name: string;
  /**
   * Human-readable title.
   */
  title: string;
  /**
   * Entity name (from entities[].name) this feature set is keyed on.
   */
  entity: string;
  /**
   * Canonical schema identifier for the payload.
   */
  schemaId: string;
  /**
   * Purpose of the feature set and typical consumers.
   */
  description: string;
  /**
   * Data classification for payload fields.
   */
  classification: "phi" | "pii" | "deidentified";
  /**
   * Owning teams or service groups.
   *
   * @minItems 1
   */
  owners: [string, ...string[]];
  /**
   * Upstream systems or jobs producing this feature set.
   *
   * @minItems 1
   */
  sources: [string, ...string[]];
  /**
   * Freshness SLO and expiry configuration.
   */
  freshness: {
    /**
     * Maximum tolerated age (minutes) for the latest feature snapshot.
     */
    slaMinutes: number;
    /**
     * Hard expiry after which the feature snapshot must be recomputed.
     */
    expiryMinutes?: number;
  };
  /**
   * Offline/online materialisation strategy for this feature set.
   */
  materialization: {
    offline: {
      /**
       * Primary file/storage format.
       */
      format: "parquet" | "delta";
      /**
       * Partition columns used for offline storage.
       *
       * @minItems 1
       */
      partitioning: [string, ...string[]];
      /**
       * Name of the point-in-time table/view.
       */
      pitTable: string;
    };
    online?: {
      /**
       * Target online store implementation (e.g., redis, memory).
       */
      store: string;
      /**
       * Default TTL for online entries in seconds.
       */
      ttlSeconds?: number;
    };
  };
  /**
   * Search or governance tags.
   */
  tags?: string[];
}
