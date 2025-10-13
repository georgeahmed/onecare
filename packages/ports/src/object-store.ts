export interface ObjectStore {
  put(key: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<{ url: string }>;
  get(key: string): Promise<Uint8Array>;
}

