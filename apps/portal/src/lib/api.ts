import { v4 as uuidv4 } from 'uuid';
import type { ErrorEnvelope, PortalSubmission, SafetyDecision } from './types';

export interface SubmitIntakeOptions {
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export interface SubmitIntakeResult {
  decision: SafetyDecision;
  correlationId?: string;
};

export const submitIntake = async (
  payload: PortalSubmission,
  options: SubmitIntakeOptions = {}
): Promise<SubmitIntakeResult> => {
  const baseUrl = options.baseUrl ?? import.meta.env.VITE_ORCH_URL ?? 'http://localhost:3001';
  const url = new URL('/safety-check', baseUrl).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const externalSignal = options.signal;
  let externalAbortHandler: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  const requestCorrelationId = uuidv4();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-correlation-id': requestCorrelationId
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const responseCorrelation = response.headers.get('x-correlation-id') ?? requestCorrelationId;

    if (response.ok) {
      const decision = (await response.json()) as SafetyDecision;
      return {
        decision,
        correlationId: responseCorrelation ?? undefined
      };
    }

    let envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope;
    if (!envelope || typeof envelope !== 'object' || !('error' in envelope)) {
      envelope = {
        error: {
          code: 'internal_error',
          message: `Request failed with status ${response.status}`
        }
      };
    }
    if (!envelope.correlationId && responseCorrelation) {
      envelope.correlationId = responseCorrelation;
    }
    throw Object.assign(new Error('Request failed'), {
      response,
      envelope
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      const timeoutEnvelope: ErrorEnvelope = {
        error: {
          code: 'upstream_timeout',
          message: 'The request timed out before completing.'
        },
        correlationId: requestCorrelationId
      };
      const abortError = new Error('Request timed out');
      Object.assign(abortError, { envelope: timeoutEnvelope });
      throw abortError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
};
