import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { BookingSlot } from '../../lib/booking';
import type { EnhancedAccessWindow } from '../../lib/enhancedAccess';
import { dayIndexToLabel, minutesToTimeLabel } from '../../lib/enhancedAccess';
import { useLocale } from '../../i18n';

export interface BookingCalendarProps {
  slots: BookingSlot[];
  timezone: string;
  windows: EnhancedAccessWindow[];
  onSelectSlot?: (slot: BookingSlot) => void;
  selectedSlotId?: string | null;
}

interface ZonedTime {
  day: number;
  minutes: number;
}

interface CellContent {
  slots: BookingSlot[];
  primarySlots: BookingSlot[];
}

interface CellData {
  key: string;
  day: number;
  minute: number;
  rowIndex: number;
  withinWindow: boolean;
  windowName?: string;
  windowStart?: number;
  windowEnd?: number;
  slots: BookingSlot[];
  primarySlots: BookingSlot[];
  isSelected: boolean;
}

const INTERVAL_MINUTES = 15;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_LABELS: Record<number, string> = {
  1: 'shortWeekday.monday',
  2: 'shortWeekday.tuesday',
  3: 'shortWeekday.wednesday',
  4: 'shortWeekday.thursday',
  5: 'shortWeekday.friday',
  6: 'shortWeekday.saturday',
  7: 'shortWeekday.sunday',
};

const LONG_WEEKDAY_LABELS: Record<number, string> = {
  1: 'longWeekday.monday',
  2: 'longWeekday.tuesday',
  3: 'longWeekday.wednesday',
  4: 'longWeekday.thursday',
  5: 'longWeekday.friday',
  6: 'longWeekday.saturday',
  7: 'longWeekday.sunday',
};

const weekdayMap: Record<string, number> = {
  Mon: 1,
  Monday: 1,
  Tue: 2,
  Tuesday: 2,
  Wed: 3,
  Wednesday: 3,
  Thu: 4,
  Thursday: 4,
  Fri: 5,
  Friday: 5,
  Sat: 6,
  Saturday: 6,
  Sun: 7,
  Sunday: 7,
};

function getZonedDayAndMinutes(iso: string, timeZone: string): ZonedTime | undefined {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return undefined;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(instant);
  const weekdayPart = parts.find((part) => part.type === 'weekday');
  const hourPart = parts.find((part) => part.type === 'hour');
  const minutePart = parts.find((part) => part.type === 'minute');
  if (!weekdayPart || !hourPart || !minutePart) return undefined;
  const day = weekdayMap[weekdayPart.value];
  if (!day) return undefined;
  const minutes = Number.parseInt(hourPart.value, 10) * 60 + Number.parseInt(minutePart.value, 10);
  if (!Number.isFinite(minutes)) return undefined;
  return { day, minutes };
}

function normaliseEndMinutes(start: number, end: number): number {
  if (end > start) {
    return end;
  }
  return start + INTERVAL_MINUTES;
}

function clampDay(day: number): number {
  if (day < 1) return 1;
  if (day > 7) return 7;
  return day;
}

