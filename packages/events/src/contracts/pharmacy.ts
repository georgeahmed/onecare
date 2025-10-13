// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface PharmacyReferral {
  patientId: string;
  condition: string;
  pharmacyOrg: string;
  slot?: {
    start: string;
    end: string;
  } | null;
}
