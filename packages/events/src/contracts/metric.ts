// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface Metric {
  name: string;
  value: number | string;
  labels?: {
    [k: string]: string;
  };
  timestamp?: string;
}
