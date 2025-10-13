// Helpers to compute idempotency keys for portal events

function toMinuteIso(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    return ts.trim();
  }
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00Z`;
}

export function computePortalNotifyKey(practiceId: string, state: 'UP' | 'DOWN' | 'OOH', atIso: string): string {
  const minute = toMinuteIso(atIso);
  const normalizedPractice = practiceId.trim().toLowerCase();
  const normalizedState = state.trim().toUpperCase() as 'UP' | 'DOWN' | 'OOH';
  return `portal.notify:${normalizedPractice}:${normalizedState}:${minute}`;
}
