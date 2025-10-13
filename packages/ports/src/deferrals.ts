export interface DeferralRecord {
  id: string;
  practiceId: string;
  submissionId: string;
  createdAt: string;
  summaryCode: string;
  deferUntil: string;
}

export interface EnqueueResult {
  record: DeferralRecord;
  expiresAt: string;
}

export interface FlushResult {
  records: DeferralRecord[];
  deletedCount: number;
}

export interface DeferralStore {
  enqueue(record: DeferralRecord, ttlMs: number): Promise<EnqueueResult>;
  flushReady(practiceId: string, untilIsoTs: string): Promise<FlushResult>;
  expireStale(nowIsoTs: string): Promise<number>;
}
