export interface FeatureStore {
  putFeatures(key: string, features: Record<string, unknown>): Promise<void>;
  getFeatures(key: string): Promise<Record<string, unknown> | null>;
}

export interface OnlineFeatureRecord {
  featureSet: string;
  entityId: string;
  payload: Record<string, unknown>;
  asOf: string;
  ttlSeconds?: number;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface OnlineFeatureQuery {
  featureSet: string;
  entityId: string;
  asOf?: string;
}

export interface FeatureStoreHealth {
  status: 'ok' | 'degraded' | 'unavailable';
  checkedAt: string;
  details?: string;
}

export interface FeatureStoreReadiness {
  ready: boolean;
  checkedAt: string;
  reason?: string;
}

export interface OnlineFeatureStore {
  upsert(record: OnlineFeatureRecord): Promise<void>;
  batchUpsert?(records: OnlineFeatureRecord[]): Promise<void>;
  get(query: OnlineFeatureQuery): Promise<Record<string, unknown> | null>;
  getMany?(queries: OnlineFeatureQuery[]): Promise<(Record<string, unknown> | null)[]>;
  delete?(featureSet: string, entityId: string): Promise<void>;
  purgeExpired?(now?: number): Promise<number> | number;
  health(): Promise<FeatureStoreHealth>;
  readiness(): Promise<FeatureStoreReadiness>;
}
