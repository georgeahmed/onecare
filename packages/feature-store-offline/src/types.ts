export interface FeatureSnapshot {
  featureSet: string;
  entityId: string;
  generatedAt: string;
  payload: Record<string, unknown>;
  metadata?: {
    submissionId?: string;
    correlationId?: string;
    source?: string;
    [key: string]: unknown;
  };
}

export interface PartitionKeys {
  featureSet: string;
  eventDate: string;
  entityBucket: string;
}

export interface PartitionPlan extends PartitionKeys {
  rootPath: string;
  filePath: string;
}

export interface PointInTimeRow {
  featureSet: string;
  entityId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payload: Record<string, unknown>;
  metadata?: FeatureSnapshot['metadata'];
}
