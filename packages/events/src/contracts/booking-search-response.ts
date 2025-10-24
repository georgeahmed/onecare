// AUTO-GENERATED from schemas. DO NOT EDIT.

/**
 * Normalized booking slots returned after applying enhanced access policy filters.
 */
export interface BookingSearchResponse {
  /**
   * Slots that passed the enhanced access filters.
   */
  slots: SlotView[];
  /**
   * Slots rejected by the policy along with reason codes.
   */
  rejectedSlots?: RejectedSlot[];
}
export interface SlotView {
  id: string;
  start: string;
  end: string;
  organisationId: string;
  serviceType?: string | null;
}
export interface RejectedSlot {
  slot: SlotView;
  /**
   * @minItems 1
   */
  reasons: [string, ...string[]];
}
