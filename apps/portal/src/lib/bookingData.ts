import type { BookingFilterState, BookingSlot } from './booking';
import type { ConfirmBookingResult } from './api';

interface CacheEntry {
  key: string;
  filters: BookingFilterState;
  slots: BookingSlot[];
  recordedAt: number;
}

export interface BookingCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 5;

const generateKey = (filters: BookingFilterState): string => {
  const normalized = {
    modality: filters.modality,
    from: filters.from ?? null,
    to: filters.to ?? null,
    serviceType: filters.serviceType ? filters.serviceType.trim() : null,
    location: filters.location ? filters.location.trim() : null,
  };
  return JSON.stringify(normalized);
};

export class BookingCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries: CacheEntry[] = [];

  constructor(options: BookingCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  public put(filters: BookingFilterState, slots: BookingSlot[]): void {
    const key = generateKey(filters);
    const recordedAt = Date.now();
    const existingIndex = this.entries.findIndex((entry) => entry.key === key);
    const entry: CacheEntry = { key, filters, slots, recordedAt };
    if (existingIndex >= 0) {
      this.entries.splice(existingIndex, 1, entry);
    } else {
      this.entries.unshift(entry);
      if (this.entries.length > this.maxEntries) {
        this.entries.pop();
      }
    }
  }

  public get(filters: BookingFilterState): BookingSlot[] | null {
    const key = generateKey(filters);
    const entry = this.entries.find((item) => item.key === key);
    if (!entry) return null;
    if (Date.now() - entry.recordedAt > this.ttlMs) {
      this.remove(key);
      return null;
    }
    return entry.slots;
  }

  public remove(key: string): void {
    const index = this.entries.findIndex((entry) => entry.key === key);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }
  }

  public clear(): void {
    this.entries.splice(0, this.entries.length);
  }
}

export interface BookingFlowState {
  cache: BookingCache;
  lastConfirmResult?: ConfirmBookingResult | null;
}

export const createBookingFlowState = (options?: BookingCacheOptions): BookingFlowState => ({
  cache: new BookingCache(options),
  lastConfirmResult: null,
});
