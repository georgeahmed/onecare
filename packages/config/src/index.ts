import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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

export interface LoadConfigOptions {
  /**
   * Overrides applied after defaults and before safety floors/ceilings are enforced.
   */
  overrides?: Partial<ResolvedConfig>;
  /**
   * Optional config root (defaults to <repo>/config). Handy for tests.
   */
  configRoot?: string;
}

const DEFAULT_CONFIG_FILENAME = 'nhs_gp_defaults.yaml';
const SAFETY_GATE_TIMEOUT_DEFAULT = 800;
const SAFETY_GATE_TIMEOUT_MIN = 400;
const SAFETY_GATE_TIMEOUT_MAX = 2_000;
const SAFETY_GATE_RED_FLAG_DEFAULT = 0.65;
const SAFETY_GATE_RED_FLAG_MIN = 0.5;
const SAFETY_GATE_RED_FLAG_MAX = 0.9;
const SAFETY_GATE_EMERGENCY_DEFAULT = 0.7;
const SAFETY_GATE_EMERGENCY_MIN = 0.6;
const SAFETY_GATE_EMERGENCY_MAX = 0.95;
const SAFETY_GATE_FALLBACK_DEFAULT: SafetyGateConfig['fallback'] = 'rules';

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resolveConfigRoot(root?: string): string {
  if (root) return root;
  if (process.env.CONFIG_ROOT && process.env.CONFIG_ROOT.trim().length > 0) {
    return process.env.CONFIG_ROOT.trim();
  }
  return join(process.cwd(), 'config');
}

function readYamlConfig(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return {};
  }
  const data = parseYaml(raw);
  if (!data || typeof data !== 'object') {
    return {};
  }
  return data as Record<string, unknown>;
}

function applySafetyGatePolicies(raw?: SafetyGateConfig): SafetyGateConfig {
  const working: SafetyGateConfig & Record<string, unknown> = { ...(raw ?? {}) };
  const timeout = typeof working.timeout_ms === 'number'
    ? clamp(working.timeout_ms, SAFETY_GATE_TIMEOUT_MIN, SAFETY_GATE_TIMEOUT_MAX)
    : SAFETY_GATE_TIMEOUT_DEFAULT;
  working.timeout_ms = timeout;

  const fallback = working.fallback === 'none' ? 'none' : SAFETY_GATE_FALLBACK_DEFAULT;
  working.fallback = fallback;

  const redFlag =
    typeof working.red_flag_threshold === 'number'
      ? clamp(working.red_flag_threshold, SAFETY_GATE_RED_FLAG_MIN, SAFETY_GATE_RED_FLAG_MAX)
      : SAFETY_GATE_RED_FLAG_DEFAULT;
  working.red_flag_threshold = redFlag;

  const emergency =
    typeof working.emergency_confidence === 'number'
      ? clamp(working.emergency_confidence, SAFETY_GATE_EMERGENCY_MIN, SAFETY_GATE_EMERGENCY_MAX)
      : SAFETY_GATE_EMERGENCY_DEFAULT;
  working.emergency_confidence = emergency;

  return working;
}

export function loadConfig(practiceId: string, options?: LoadConfigOptions): ResolvedConfig {
  const configRoot = resolveConfigRoot(options?.configRoot);
  const defaultsPath = join(configRoot, DEFAULT_CONFIG_FILENAME);
  const defaults = readYamlConfig(defaultsPath);

  const merged = options?.overrides ? mergeConfig(defaults, options.overrides) : defaults;
  const resolved: ResolvedConfig = mergeConfig({ practiceId }, merged as Partial<ResolvedConfig>);
  resolved.practiceId = practiceId;
  resolved.safety_gate = applySafetyGatePolicies(resolved.safety_gate);
  return resolved;
}
