import { reportPerformanceMetric, safeLog } from './telemetry';

type MetricName = 'LCP' | 'CLS' | 'INP';

type PerformanceRating = 'good' | 'needs-improvement' | 'poor';

type LargestContentfulPaintEntry = PerformanceEntry & {
  renderTime: number;
  loadTime: number;
  startTime: number;
};

type LayoutShiftEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
};

type PerformanceEventTimingEntry = PerformanceEntry & {
  duration: number;
  interactionId?: number;
};

const PERFORMANCE_THRESHOLDS: Record<MetricName, { good: number; poor: number }> = {
  LCP: { good: 2500, poor: 4000 },
  CLS: { good: 0.1, poor: 0.25 },
  INP: { good: 200, poor: 500 }
};

const PERFORMANCE_BUDGETS: Record<MetricName, number> = {
  LCP: 2500,
  CLS: 0.1,
  INP: 200
};

let observersStarted = false;

const computeRating = (metric: MetricName, value: number): PerformanceRating => {
  const thresholds = PERFORMANCE_THRESHOLDS[metric];
  if (value <= thresholds.good) {
    return 'good';
  }
  if (value <= thresholds.poor) {
    return 'needs-improvement';
  }
  return 'poor';
};

const reportMetric = (metric: MetricName, value: number, extra: Record<string, unknown> = {}) => {
  const rating = computeRating(metric, value);
  reportPerformanceMetric(metric, value, rating, {
    budget: PERFORMANCE_BUDGETS[metric],
    ...extra
  });
  if (value > PERFORMANCE_BUDGETS[metric]) {
    safeLog('performance.budget', { metric, value, budget: PERFORMANCE_BUDGETS[metric] });
  }
};

export const startPerformanceMonitoring = (): void => {
  if (observersStarted) {
    return;
  }
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
    return;
  }

  observersStarted = true;

  const supportedEntries = PerformanceObserver.supportedEntryTypes ?? [];

  // Largest Contentful Paint
  if (supportedEntries.includes('largest-contentful-paint')) {
    let lcpValue = 0;
    let reported = false;
    const finalize = () => {
      if (!reported && lcpValue > 0) {
        reported = true;
        reportMetric('LCP', lcpValue);
      }
    };

    const observer = new PerformanceObserver((entryList) => {
      const entries = entryList.getEntries();
      const lastEntry = entries[entries.length - 1] as LargestContentfulPaintEntry | undefined;
      if (!lastEntry) return;
      const value = lastEntry.renderTime || lastEntry.loadTime || lastEntry.startTime;
      lcpValue = value;
    });

    observer.observe({ type: 'largest-contentful-paint', buffered: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        observer.disconnect();
        finalize();
      }
    });
    window.addEventListener('pagehide', () => {
      observer.disconnect();
      finalize();
    });
  }

  // Cumulative Layout Shift
  if (supportedEntries.includes('layout-shift')) {
    let clsValue = 0;
    let reported = false;

    const finalize = () => {
      if (!reported) {
        reported = true;
        reportMetric('CLS', clsValue);
      }
    };

    const observer = new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries() as LayoutShiftEntry[]) {
        if (!entry.hadRecentInput) {
          clsValue += entry.value;
        }
      }
    });

    observer.observe({ type: 'layout-shift', buffered: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        observer.disconnect();
        finalize();
      }
    });
    window.addEventListener('pagehide', () => {
      observer.disconnect();
      finalize();
    });
  }

  // Interaction to Next Paint (INP)
  if (supportedEntries.includes('event')) {
    const interactionMap = new Map<number, number>();
    let maxDuration = 0;
    let reported = false;

    const finalize = () => {
      if (reported) return;
      reported = true;
      const interactionMax = interactionMap.size
        ? Math.max(...interactionMap.values())
        : 0;
      const value = Math.max(maxDuration, interactionMax);
      if (value > 0) {
        reportMetric('INP', value);
      }
    };

    try {
      const observer = new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries() as PerformanceEventTimingEntry[]) {
          const duration = entry.duration;
          if (duration <= 0) continue;
          const interactionId = entry.interactionId ?? 0;
          if (interactionId > 0) {
            const previous = interactionMap.get(interactionId) ?? 0;
            interactionMap.set(interactionId, Math.max(previous, duration));
          } else {
            maxDuration = Math.max(maxDuration, duration);
          }
        }
      });

      const eventObserverOptions = {
        type: 'event',
        buffered: true,
        durationThreshold: 40
      } as Record<string, unknown>;
      observer.observe(eventObserverOptions as PerformanceObserverInit);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          observer.disconnect();
          finalize();
        }
      });
      window.addEventListener('pagehide', () => {
        observer.disconnect();
        finalize();
      });
    } catch {
      // Some browsers may not support the event entry type yet
    }
  }
};
