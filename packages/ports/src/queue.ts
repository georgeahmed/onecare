export interface QueueNotifier {
  notify(queue: string, message: unknown): Promise<void>;
}

