import { useMemo } from 'react';
import accessibilityConfigRaw from '../../../../config/nhs_gp_defaults.yaml';
import { transformAccessibilityConfig, type TransformedAccessibilityConfig } from '../lib/config';

export const useAccessibilityConfig = (): TransformedAccessibilityConfig => {
  return useMemo(() => transformAccessibilityConfig(accessibilityConfigRaw.accessibility_and_language), []);
};
