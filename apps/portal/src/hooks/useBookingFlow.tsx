import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
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
  const cacheRef = useRef<BookingCache>();
  if (!cacheRef.current) {
    cacheRef.current = createBookingFlowState().cache;
  }

  const [lastConfirmResult, setLastConfirmResult] = useState<ConfirmBookingResult | null>(null);

  const getCachedSlots = useCallback((filters: BookingFilterState) => cacheRef.current?.get(filters) ?? null, []);
  const putSlots = useCallback((filters: BookingFilterState, slots: BookingSlot[]) => {
    cacheRef.current?.put(filters, slots);
  }, []);
  const clear = useCallback(() => {
    cacheRef.current?.clear();
    setLastConfirmResult(null);
  }, []);

  const value = useMemo<BookingFlowContextValue>(() => ({
    cache: cacheRef.current!,
    getCachedSlots,
    putSlots,
    lastConfirmResult,
    setLastConfirmResult,
    clear,
  }), [getCachedSlots, putSlots, lastConfirmResult, clear]);

  return <BookingFlowContext.Provider value={value}>{children}</BookingFlowContext.Provider>;
};

export const useBookingFlow = (): BookingFlowContextValue => {
  const context = useContext(BookingFlowContext);
  if (!context) {
    throw new Error('useBookingFlow must be used within a BookingFlowProvider');
  }
  return context;
};
