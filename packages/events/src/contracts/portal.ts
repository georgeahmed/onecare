// AUTO-GENERATED from schemas. DO NOT EDIT.\n

/**
 * Notification of portal state change for a practice.
 */
export interface PortalNotify {
  /**
   * Stable practice identifier (no PHI).
   */
  practiceId: string;
  /**
   * Resulting portal availability state.
   */
  state: "UP" | "DOWN" | "OOH";
  /**
   * Machine-readable reason (e.g., CORE_HOURS, MAINTENANCE, CONFIG_INVALID).
   */
  reasonCode?: string;
  /**
   * Timestamp for the observed state change (UTC).
   */
  at: string;
}
