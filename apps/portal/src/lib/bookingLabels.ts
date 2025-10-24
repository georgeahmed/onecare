import type { IntlShape } from 'react-intl';
import type { BookingSlot, BookingModality } from './booking';

const modalityMessageId = (modality: BookingModality): string => `booking.modality.${modality}`;

export const formatSlotModalityLabel = (intl: IntlShape, slot: Pick<BookingSlot, 'modality' | 'originalModality'>): string => {
  if (slot.modality === 'unknown' && slot.originalModality) {
    return slot.originalModality;
  }
  return intl.formatMessage({ id: modalityMessageId(slot.modality) });
};

export const formatFilterModalityLabel = (
  intl: IntlShape,
  modality: BookingModality | 'all'
): string => {
  if (modality === 'all') {
    return intl.formatMessage({ id: 'booking.filter.modality.all' });
  }
  if (modality === 'unknown') {
    return intl.formatMessage({ id: 'booking.modality.unknown' });
  }
  return intl.formatMessage({ id: modalityMessageId(modality) });
};
