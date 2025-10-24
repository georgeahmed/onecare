import type { BookingFilterState, BookingSlot } from './booking';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isValidDate = (value: string | undefined): value is string =>
  typeof value === 'string' && DATE_PATTERN.test(value.trim());

const normalizeDate = (value: string): string => value.trim();

const normalizeString = (value?: string): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const createDateRange = (date: string | undefined): string | undefined =>
  isValidDate(date) ? normalizeDate(date!) : undefined;

export const applyFromFilter = (
  previous: BookingFilterState,
  rawValue: string | undefined,
): BookingFilterState => {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    if (previous.from === undefined) {
      return previous;
    }
    return {
      ...previous,
      from: undefined,
    };
  }
  if (!isValidDate(rawValue)) {
    return previous;
  }
  const value = normalizeDate(rawValue);
  if (previous.from === value) {
    return previous;
  }
  if (previous.to && value > previous.to) {
    return {
      ...previous,
      from: value,
      to: value,
    };
  }
  return {
    ...previous,
    from: value,
  };
};

export const applyToFilter = (
  previous: BookingFilterState,
  rawValue: string | undefined,
): BookingFilterState => {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    if (previous.to === undefined) {
      return previous;
    }
    return {
      ...previous,
      to: undefined,
    };
  }
  if (!isValidDate(rawValue)) {
    return previous;
  }
  const value = normalizeDate(rawValue);
  if (previous.to === value) {
    return previous;
  }
  if (previous.from && value < previous.from) {
    return {
      ...previous,
      from: value,
      to: value,
    };
  }
  return {
    ...previous,
    to: value,
  };
};

export const resolveFilterBounds = (
  filters: BookingFilterState,
): { from: number | null; to: number | null } => {
  const parseStart = (value: string | undefined): number | null => {
    if (!isValidDate(value)) return null;
    const timestamp = Date.parse(`${normalizeDate(value)}T00:00:00.000`);
    return Number.isNaN(timestamp) ? null : timestamp;
  };

  const parseEnd = (value: string | undefined): number | null => {
    if (!isValidDate(value)) return null;
    const timestamp = Date.parse(`${normalizeDate(value)}T23:59:59.999`);
    return Number.isNaN(timestamp) ? null : timestamp;
  };

  return {
    from: parseStart(filters.from),
    to: parseEnd(filters.to),
  };
};

export const slotMatchesFilters = (slot: BookingSlot, filters: BookingFilterState): boolean => {
  if (filters.modality !== 'all' && slot.modality !== filters.modality) {
    return false;
  }

  if (filters.serviceType) {
    const slotService = slot.serviceType?.trim().toLowerCase() ?? '';
    if (slotService !== filters.serviceType.trim().toLowerCase()) {
      return false;
    }
  }

  if (filters.location) {
    const slotLocation = slot.location?.trim().toLowerCase() ?? '';
    if (slotLocation !== filters.location.trim().toLowerCase()) {
      return false;
    }
  }

  const bounds = resolveFilterBounds(filters);
  const slotTime = Date.parse(slot.start);
  if (Number.isNaN(slotTime)) {
    return false;
  }

  if (typeof bounds.from === 'number' && slotTime < bounds.from) {
    return false;
  }
  if (typeof bounds.to === 'number' && slotTime > bounds.to) {
    return false;
  }

  return true;
};

export const filterSlots = (slots: BookingSlot[], filters: BookingFilterState): BookingSlot[] =>
  slots.filter((slot) => slotMatchesFilters(slot, filters));
