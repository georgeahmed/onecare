import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  DEFAULT_BOOKING_LOCATION,
  DEFAULT_BOOKING_SERVICE_TYPE,
  type BookingFilterState,
  type BookingSlot,
} from '../../lib/booking';
import {
  formatAccessibleDateTime,
  formatDate,
  formatTime,
  formatTimeRange,
  resolveLocalePreferences,
} from '../../lib/format';
import { useLocale } from '../../i18n';
import { applyFromFilter, applyToFilter, filterSlots } from '../../lib/bookingFilters';
import { formatSlotModalityLabel } from '../../lib/bookingLabels';

export interface SearchSlotsProps {
  slots: BookingSlot[];
  isLoading?: boolean;
  error?: string | null;
  defaultModality?: BookingFilterState['modality'];
  onFilterChange?: (filters: BookingFilterState) => void;
  onSelect?: (slot: BookingSlot) => void;
  selectedSlotId?: string | null;
  fairnessNote?: string | null;
  timezone?: string;
}

const buildDateTimeLabel = (intl: ReturnType<typeof useIntl>, slot: BookingSlot, timeZone: string) => {
  const locale = intl.locale;
  const startLabel = formatAccessibleDateTime(slot.start, { locale, timeZone });
  const endLabel = formatTime(slot.end, { locale, timeZone, timeStyle: 'short' });
  const locationLabel = slot.location ?? intl.formatMessage({ id: 'booking.location.unassigned' });
  const modalityLabel = formatSlotModalityLabel(intl, slot);
  return intl.formatMessage(
    { id: 'booking.slot.ariaLabel' },
    {
      start: startLabel,
      end: endLabel,
      modality: modalityLabel,
      location: locationLabel,
    },
  );
};

const skeletonPlaceholders = Array.from({ length: 3 }, (_, index) => index);
const VIRTUALIZATION_THRESHOLD = 40;
const ITEM_HEIGHT_PX = 88;
const OVERSCAN = 3;

async function prefetchConfirmBookingModule(): Promise<void> {
  try {
    await import('./ConfirmBooking');
  } catch {
    // ignore prefetch failures
  }
}