const BookingCalendar = ({
  slots,
  timezone,
  windows,
  onSelectSlot,
  selectedSlotId = null,
}: BookingCalendarProps) => {
  const intl = useIntl();
  const { direction } = useLocale();
  const rows = useMemo(() => {
    const slotPlacements = slots
      .map((slot) => {
        const start = getZonedDayAndMinutes(slot.start, timezone);
        const end = getZonedDayAndMinutes(slot.end, timezone);
        if (!start || !end) return undefined;
        const endMinutes = normaliseEndMinutes(start.minutes, end.minutes);
        return { slot, day: start.day, startMinutes: start.minutes, endMinutes };
      })
      .filter((value): value is { slot: BookingSlot; day: number; startMinutes: number; endMinutes: number } =>
        Boolean(value),
      );

    const minuteBounds: number[] = [];
    for (const placement of slotPlacements) {
      minuteBounds.push(placement.startMinutes, placement.endMinutes);
    }
    for (const window of windows) {
      minuteBounds.push(window.startMinutes, window.endMinutes);
    }
    const minBound = minuteBounds.length > 0 ? Math.min(...minuteBounds) : 8 * 60;
    const maxBound = minuteBounds.length > 0 ? Math.max(...minuteBounds) : 20 * 60;
    const paddedStart = Math.max(0, minBound - 30);
    const paddedEnd = Math.min(24 * 60, maxBound + 30);
    const startMinute = Math.floor(paddedStart / INTERVAL_MINUTES) * INTERVAL_MINUTES;
    const endMinute = Math.ceil(paddedEnd / INTERVAL_MINUTES) * INTERVAL_MINUTES;
    const range: number[] = [];
    for (let minute = startMinute; minute < endMinute; minute += INTERVAL_MINUTES) {
      range.push(minute);
    }
    return { range, slotPlacements };
  }, [slots, timezone, windows]);

  const dayLabels = useMemo(() => {
    const referenceIso = slots.length > 0 ? slots[0].start : new Date().toISOString();
    const referenceDate = new Date(referenceIso);
    const currentDay = getZonedDayAndMinutes(referenceIso, timezone)?.day ?? 1;
    const startOfWeek = new Date(referenceDate.getTime() - (currentDay - 1) * DAY_IN_MS);
    const formatterShort = new Intl.DateTimeFormat(intl.locale, {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const formatterFull = new Intl.DateTimeFormat(intl.locale, {
      timeZone: timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(startOfWeek.getTime() + index * DAY_IN_MS);
      const dayIndex = clampDay(index + 1);
      return {
        short: formatterShort.format(date),
        full: formatterFull.format(date),
        dayIndex,
      };
    });
  }, [intl.locale, slots, timezone]);

  const cellData = useMemo(() => {
    const rowsRange = rows.range;
    const slotContent = new Map<string, CellContent>();
    const windowCoverage = new Map<string, EnhancedAccessWindow>();

    for (const window of windows) {
      for (const day of window.days) {
        const clampedDay = clampDay(day);
        for (
          let minute = Math.max(window.startMinutes, rowsRange[0] ?? window.startMinutes);
          minute < Math.min(window.endMinutes, rowsRange[rowsRange.length - 1] + INTERVAL_MINUTES);
          minute += INTERVAL_MINUTES
        ) {
          const bucket = Math.floor(minute / INTERVAL_MINUTES) * INTERVAL_MINUTES;
          const key = `${clampedDay}-${bucket}`;
          if (!windowCoverage.has(key)) {
            windowCoverage.set(key, window);
          }
        }
      }
    }

    for (const placement of rows.slotPlacements) {
      const startBucket = Math.floor(placement.startMinutes / INTERVAL_MINUTES) * INTERVAL_MINUTES;
      const endLimit = Math.max(placement.endMinutes, placement.startMinutes + INTERVAL_MINUTES);
      for (let minute = startBucket; minute < endLimit; minute += INTERVAL_MINUTES) {
        const key = `${placement.day}-${minute}`;
        const existing = slotContent.get(key) ?? { slots: [], primarySlots: [] };
        existing.slots = existing.slots.concat(placement.slot);
        if (minute === startBucket) {
          existing.primarySlots = existing.primarySlots.concat(placement.slot);
        }
        slotContent.set(key, existing);
      }
    }

    const selectedKeys = new Set<string>();
    if (selectedSlotId) {
      for (const [key, content] of slotContent.entries()) {
        if (content.slots.some((slot) => slot.id === selectedSlotId)) {
          selectedKeys.add(key);
        }
      }
    }

    const cells: CellData[] = [];
    const lookup = new Map<string, CellData>();

    rowsRange.forEach((minute, rowIndex) => {
      for (let day = 1; day <= 7; day += 1) {
        const key = `${day}-${minute}`;
        const content = slotContent.get(key);
        const window = windowCoverage.get(key);
        const data: CellData = {
          key,
          day,
          minute,
          rowIndex,
          withinWindow: Boolean(window),
          windowName: window?.name,
          windowStart: window?.startMinutes,
          windowEnd: window?.endMinutes,
          slots: content?.slots ?? [],
          primarySlots: content?.primarySlots ?? [],
          isSelected: selectedKeys.has(key),
        };
        lookup.set(key, data);
        cells.push(data);
      }
    });

    return { cells, lookup };
  }, [rows, selectedSlotId, windows]);

  const initialActiveKey = useMemo(() => {
    const selectedCell = cellData.cells.find((cell) => cell.isSelected);
    if (selectedCell) return selectedCell.key;
    const withPrimarySlot = cellData.cells.find((cell) => cell.primarySlots.length > 0);
    if (withPrimarySlot) return withPrimarySlot.key;
    const withWindow = cellData.cells.find((cell) => cell.withinWindow);
    if (withWindow) return withWindow.key;
    return cellData.cells[0]?.key ?? null;
  }, [cellData.cells]);

  const [activeCellKey, setActiveCellKey] = useState<string | null>(initialActiveKey);
  useEffect(() => {
    setActiveCellKey(initialActiveKey);
  }, [initialActiveKey]);

  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingKeyboardFocus = useRef(false);
  useEffect(() => {
    if (!pendingKeyboardFocus.current) {
      return;
    }
    if (!activeCellKey) {
      pendingKeyboardFocus.current = false;
      return;
    }
    const element = cellRefs.current.get(activeCellKey);
    if (element) {
      element.focus();
    }
    pendingKeyboardFocus.current = false;
  }, [activeCellKey]);

  const moveFocus = (current: CellData, deltaDay: number, deltaRow: number) => {
    let nextDay = current.day + deltaDay;
    let nextRow = current.rowIndex + deltaRow;
    if (nextDay < 1 || nextDay > 7 || nextRow < 0 || nextRow >= rows.range.length) {
      return current.key;
    }
    const nextMinute = rows.range[nextRow];
    const nextKey = `${nextDay}-${nextMinute}`;
    if (cellData.lookup.has(nextKey)) {
      return nextKey;
    }
    return current.key;
  };

  const handleCellKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, cell: CellData) => {
    let targetKey: string | null = null;
    switch (event.key) {
      case 'ArrowRight':
        targetKey = moveFocus(cell, 1, 0);
        break;
      case 'ArrowLeft':
        targetKey = moveFocus(cell, -1, 0);
        break;
      case 'ArrowUp':
        targetKey = moveFocus(cell, 0, -1);
        break;
      case 'ArrowDown':
        targetKey = moveFocus(cell, 0, 1);
        break;
      case 'Home': {
        const nextKey = `${1}-${cell.minute}`;
        if (cellData.lookup.has(nextKey)) {
          targetKey = nextKey;
        }
        break;
      }
      case 'End': {
        const nextKey = `${7}-${cell.minute}`;
        if (cellData.lookup.has(nextKey)) {
          targetKey = nextKey;
        }
        break;
      }
      case 'Enter':
      case ' ': {
        if (cell.primarySlots.length > 0 && onSelectSlot) {
          onSelectSlot(cell.primarySlots[0]);
          event.preventDefault();
        }
        return;
      }
      default:
        return;
    }
    if (targetKey && targetKey !== cell.key) {
      pendingKeyboardFocus.current = true;
      setActiveCellKey(targetKey);
      event.preventDefault();
    }
  };

  const instructionsId = 'booking-calendar-instructions';

  if (!windows || windows.length === 0) {
    return (
      <section className="booking-calendar">
        <h2 className="booking-calendar__title">{intl.formatMessage({ id: 'booking.calendar.heading' })}</h2>
        <p>{intl.formatMessage({ id: 'booking.calendar.noWindows' })}</p>
      </section>
    );
  }

  const gridStyle = {
    gridTemplateRows: `repeat(${rows.range.length}, var(--calendar-row-height))`,
  } as const;

  return (
    <section className="booking-calendar" aria-labelledby="booking-calendar-title" dir={direction}>
      <div id="booking-calendar-title" className="booking-calendar__title">
        {intl.formatMessage({ id: 'booking.calendar.heading' })}
      </div>
      <p id={instructionsId} className="visually-hidden">
        {intl.formatMessage({ id: 'booking.calendar.instructions' })}
      </p>
      <div className="booking-calendar__legend">
        <span className="booking-calendar__legend-window" aria-hidden="true" />
        <span>{intl.formatMessage({ id: 'booking.calendar.legend.enhanced' })}</span>
        <span className="booking-calendar__legend-slot" aria-hidden="true" />
        <span>{intl.formatMessage({ id: 'booking.calendar.legend.slot' })}</span>
      </div>
      <div className="booking-calendar__grid-container">
        <div className="booking-calendar__header">
          <div aria-hidden="true" />
          {dayLabels.map((label) => (
            <div key={label.dayIndex} className="booking-calendar__header-cell" title={label.full}>
              <span className="booking-calendar__header-label">
                {intl.formatMessage({ id: WEEKDAY_LABELS[label.dayIndex] })}
              </span>
              <span className="booking-calendar__header-date">{label.short}</span>
            </div>
          ))}
        </div>
        <div className="booking-calendar__body">
          <div className="booking-calendar__times" style={gridStyle} aria-hidden="true">
            {rows.range.map((minute) => {
              const showLabel = minute % 60 === 0;
              return (
                <div key={minute} className="booking-calendar__time-cell">
                  {showLabel ? minutesToTimeLabel(minute) : ''}
                </div>
              );
            })}
          </div>
          <div
            className="booking-calendar__cells"
            role="grid"
            aria-readonly="true"
            aria-describedby={instructionsId}
            style={gridStyle}
          >
            {cellData.cells.map((cell) => {
              const isActive = cell.key === activeCellKey;
              const cellRef = (element: HTMLDivElement | null) => {
                if (element) {
                  cellRefs.current.set(cell.key, element);
                } else {
                  cellRefs.current.delete(cell.key);
                }
              };
              const windowLabel =
                cell.withinWindow && cell.windowStart !== undefined && cell.windowEnd !== undefined
                  ? intl.formatMessage(
                      { id: 'booking.calendar.windowTooltip' },
                      {
                        name: cell.windowName ?? 'Enhanced access',
                        day: intl.formatMessage({ id: LONG_WEEKDAY_LABELS[cell.day] }),
                        start: minutesToTimeLabel(cell.windowStart),
                        end: minutesToTimeLabel(cell.windowEnd),
                        timezone,
                      },
                    )
                  : undefined;
              const slotLabel =
                cell.primarySlots.length > 0
                  ? intl.formatMessage(
                      { id: 'booking.calendar.slotTooltip' },
                      {
                        count: cell.primarySlots.length,
                        day: intl.formatMessage({ id: LONG_WEEKDAY_LABELS[cell.day] }),
                        time: intl.formatTime(new Date(cell.primarySlots[0].start), {
                          timeStyle: 'short',
                          timeZone: timezone,
                        }),
                        modality: intl.formatMessage({ id: `booking.modality.${cell.primarySlots[0].modality}` }),
                      },
                    )
                  : undefined;
              const title = slotLabel ?? windowLabel ?? undefined;
              const ariaLabelParts = [
                intl.formatMessage({ id: LONG_WEEKDAY_LABELS[cell.day] }),
                minutesToTimeLabel(cell.minute),
              ];
              if (cell.withinWindow) {
                ariaLabelParts.push(intl.formatMessage({ id: 'booking.calendar.cellEnhanced' }));
              }
              if (cell.primarySlots.length > 0) {
                ariaLabelParts.push(
                  intl.formatMessage(
                    { id: 'booking.calendar.cellSlots' },
                    { count: cell.primarySlots.length },
                  ),
                );
              }
              return (
                <div
                  key={cell.key}
                  role="gridcell"
                  ref={cellRef}
                  className={[
                    'booking-calendar__cell',
                    cell.withinWindow ? 'booking-calendar__cell--window' : '',
                    cell.primarySlots.length > 0 ? 'booking-calendar__cell--has-slot' : '',
                    cell.isSelected ? 'booking-calendar__cell--selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  tabIndex={isActive ? 0 : -1}
                  onKeyDown={(event) => handleCellKeyDown(event, cell)}
                  onFocus={() => setActiveCellKey(cell.key)}
                  onClick={() => {
                    if (cell.primarySlots.length > 0 && onSelectSlot) {
                      onSelectSlot(cell.primarySlots[0]);
                    }
                  }}
                  aria-label={ariaLabelParts.join(', ')}
                  aria-selected={cell.isSelected}
                  title={title}
                >
                  {cell.primarySlots.length > 0 ? (
                    <span className="booking-calendar__cell-slot-indicator">
                      {intl.formatMessage(
                        { id: 'booking.calendar.slotCount' },
                        { count: cell.primarySlots.length },
                      )}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};

export default BookingCalendar;
