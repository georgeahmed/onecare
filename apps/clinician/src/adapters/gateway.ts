import type { QueueAuthContext, QueueGateway } from './queue.types';
import { MockQueueGateway } from './queue.mock';
import { HttpQueueGateway } from './queue.http';
import { QueueGatewayError } from './queue.types';

const authContextRef: QueueAuthContext = {};

class UnconfiguredQueueGateway implements QueueGateway {
  setAuthContext(): void {
    // no-op
  }

  private error(): QueueGatewayError {
    return new QueueGatewayError('network', 'Queue gateway is not configured', undefined);
  }

  list(): Promise<{ items: any[]; nextCursor?: string | undefined }> {
    return Promise.reject(this.error());
  }
  getById(): Promise<any> {
    return Promise.reject(this.error());
  }
  assign(): Promise<any> {
    return Promise.reject(this.error());
  }
  unassign(): Promise<any> {
    return Promise.reject(this.error());
  }
  resolve(): Promise<any> {
    return Promise.reject(this.error());
  }
  scheduleCallback(): Promise<any> {
    return Promise.reject(this.error());
  }
  bookSlot(): Promise<any> {
    return Promise.reject(this.error());
  }
  assistedOutcome(): Promise<any> {
    return Promise.reject(this.error());
  }
  recordCall(): Promise<any> {
    return Promise.reject(this.error());
  }
  escalate(): Promise<any> {
    return Promise.reject(this.error());
  }
  recommendWindows(): Promise<any> {
    return Promise.reject(this.error());
  }
}

const createDefaultGateway = (): QueueGateway => {
  const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined;
  const mode = env?.MODE ?? 'development';
  const queueBase = env?.VITE_QUEUE_API_URL as string | undefined;
  const target = env?.VITE_QUEUE_GATEWAY ?? (queueBase ? 'http' : mode === 'production' ? 'http' : 'mock');
  const bookingBase = env?.VITE_BOOKING_API_URL as string | undefined;

  if (target === 'mock') {
    if (mode === 'production') {
      console.warn('Mock gateway not allowed in production without explicit override.');
      return new UnconfiguredQueueGateway();
    }
    return new MockQueueGateway();
  }

  if (target === 'http' || target === 'assisted') {
    if (!queueBase) {
      console.error('Queue API URL is missing; set VITE_QUEUE_API_URL to enable clinician queue.');
      return new UnconfiguredQueueGateway();
    }
    return new HttpQueueGateway({
      queueBaseUrl: queueBase,
      bookingBaseUrl: bookingBase,
      authProvider: () => authContextRef
    });
  }

  console.warn(`Queue gateway "${target}" is not recognized; refusing to use mock.`);
  return new UnconfiguredQueueGateway();
};

let instance: QueueGateway = createDefaultGateway();

export const queueGateway = {
  get current(): QueueGateway {
    return instance;
  }
};

export const setQueueGateway = (g: QueueGateway) => {
  instance = g;
  instance.setAuthContext(authContextRef);
};

export const setQueueGatewayAuth = (context: QueueAuthContext) => {
  authContextRef.userId = context.userId;
  authContextRef.token = context.token;
  authContextRef.clinicId = context.clinicId;
  instance.setAuthContext(authContextRef);
};
