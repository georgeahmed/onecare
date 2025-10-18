import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BookingFilterState, BookingSlot } from '../lib/booking';
import type { ConfirmBookingResult } from '../lib/api';
import { BookingCache, createBookingFlowState, type BookingFlowState } from '../lib/bookingData';

interface BookingFlowContextValue {
  cache: BookingCache;
  getCachedSlots(filters: BookingFilterState): BookingSlot[] | null;
  putSlots(filters: BookingFilterState, slots: BookingSlot[]): void;
  lastConfirmResult: ConfirmBookingResult | null;
  setLastConfirmResult(result: ConfirmBookingResult | null): void;
  clear(): void;
}

const BookingFlowContext = createContext<BookingFlowContextValue | undefined>(undefined);

export const BookingFlowProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<BookingFlowState>(() => createBookingFlowState());

  const value = useMemo<BookingFlowContextValue>(() => ({
    cache: state.cache,
    getCachedSlots: (filters) => state.cache.get(filters),
    putSlots: (filters, slots) => state.cache.put(filters, slots),
    lastConfirmResult: state.lastConfirmResult ?? null,
    setLastConfirmResult: (result) => setState((prev) => ({ ...prev, lastConfirmResult: result })),
    clear: () => {
      state.cache.clear();
      setState((prev) => ({ ...prev, lastConfirmResult: null }));
    },
  }), [state]);

  return <BookingFlowContext.Provider value={value}>{children}</BookingFlowContext.Provider>;
};

export const useBookingFlow = (): BookingFlowContextValue => {
  const context = useContext(BookingFlowContext);
  if (!context) {
    throw new Error('useBookingFlow must be used within a BookingFlowProvider');
  }
  return context;
};
