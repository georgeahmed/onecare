import type { QueueGateway } from './queue.types';
import { MockQueueGateway } from './queue.mock';

const createDefaultGateway = (): QueueGateway => {
  const target = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_QUEUE_GATEWAY : undefined;
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
