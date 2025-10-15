// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface PharmacyReferral {
  patientId: string;
  condition: string;
  pharmacyOrg: string;
  patientAgeYears?: number | null;
  patientSex?: "female" | "male" | "other" | "unknown" | null;
  severity?: string | null;
  exclusionFlags?: string[];
  slot?: {
    start: string;
    end: string;
    locationOdsCode?: string;
    reference?: string;
  } | null;
}
