import type { QueueGateway } from './queue.types';
import { MockQueueGateway } from './queue.mock';
import { HttpAssistedBookingGateway } from './queue.http';

const createDefaultGateway = (): QueueGateway => {
  const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined;
  const target = env?.VITE_QUEUE_GATEWAY;
  const bookingBase = env?.VITE_BOOKING_API_URL as string | undefined;

  if (bookingBase) {
    return new HttpAssistedBookingGateway({ bookingBaseUrl: bookingBase });
  }

  if (target === 'assisted') {
    const base = env?.VITE_BOOKING_API_URL || '/api';
    return new HttpAssistedBookingGateway({ bookingBaseUrl: String(base) });
  }

  if (target && target !== 'mock') {
    console.warn(`Queue gateway "${target}" is not implemented; using mock gateway.`);
  }
  return new MockQueueGateway();
};

let instance: QueueGateway = createDefaultGateway();

export const queueGateway = {
  get current(): QueueGateway {
    return instance;
  }
};

export const setQueueGateway = (g: QueueGateway) => {
  instance = g;
};