const SearchSlots = ({
  slots,
  isLoading = false,
  error = null,
  defaultModality = 'all',
  onFilterChange,
  onSelect,
  selectedSlotId = null,
  fairnessNote = null,
  timezone,
}: SearchSlotsProps) => {
  const intl = useIntl();
  const { direction } = useLocale();
  const locale = intl.locale;
  const resolvedTimeZone = useMemo(
    () => timezone ?? resolveLocalePreferences(locale).timeZone,
    [timezone, locale],
  );
  const defaultFilters = useMemo<BookingFilterState>(
    () => ({
      modality: defaultModality,
      from: undefined,
      to: undefined,
      serviceType: DEFAULT_BOOKING_SERVICE_TYPE,
      location: DEFAULT_BOOKING_LOCATION,
    }),
    [defaultModality],
  );
  const [filters, setFilters] = useState<BookingFilterState>(defaultFilters);
  const [debouncedFilters, setDebouncedFilters] = useState<BookingFilterState>(defaultFilters);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const filterLegendId = useId();
  const [virtualWindow, setVirtualWindow] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const prefetchTriggeredRef = useRef(false);
  const scheduleFocus = useCallback(
    (callback: () => void) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(callback);
      } else {
        setTimeout(callback, 0);
      }
    },
    [],
  );

  useEffect(() => {
    setFilters((prev) => ({ ...prev, modality: defaultModality }));
    setDebouncedFilters((prev) => ({ ...prev, modality: defaultModality }));
  }, [defaultModality]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFilters(filters);
      onFilterChange?.(filters);
    }, 200);
    return () => clearTimeout(timer);
  }, [filters, onFilterChange]);

  useEffect(() => {
    optionRefs.current = [];
  }, [slots, debouncedFilters]);

  const effectiveFilters = useMemo<BookingFilterState>(
    () => ({
      ...debouncedFilters,
      serviceType: undefined,
      location: undefined,
    }),
    [debouncedFilters],
  );

  const filteredSlots = useMemo(
    () => filterSlots(slots, effectiveFilters),
    [slots, effectiveFilters],
  );

  const virtualizationEnabled = filteredSlots.length > VIRTUALIZATION_THRESHOLD;

  useEffect(() => {
    if (!virtualizationEnabled) {
      setVirtualWindow({ start: 0, end: filteredSlots.length });
      return;
    }
    const container = listContainerRef.current;
    if (!container) {
      setVirtualWindow({
        start: 0,
        end: Math.min(filteredSlots.length, VIRTUALIZATION_THRESHOLD + OVERSCAN),
      });
      return;
    }

    const calculateWindow = () => {
      const scrollTop = container.scrollTop;
      const viewportHeight = container.clientHeight || 1;
      const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT_PX) - OVERSCAN);
      const endIndex = Math.min(
        filteredSlots.length,
        Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT_PX) + OVERSCAN,
      );
      setVirtualWindow((prev) =>
        prev.start === startIndex && prev.end === endIndex ? prev : { start: startIndex, end: endIndex },
      );
    };

    calculateWindow();
    container.addEventListener('scroll', calculateWindow, { passive: true });
    return () => container.removeEventListener('scroll', calculateWindow);
  }, [filteredSlots.length, virtualizationEnabled]);

  useEffect(() => {
    if (!virtualizationEnabled) return;
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('onecare:rum', {
        detail: {
          feature: 'booking_slots_virtualization',
          totalSlots: filteredSlots.length,
        },
      }),
    );
  }, [filteredSlots.length, virtualizationEnabled]);

  useEffect(() => {
    if (!filteredSlots.length) {
      setActiveIndex(-1);
      return;
    }
    const selectedIndex = selectedSlotId
      ? filteredSlots.findIndex((slot) => slot.id === selectedSlotId)
      : -1;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [filteredSlots, selectedSlotId]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const target = optionRefs.current[activeIndex];
    target?.setAttribute('tabindex', '0');
    const siblings = optionRefs.current.filter((_, idx) => idx !== activeIndex);
    siblings.forEach((button) => button?.setAttribute('tabindex', '-1'));
  }, [activeIndex]);

  const ensureVisible = useCallback(
    (index: number) => {
      if (!virtualizationEnabled) return;
      const container = listContainerRef.current;
      if (!container) return;
      const top = index * ITEM_HEIGHT_PX;
      const bottom = top + ITEM_HEIGHT_PX;
      const viewportTop = container.scrollTop;
      const viewportBottom = viewportTop + container.clientHeight;
      if (top < viewportTop) {
        container.scrollTo({ top: Math.max(top - ITEM_HEIGHT_PX, 0) });
      } else if (bottom > viewportBottom) {
        container.scrollTo({ top: bottom - container.clientHeight + ITEM_HEIGHT_PX });
      }
    },
    [virtualizationEnabled],
  );

  useEffect(() => {
    if (!virtualizationEnabled) return;
    if (activeIndex < 0) return;
    ensureVisible(activeIndex);
  }, [activeIndex, ensureVisible, virtualizationEnabled]);

  const focusOption = (index: number) => {
    if (index < 0 || index >= filteredSlots.length) return;
    ensureVisible(index);
    setActiveIndex(index);
    scheduleFocus(() => {
      const button = optionRefs.current[index];
      button?.focus();
    });
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (!filteredSlots.length) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight': {
        event.preventDefault();
        const next = activeIndex < 0 ? 0 : (activeIndex + 1) % filteredSlots.length;
        focusOption(next);
        break;
      }
      case 'ArrowUp':
      case 'ArrowLeft': {
        event.preventDefault();
        const next =
          activeIndex < 0 ? filteredSlots.length - 1 : (activeIndex - 1 + filteredSlots.length) % filteredSlots.length;
        focusOption(next);
        break;
      }
      case 'Home': {
        event.preventDefault();
        focusOption(0);
        break;
      }
      case 'End': {
        event.preventDefault();
        focusOption(filteredSlots.length - 1);
        break;
      }
      default:
        break;
    }
  };

  const renderSkeletons = () => (
    <ul className="booking-slots" role="list">
      {skeletonPlaceholders.map((item) => (
        <li key={item} className="booking-slot skeleton" aria-hidden="true">
          <div className="skeleton-line short" />
          <div className="skeleton-line long" />
        </li>
      ))}
    </ul>
  );

  const renderEmptyState = () => (
    <div role="status" className="booking-empty">
      <p>{intl.formatMessage({ id: 'booking.slots.empty' })}</p>
      <p>{intl.formatMessage({ id: 'booking.slots.emptyGuidance' })}</p>
    </div>
  );

  const renderError = () => (
    <div role="alert" className="booking-error">
      {error ?? intl.formatMessage({ id: 'booking.slots.error' })}
    </div>
  );

  const renderSlots = () => {
    const visibleStart = virtualizationEnabled ? virtualWindow.start : 0;
    const visibleEnd = virtualizationEnabled ? virtualWindow.end : filteredSlots.length;
    const slotsToRender = filteredSlots.slice(visibleStart, visibleEnd);
    const topSpacer = virtualizationEnabled ? visibleStart * ITEM_HEIGHT_PX : 0;
    const bottomSpacer = virtualizationEnabled ? Math.max(filteredSlots.length - visibleEnd, 0) * ITEM_HEIGHT_PX : 0;

    return (
      <div
        className={['booking-slots', virtualizationEnabled ? 'booking-slots--virtualized' : '']
          .filter(Boolean)
          .join(' ')}
        role="listbox"
        aria-label={intl.formatMessage({ id: 'booking.slots.listLabel' })}
        aria-activedescendant={
          activeIndex >= 0 && filteredSlots[activeIndex] ? `${filteredSlots[activeIndex].id}-option` : undefined
        }
        onKeyDown={handleListKeyDown}
        ref={listContainerRef}
        dir={direction}
      >
        {virtualizationEnabled ? (
          <div className="booking-slot-spacer" style={{ height: `${topSpacer}px` }} aria-hidden="true" />
        ) : null}
        {slotsToRender.map((slot, renderIndex) => {
          const index = renderIndex + visibleStart;
          const modalityLabel = formatSlotModalityLabel(intl, slot);
          const locationLabel = slot.location ?? intl.formatMessage({ id: 'booking.location.unassigned' });
          const dateLabel = formatDate(slot.start, {
            locale,
            timeZone: resolvedTimeZone,
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          });
          const timeLabel = formatTimeRange(slot.start, slot.end, { locale, timeZone: resolvedTimeZone });
          const ariaLabel = buildDateTimeLabel(intl, slot, resolvedTimeZone);
          const accessibleDate = formatAccessibleDateTime(slot.start, { locale, timeZone: resolvedTimeZone });
          const descriptionId = `${slot.id}-description`;
          const isSelected = selectedSlotId === slot.id;
          return (
            <div key={slot.id} className="booking-slot" role="presentation" style={{ height: ITEM_HEIGHT_PX }}>
              <button
                type="button"
                aria-label={ariaLabel}
                className="slot-button"
                onClick={() => onSelect?.(slot)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect?.(slot);
                  }
                }}
                onFocus={() => {
                  if (!prefetchTriggeredRef.current) {
                    prefetchTriggeredRef.current = true;
                    void prefetchConfirmBookingModule();
                  }
                  ensureVisible(index);
                  setActiveIndex(index);
                }}
                onMouseEnter={() => {
                  if (!prefetchTriggeredRef.current) {
                    prefetchTriggeredRef.current = true;
                    void prefetchConfirmBookingModule();
                  }
                }}
                role="option"
                aria-selected={isSelected}
                aria-describedby={descriptionId}
                id={`${slot.id}-option`}
                aria-setsize={filteredSlots.length}
                aria-posinset={index + 1}
                tabIndex={index === activeIndex ? 0 : -1}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
              >
                <span className="slot-date" aria-hidden="true">{dateLabel}</span>
                <span className="slot-time" aria-hidden="true">{timeLabel}</span>
                <span className="slot-modality" aria-hidden="true">
                  {modalityLabel}
                </span>
                <span className="slot-location" aria-hidden="true">{locationLabel}</span>
                <span id={descriptionId} className="visually-hidden">
                  {intl.formatMessage(
                    { id: 'booking.slot.description' },
                    {
                      date: accessibleDate,
                      time: timeLabel,
                      modality: modalityLabel,
                      location: locationLabel,
                    },
                  )}
                </span>
              </button>
            </div>
          );
        })}
        {virtualizationEnabled ? (
          <div className="booking-slot-spacer" style={{ height: `${bottomSpacer}px` }} aria-hidden="true" />
        ) : null}
      </div>
    );
  };

  return (
    <section className="booking-search" aria-live="polite" dir={direction}>
      <form
        className="booking-search__filters"
        aria-labelledby={filterLegendId}
        onSubmit={(event) => event.preventDefault()}
      >
        <fieldset>
          <legend id={filterLegendId}>{intl.formatMessage({ id: 'booking.filter.legend' })}</legend>
          <div className="filter-group">
            <label htmlFor="filter-modality">{intl.formatMessage({ id: 'booking.filter.modality' })}</label>
            <select
              id="filter-modality"
              value={filters.modality}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, modality: event.target.value as BookingFilterState['modality'] }))
              }
            >
              <option value="all">{intl.formatMessage({ id: 'booking.filter.modality.all' })}</option>
              <option value="phone">{intl.formatMessage({ id: 'booking.modality.phone' })}</option>
              <option value="in_person">{intl.formatMessage({ id: 'booking.modality.in_person' })}</option>
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="filter-from">{intl.formatMessage({ id: 'booking.filter.from' })}</label>
            <input
              id="filter-from"
              type="date"
              value={filters.from ?? ''}
              onChange={(event) =>
                setFilters((prev) => applyFromFilter(prev, event.target.value || undefined))
              }
              max={filters.to ?? undefined}
            />
          </div>
          <div className="filter-group">
            <label htmlFor="filter-to">{intl.formatMessage({ id: 'booking.filter.to' })}</label>
            <input
              id="filter-to"
              type="date"
              value={filters.to ?? ''}
              onChange={(event) =>
                setFilters((prev) => applyToFilter(prev, event.target.value || undefined))
              }
              min={filters.from ?? undefined}
            />
          </div>
        </fieldset>
        <button type="submit" className="visually-hidden">
          {intl.formatMessage({ id: 'booking.filter.apply' })}
        </button>
      </form>

      {fairnessNote?.trim() ? (
        <aside className="booking-fairness-note" role="note">
          <strong>{intl.formatMessage({ id: 'booking.fairness.label' })}</strong>{' '}
          <span>{fairnessNote.trim()}</span>
        </aside>
      ) : null}

      {isLoading ? renderSkeletons() : null}
      {!isLoading && error ? renderError() : null}
      {!isLoading && !error && filteredSlots.length === 0 ? renderEmptyState() : null}
      {!isLoading && !error && filteredSlots.length > 0 ? renderSlots() : null}
    </section>
  );
};

export default SearchSlots;
