import { logger } from '@onecare/observability';

export interface EmergencyHandoffDetails {
  callId: string;
  reason: string;
  triggeredAt: number;
  correlationId?: string;
  practiceId?: string;
  patientId?: string | null;
  metadata?: Record<string, unknown>;
}

export type EmergencyHandoffHandler = (details: EmergencyHandoffDetails) => Promise<void> | void;

const defaultHandler: EmergencyHandoffHandler = async (details) => {
  logger.warn('telephony.emergency.handoff.stub', { ...details });
};

let activeHandler: EmergencyHandoffHandler = defaultHandler;

/**
 * Execute the registered emergency handoff handler.
 */
export async function executeEmergencyHandoff(details: EmergencyHandoffDetails): Promise<void> {
  await Promise.resolve(activeHandler(details));
}

/**
 * Allows tests to override the emergency handoff handler.
 */
export function setEmergencyHandoffHandler(handler?: EmergencyHandoffHandler): void {
  activeHandler = handler ?? defaultHandler;
}
