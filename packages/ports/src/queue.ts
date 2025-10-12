export interface QueueNotifier {
  notify(queue: string, message: unknown): Promise<void>;
}

export class InMemoryQueueNotifier implements QueueNotifier {
  public readonly deliveries: Array<{ queue: string; message: unknown }> = [];

  async notify(queue: string, message: unknown): Promise<void> {
    this.deliveries.push({ queue, message });
  }
}

export class LoggingQueueNotifier implements QueueNotifier {
  constructor(private readonly logger: { info(msg: string, fields?: Record<string, unknown>): void }) {}

  async notify(queue: string, message: unknown): Promise<void> {
    this.logger.info('queue notifier invoked', {
      queue,
      hasMessage: message !== undefined && message !== null,
    });
  }
}
