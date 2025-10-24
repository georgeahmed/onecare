// AUTO-GENERATED from schemas. DO NOT EDIT.

/**
 * Resulting portal availability state.
 */
export type PortalState = "UP" | "DOWN" | "OOH";

/**
 * Notification of portal state change for a practice.
 */
export interface PortalNotify {
  /**
   * Stable practice identifier (no PHI).
   */
  practiceId: string;
  state: PortalState;
  /**
   * Machine-readable reason (e.g., CORE_HOURS, MAINTENANCE, CONFIG_INVALID).
   */
  reasonCode?: string;
  /**
   * Timestamp for the observed state change (UTC).
   */
  at: string;
}
