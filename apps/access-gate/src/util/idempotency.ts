// Helpers to compute idempotency keys for portal events

function toMinuteIso(ts: string): string {
  const d = new Date(ts);
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
  return `portal.notify:${practiceId}:${state}:${minute}`;
}

