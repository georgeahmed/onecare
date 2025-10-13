import {
  evaluateDistributionDrift,
  type DriftAlertContext,
  type DriftCheckOptions,
  type DriftMetrics,
} from './drift';

export interface DriftObservationContext {
  source?: string;
  path?: string;
  correlationId?: string | null;
  observedAt?: string;
  metadata?: Record<string, unknown>;
  samplesBaseline?: number;
  samplesCurrent?: number;
  totalSamples?: number;
  lastValue?: number;
}

export interface FeatureDriftMonitorOptions {
  featureName?: string;
  baselineWindowSize?: number;
  currentWindowSize?: number;
  driftOptions?: DriftCheckOptions;
  /**
   * Invoked when drift thresholds are exceeded. Context includes the drift metrics
   * merged with the most recent observation metadata.
   */
  alertLogger?: (message: string, context: DriftAlertContext & DriftObservationContext) => void;
  clock?: () => number;
}

export interface DriftMonitorState {
  baseline: readonly number[];
  current: readonly number[];
  metrics: DriftMetrics | null;
  samplesSeen: number;
  ready: boolean;
  lastObservation?: DriftObservationContext;
}

const DEFAULT_BASELINE_WINDOW = 200;
const DEFAULT_CURRENT_WINDOW = 50;

function sanitiseWindowSize(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number') {
    return fallback;
  }
  const parsed = Math.floor(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class FeatureDriftMonitor {
  private readonly baselineWindow: number;
  private readonly currentWindow: number;
  private readonly totalWindow: number;
  private readonly featureName?: string;
  private readonly driftOptions?: DriftCheckOptions;
  private readonly alertLogger?: (message: string, context: DriftAlertContext & DriftObservationContext) => void;
  private readonly clock: () => number;

  private window: number[] = [];
  private samplesSeen = 0;
  private lastMetrics: DriftMetrics | null = null;
  private lastBaseline: number[] = [];
  private lastCurrent: number[] = [];
  private lastObservation?: DriftObservationContext;

  constructor(options: FeatureDriftMonitorOptions = {}) {
    this.baselineWindow = sanitiseWindowSize(options.baselineWindowSize, DEFAULT_BASELINE_WINDOW);
    this.currentWindow = sanitiseWindowSize(options.currentWindowSize, DEFAULT_CURRENT_WINDOW);
    this.totalWindow = this.baselineWindow + this.currentWindow;
    if (this.totalWindow <= 1) {
      throw new Error('FeatureDriftMonitor requires positive baseline and current window sizes');
    }
    this.featureName = options.featureName ?? options.driftOptions?.featureName;
    this.driftOptions = options.driftOptions;
    this.alertLogger = options.alertLogger;
    this.clock = options.clock ?? Date.now;
  }

  observe(value: number, context: DriftObservationContext = {}): DriftMetrics | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    this.samplesSeen += 1;
    const observedAt = context.observedAt ?? new Date(this.clock()).toISOString();
    const observation: DriftObservationContext = {
      ...context,
      observedAt,
      lastValue: value,
    };
    this.lastObservation = observation;

    this.window.push(value);
    if (this.window.length > this.totalWindow) {
      this.window.splice(0, this.window.length - this.totalWindow);
    }

    if (!this.isReady()) {
      this.lastMetrics = null;
      this.lastBaseline = [];
      this.lastCurrent = [];
      return null;
    }

    const baseline = this.window.slice(0, this.baselineWindow);
    const current = this.window.slice(this.window.length - this.currentWindow);
    this.lastBaseline = [...baseline];
    this.lastCurrent = [...current];

    const { logger: userLogger, ...restOptions } = this.driftOptions ?? {};
    const featureName = this.featureName ?? restOptions.featureName;
    const evaluationOptions: DriftCheckOptions = {
      ...restOptions,
      featureName,
    };

    if (this.alertLogger || userLogger) {
      evaluationOptions.logger = (message: string, alertContext: DriftAlertContext) => {
        const mergedObservation: DriftObservationContext = {
          ...observation,
          samplesBaseline: baseline.length,
          samplesCurrent: current.length,
          totalSamples: this.samplesSeen,
        };
        if (this.alertLogger) {
          this.alertLogger(message, {
            ...alertContext,
            ...mergedObservation,
            featureName: featureName ?? alertContext.featureName,
          });
        }
        if (userLogger) {
          userLogger(message, alertContext);
        }
      };
    }

    const metrics = evaluateDistributionDrift(baseline, current, evaluationOptions);
    this.lastMetrics = metrics;
    return metrics;
  }

  reset(): void {
    this.window = [];
    this.samplesSeen = 0;
    this.lastMetrics = null;
    this.lastBaseline = [];
    this.lastCurrent = [];
    this.lastObservation = undefined;
  }

  isReady(): boolean {
    return this.window.length >= this.totalWindow;
  }

  getState(): DriftMonitorState {
    return {
      baseline: [...this.lastBaseline],
      current: [...this.lastCurrent],
      metrics: this.lastMetrics ? { ...this.lastMetrics } : null,
      samplesSeen: this.samplesSeen,
      ready: this.isReady(),
      lastObservation: this.lastObservation ? { ...this.lastObservation } : undefined,
    };
  }
}

