import { describe, expect, it } from 'vitest';
import {
  evaluateLicenseExpressions,
  exceptionMatches,
  isLicenseExpressionAllowed,
  normaliseAllowedLicenses,
} from '../securityPolicyUtils.mjs';

const DEFAULT_ALLOWED = normaliseAllowedLicenses(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC']);

describe('securityPolicyUtils', () => {
  describe('isLicenseExpressionAllowed', () => {
    it('allows expressions with an allowed option using OR', () => {
      expect(isLicenseExpressionAllowed('MIT OR GPL-3.0-only', DEFAULT_ALLOWED)).toBe(true);
      expect(isLicenseExpressionAllowed('GPL-3.0-only OR Apache-2.0', DEFAULT_ALLOWED)).toBe(true);
      expect(isLicenseExpressionAllowed('(GPL-3.0-only) OR (Apache-2.0)', DEFAULT_ALLOWED)).toBe(true);
      expect(isLicenseExpressionAllowed('MIT/Apache-2.0', DEFAULT_ALLOWED)).toBe(true);
    });

    it('requires all segments for AND semantics', () => {
      expect(isLicenseExpressionAllowed('MIT AND Apache-2.0', DEFAULT_ALLOWED)).toBe(true);
      expect(isLicenseExpressionAllowed('MIT AND GPL-3.0-only', DEFAULT_ALLOWED)).toBe(false);
      expect(isLicenseExpressionAllowed('Apache-2.0 / MIT', DEFAULT_ALLOWED)).toBe(true);
    });

    it('ignores license exceptions after WITH when checking allow list', () => {
      expect(isLicenseExpressionAllowed('Apache-2.0 WITH LLVM-exception', DEFAULT_ALLOWED)).toBe(true);
      expect(isLicenseExpressionAllowed('GPL-2.0-only WITH Classpath-exception-2.0', DEFAULT_ALLOWED)).toBe(false);
    });

    it('treats comma-separated values as alternates', () => {
      expect(isLicenseExpressionAllowed('MIT, ISC', DEFAULT_ALLOWED)).toBe(true);
      expect(isLicenseExpressionAllowed('GPL-3.0-only, LGPL-2.1', DEFAULT_ALLOWED)).toBe(false);
    });
  });

  describe('evaluateLicenseExpressions', () => {
    it('marks expression as allowed when an alternative is safe', () => {
      const result = evaluateLicenseExpressions('MIT OR GPL-3.0-only', DEFAULT_ALLOWED);
      expect(result.allowed).toBe(true);
      expect(result.disallowed).toEqual([]);
    });

    it('returns disallowed licenses when none are acceptable', () => {
      const result = evaluateLicenseExpressions('GPL-3.0-only OR LGPL-2.1', DEFAULT_ALLOWED);
      expect(result.allowed).toBe(false);
      expect(result.disallowed).toEqual(['GPL-3.0-only', 'LGPL-2.1']);
    });

    it('drops exception suffixes from disallowed results', () => {
      const result = evaluateLicenseExpressions('GPL-2.0-only WITH Classpath-exception-2.0', DEFAULT_ALLOWED);
      expect(result.allowed).toBe(false);
      expect(result.disallowed).toEqual(['GPL-2.0-only']);
    });

    it('handles array inputs from reports', () => {
      const result = evaluateLicenseExpressions(['Apache-2.0', 'GPL-3.0-only'], DEFAULT_ALLOWED);
      expect(result.allowed).toBe(true);
      expect(result.disallowed).toEqual([]);
    });

    it('reads license metadata objects emitted by scanners', () => {
      const result = evaluateLicenseExpressions(
        [
          { type: 'MIT', url: 'https://opensource.org/licenses/MIT' },
          { licenses: [{ type: 'GPL-3.0-only' }] },
        ],
        DEFAULT_ALLOWED,
      );
      expect(result.allowed).toBe(true);
      expect(result.disallowed).toEqual([]);
    });

    it('normalises descriptive license names to SPDX identifiers', () => {
      const allowed = normaliseAllowedLicenses(['Apache-2.0']);
      expect(isLicenseExpressionAllowed('Apache License Version 2.0', allowed)).toBe(true);
      const evaluation = evaluateLicenseExpressions('Apache License 2.0', allowed);
      expect(evaluation.allowed).toBe(true);
    });
  });

  describe('exceptionMatches', () => {
    it('matches exception entries when any token overlaps', () => {
      const exceptions = [
        { package: 'demo', license: 'GPL-3.0-only', expires: '2099-01-01' },
      ];
      expect(exceptionMatches(exceptions, 'demo', 'GPL-3.0-only OR MIT')).toBe(true);
    });

    it('ignores expired exceptions', () => {
      const exceptions = [
        { package: 'demo', license: 'MIT', expires: '2000-01-01' },
      ];
      expect(exceptionMatches(exceptions, 'demo', 'MIT')).toBe(false);
    });
  });
});
