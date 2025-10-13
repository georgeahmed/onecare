export type BookingModality = 'phone' | 'in_person';

export interface BookingSlot {
  id: string;
  start: string; // ISO string
  end: string; // ISO string
  modality: BookingModality;
  location?: string;
}

export interface BookingFilterState {
  modality: BookingModality | 'all';
  from?: string;
  to?: string;
}

export interface BookingQueryFilters {
  modality?: BookingModality;
  from?: string;
  to?: string;
}

export const filtersEqual = (a: BookingFilterState | null, b: BookingFilterState | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.modality === b.modality && a.from === b.from && a.to === b.to;
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
