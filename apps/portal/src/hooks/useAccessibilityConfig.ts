import { useMemo } from 'react';
import rawAccessibilityConfig from '../config/accessibility.defaults.json';
import { transformAccessibilityConfig, type TransformedAccessibilityConfig } from '../lib/config';

export const useAccessibilityConfig = (): TransformedAccessibilityConfig => {
  return useMemo(() => transformAccessibilityConfig(rawAccessibilityConfig), []);
};
