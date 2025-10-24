import type { BookingSearchRequest, BookingSearchResponse, AppointmentCreated, BookingAssistedOutcome } from '@onecare/events';
import { validate, type ValidationResult, type ValidationError } from '@onecare/domain';

const BOOKING_SEARCH_REQUEST_SCHEMA_ID = 'https://onecare/schemas/booking/booking-search-request.json';
const BOOKING_SEARCH_RESPONSE_SCHEMA_ID = 'https://onecare/schemas/booking/booking-search-response.json';
const APPOINTMENT_CREATED_SCHEMA_ID = 'https://onecare/schemas/booking/appointment-created.json';
const BOOKING_ASSISTED_OUTCOME_SCHEMA_ID = 'https://onecare/schemas/booking/assisted-outcome.json';

export interface ContractValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ContractValidationFailure {
  ok: false;
  errors: ValidationError[];
}

type ContractValidationResult<T> = ContractValidationSuccess<T> | ContractValidationFailure;

function mapResult<T>(payload: unknown, validator: (value: unknown) => ValidationResult): ContractValidationResult<T> {
  const result = validator(payload);
  if (result.ok) {
    return { ok: true, value: payload as T };
  }
  return { ok: false, errors: result.errors };
}

export function validateBookingSearchRequest(payload: unknown): ContractValidationResult<BookingSearchRequest> {
  return mapResult<BookingSearchRequest>(payload, (value) => validate(BOOKING_SEARCH_REQUEST_SCHEMA_ID, value));
}

export function validateBookingSearchResponse(payload: unknown): ContractValidationResult<BookingSearchResponse> {
  return mapResult<BookingSearchResponse>(payload, (value) => validate(BOOKING_SEARCH_RESPONSE_SCHEMA_ID, value));
}

export function validateAppointmentCreatedEvent(payload: unknown): ContractValidationResult<AppointmentCreated> {
  return mapResult<AppointmentCreated>(payload, (value) => validate(APPOINTMENT_CREATED_SCHEMA_ID, value));
}

export function validateBookingAssistedOutcome(payload: unknown): ContractValidationResult<BookingAssistedOutcome> {
  return mapResult<BookingAssistedOutcome>(payload, (value) =>
    validate(BOOKING_ASSISTED_OUTCOME_SCHEMA_ID, value),
  );
}
