const resolveEnvValue = (key: string, fallback: string): string => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const raw = env[key];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

export const DEFAULT_BOOKING_SERVICE_TYPE = resolveEnvValue('VITE_BOOKING_SERVICE_TYPE', 'gp-consult');
export const DEFAULT_BOOKING_LOCATION = resolveEnvValue('VITE_BOOKING_LOCATION', 'demo-clinic');

export type BookingModality = 'phone' | 'in_person';

export interface BookingSlot {
  id: string;
  start: string; // ISO string
  end: string; // ISO string
  modality: BookingModality;
  serviceType?: string;
  location?: string;
}

export interface BookingFilterState {
  modality: BookingModality | 'all';
  from?: string;
  to?: string;
  serviceType?: string;
  location?: string;
}

export interface BookingQueryFilters {
  modality?: BookingModality;
  from?: string;
  to?: string;
  serviceType?: string;
  location?: string;
}

export const filtersEqual = (a: BookingFilterState | null, b: BookingFilterState | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const normalize = (value?: string) => (value ? value.trim() : '');
  return (
    a.modality === b.modality &&
    normalize(a.from) === normalize(b.from) &&
    normalize(a.to) === normalize(b.to) &&
    normalize(a.serviceType) === normalize(b.serviceType) &&
    normalize(a.location) === normalize(b.location)
  );
};

const normalizeFilterValue = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const createDefaultBookingFilters = (overrides: Partial<BookingFilterState> = {}): BookingFilterState => {
  const filters: BookingFilterState = {
    modality: overrides.modality ?? 'all'
  };

  if (overrides.from) {
    filters.from = overrides.from;
  }
  if (overrides.to) {
    filters.to = overrides.to;
  }

  const serviceType = normalizeFilterValue(overrides.serviceType ?? DEFAULT_BOOKING_SERVICE_TYPE);
  if (serviceType) {
    filters.serviceType = serviceType;
  }

  const location = normalizeFilterValue(overrides.location ?? DEFAULT_BOOKING_LOCATION);
  if (location) {
    filters.location = location;
  }

  return filters;
};

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const createBookingIdempotencyKey = (slotId: string, patientId: string, timestamp: number): string => {
  const input = `${slotId}:${patientId}:${timestamp}`;
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  // Mix the bits to reduce collisions for similar inputs.
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);
  hash ^= hash >>> 15;

  const normalized = (hash >>> 0).toString(36);
  return `bk_${normalized}`;
};
