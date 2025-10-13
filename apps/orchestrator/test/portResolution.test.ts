import { describe, expect, it } from 'vitest';
import { resolveServerPort } from '../src/support/port';

describe('resolveServerPort', () => {
  it('returns default when env is empty', () => {
    expect(resolveServerPort({} as NodeJS.ProcessEnv)).toBe(3001);
  });

  it('uses PORT when valid', () => {
    expect(resolveServerPort({ PORT: '4000' } as NodeJS.ProcessEnv)).toBe(4000);
  });

  it('falls back for invalid numeric values', () => {
    expect(resolveServerPort({ PORT: 'abc' } as NodeJS.ProcessEnv)).toBe(3001);
    expect(resolveServerPort({ PORT: '-1' } as NodeJS.ProcessEnv)).toBe(3001);
    expect(resolveServerPort({ PORT: '0' } as NodeJS.ProcessEnv)).toBe(3001);
    expect(resolveServerPort({ PORT: '10.5' } as NodeJS.ProcessEnv)).toBe(3001);
  });

  it('prefers PORT over PORT_ORCHESTRATOR', () => {
    expect(resolveServerPort({ PORT: '5000', PORT_ORCHESTRATOR: '6000' } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it('falls back when PORT missing but PORT_ORCHESTRATOR invalid', () => {
    expect(resolveServerPort({ PORT_ORCHESTRATOR: 'not-a-number' } as NodeJS.ProcessEnv)).toBe(3001);
  });
});

