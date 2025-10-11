import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/index';

describe('loadConfig', () => {
  it('applies safety gate defaults and clamps overrides', () => {
    const cfg = loadConfig('demo-practice', {
      overrides: {
        safety_gate: {
          timeout_ms: 120,
          fallback: 'none',
          red_flag_threshold: 0.3,
          emergency_confidence: 1.5,
        },
      },
    });

    expect(cfg.practiceId).toBe('demo-practice');
    expect(cfg.safety_gate?.timeout_ms).toBeGreaterThanOrEqual(400);
    expect(cfg.safety_gate?.timeout_ms).toBeLessThanOrEqual(2000);
    expect(cfg.safety_gate?.fallback).toBe('none');
    expect(cfg.safety_gate?.red_flag_threshold).toBeGreaterThanOrEqual(0.5);
    expect(cfg.safety_gate?.red_flag_threshold).toBeLessThanOrEqual(0.9);
    expect(cfg.safety_gate?.emergency_confidence).toBeGreaterThanOrEqual(0.6);
    expect(cfg.safety_gate?.emergency_confidence).toBeLessThanOrEqual(0.95);
  });

  it('fills in defaults when overrides omit safety gate', () => {
    const cfg = loadConfig('demo-practice-2');
    expect(cfg.safety_gate?.timeout_ms).toBe(800);
    expect(cfg.safety_gate?.fallback).toBe('rules');
    expect(cfg.safety_gate?.red_flag_threshold).toBeGreaterThan(0);
    expect(cfg.safety_gate?.emergency_confidence).toBeGreaterThan(0);
  });
});
