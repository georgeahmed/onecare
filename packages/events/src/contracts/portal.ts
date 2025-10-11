// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface PortalNotify {
  practiceId: string;
  state: 'UP' | 'DOWN' | 'OOH';
  reasonCode?: string;
  at: string; // date-time
  message?: string | null;
}

