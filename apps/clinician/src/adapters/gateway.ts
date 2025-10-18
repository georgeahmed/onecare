import type { QueueGateway } from './queue.types';
import { MockQueueGateway } from './queue.mock';

let instance: QueueGateway = new MockQueueGateway();

export const queueGateway = {
  get current(): QueueGateway {
    return instance;
  }
};

export const setQueueGateway = (g: QueueGateway) => {
  instance = g;
};

