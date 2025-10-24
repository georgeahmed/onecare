export interface ObjectStorePutOptions {
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}

export interface ObjectStore {
  put(
    key: string,
    data: ArrayBuffer | Uint8Array,
    contentType: string,
    options?: ObjectStorePutOptions,
  ): Promise<{ url: string }>;
  get(key: string): Promise<Uint8Array>;
}
