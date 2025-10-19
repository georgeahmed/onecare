import { describe, it } from 'vitest';

const allowQuarantine = process.env.VITEST_RUN_QUARANTINE === 'true';
const tagPrefix = '[quarantine]';

type TestImplementation = Parameters<typeof it>[1];
type TestOptions = Parameters<typeof it>[2];
type SuiteImplementation = Parameters<typeof describe>[1];

type MaybeOptions = TestOptions | undefined;

function withTag(name: string): string {
  return name.startsWith(tagPrefix) ? name : `${tagPrefix} ${name}`;
}

export function quarantine(name: string, fn: TestImplementation, options?: MaybeOptions): void {
  const label = withTag(name);
  if (allowQuarantine) {
    it(label, fn, options);
  } else {
    it.skip(label, fn, options);
  }
}

export function describeQuarantine(name: string, factory: SuiteImplementation): void {
  const label = withTag(name);
  if (allowQuarantine) {
    describe(label, factory);
  } else {
    describe.skip(label, factory);
  }
}

export function isQuarantineEnabled(): boolean {
  return allowQuarantine;
}
