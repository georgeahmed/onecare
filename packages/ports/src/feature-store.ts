export interface FeatureStore {
  putFeatures(key: string, features: Record<string, unknown>): Promise<void>;
  getFeatures(key: string): Promise<Record<string, unknown> | null>;
}

