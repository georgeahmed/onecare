// AUTO-GENERATED from schemas. DO NOT EDIT.

export type PharmacyReferralPatientSex = "female" | "male" | "other" | "unknown" | null;
export type PharmacyReferralSlot = {
  start: string;
  end: string;
  locationOdsCode?: string;
  reference?: string;
} | null;

export interface PharmacyReferral {
  patientId: string;
  condition: string;
  pharmacyOrg: string;
  patientAgeYears?: number | null;
  patientSex?: PharmacyReferralPatientSex;
  severity?: string | null;
  exclusionFlags?: string[];
  slot?: PharmacyReferralSlot;
}
