export interface IdempotencyStore {
  exists(key: string): Promise<boolean>;
  put(key: string, ttlSeconds: number): Promise<void>;
}

