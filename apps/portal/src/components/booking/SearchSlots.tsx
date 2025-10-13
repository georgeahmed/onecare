import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { BookingFilterState, BookingSlot } from '../../lib/booking';

export interface SearchSlotsProps {
  slots: BookingSlot[];
  isLoading?: boolean;
  error?: string | null;
  defaultModality?: BookingFilterState['modality'];
  onFilterChange?: (filters: BookingFilterState) => void;
  onSelect?: (slot: BookingSlot) => void;
  selectedSlotId?: string | null;
}

const buildDateTimeLabel = (intl: ReturnType<typeof useIntl>, slot: BookingSlot) => {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const formatter = new Intl.DateTimeFormat(intl.locale, {
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const startLabel = formatter.format(start);
  const endTimeLabel = intl.formatTime(end, { timeStyle: 'short' });
  return intl.formatMessage(
    { id: 'booking.slot.ariaLabel' },
    {
      start: startLabel,
      end: endTimeLabel,
      modality: intl.formatMessage({ id: `booking.modality.${slot.modality}` }),
      location: slot.location ?? intl.formatMessage({ id: 'booking.location.unassigned' }),
    }
  );
};

const skeletonPlaceholders = Array.from({ length: 3 }, (_, index) => index);

const SearchSlots = ({
  slots,
  isLoading = false,
  error = null,
  defaultModality = 'all',
  onFilterChange,
  onSelect,
  selectedSlotId = null
}: SearchSlotsProps) => {
  const intl = useIntl();
  const [filters, setFilters] = useState<BookingFilterState>({ modality: defaultModality });
  const [debouncedFilters, setDebouncedFilters] = useState<BookingFilterState>({ modality: defaultModality });
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filterLegendId = useId();

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

  const filteredSlots = useMemo(() => {
    return slots.filter((slot) => {
      if (debouncedFilters.modality !== 'all' && slot.modality !== debouncedFilters.modality) {
        return false;
      }
      if (debouncedFilters.from && new Date(slot.start) < new Date(debouncedFilters.from)) {
        return false;
      }
      if (debouncedFilters.to && new Date(slot.start) > new Date(debouncedFilters.to)) {
        return false;
      }
      return true;
    });
  }, [slots, debouncedFilters]);

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

  const focusOption = (index: number) => {
    if (index < 0 || index >= optionRefs.current.length) return;
    const button = optionRefs.current[index];
    if (button) {
      button.focus();
      setActiveIndex(index);
    }
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
      {intl.formatMessage({ id: 'booking.slots.empty' })}
    </div>
  );

  const renderError = () => (
    <div role="alert" className="booking-error">
      {error ?? intl.formatMessage({ id: 'booking.slots.error' })}
    </div>
  );

  const renderSlots = () => (
    <ul
      className="booking-slots"
      role="listbox"
      aria-label={intl.formatMessage({ id: 'booking.slots.listLabel' })}
      aria-activedescendant={activeIndex >= 0 && filteredSlots[activeIndex] ? `${filteredSlots[activeIndex].id}-option` : undefined}
      onKeyDown={handleListKeyDown}
    >
      {filteredSlots.map((slot, index) => {
        const dateLabel = intl.formatDate(new Date(slot.start), {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
        const startTimeLabel = intl.formatTime(new Date(slot.start), { timeStyle: 'short' });
        const endTimeLabel = intl.formatTime(new Date(slot.end), { timeStyle: 'short' });
        const timeLabel = `${startTimeLabel} – ${endTimeLabel}`;
        const ariaLabel = buildDateTimeLabel(intl, slot);
        const locationLabel = slot.location ?? intl.formatMessage({ id: 'booking.location.unassigned' });
        const descriptionId = `${slot.id}-description`;
        const isSelected = selectedSlotId === slot.id;

        return (
          <li key={slot.id} className="booking-slot" role="presentation">
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
              onFocus={() => setActiveIndex(index)}
              role="option"
              aria-selected={isSelected}
              aria-describedby={descriptionId}
              id={`${slot.id}-option`}
              tabIndex={index === activeIndex ? 0 : -1}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
            >
              <span className="slot-date" aria-hidden="true">{dateLabel}</span>
              <span className="slot-time" aria-hidden="true">{timeLabel}</span>
              <span className="slot-modality" aria-hidden="true">
                {intl.formatMessage({ id: `booking.modality.${slot.modality}` })}
              </span>
              <span className="slot-location" aria-hidden="true">{locationLabel}</span>
              <span id={descriptionId} className="visually-hidden">
                {intl.formatMessage(
                  { id: 'booking.slot.description' },
                  {
                    date: dateLabel,
                    time: timeLabel,
                    modality: intl.formatMessage({ id: `booking.modality.${slot.modality}` }),
                    location: locationLabel
                  }
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <section className="booking-search" aria-live="polite">
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
              onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value || undefined }))}
              max={filters.to}
            />
          </div>
          <div className="filter-group">
            <label htmlFor="filter-to">{intl.formatMessage({ id: 'booking.filter.to' })}</label>
            <input
              id="filter-to"
              type="date"
              value={filters.to ?? ''}
              onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value || undefined }))}
              min={filters.from}
            />
          </div>
        </fieldset>
      </form>

      {isLoading ? renderSkeletons() : null}
      {!isLoading && error ? renderError() : null}
      {!isLoading && !error && filteredSlots.length === 0 ? renderEmptyState() : null}
      {!isLoading && !error && filteredSlots.length > 0 ? renderSlots() : null}
    </section>
  );
};

export default SearchSlots;
