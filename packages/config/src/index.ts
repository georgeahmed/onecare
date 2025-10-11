export interface CoreHours { start: string; end: string }
export interface SafetyGateConfig {
  red_flag_threshold?: number;
  emergency_confidence?: number;
  timeout_ms?: number;
  fallback?: 'rules' | 'none';
}

export interface ResolvedConfig {
  practiceId: string;
  core_hours?: CoreHours;
  safety_gate?: SafetyGateConfig;
  [key: string]: unknown;
}

export function mergeConfig<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = mergeConfig(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v as unknown;
    }
  }
  return out as T;
}

export function loadConfig(practiceId: string, base?: Partial<ResolvedConfig>): ResolvedConfig {
  // Placeholder: in production, parse YAMLs from /config and apply layered overrides (global → ICS → PCN → practice)
  // For now, return provided base merged with minimal identity.
  const minimal: ResolvedConfig = { practiceId };
  return base ? mergeConfig(minimal, base) : minimal;
}
