export type { Metric as AnalyticsMetric } from '@onecare/events/src/contracts/metric';

export {
  ANALYTICS_SINK_PATH_ENV,
  DEFAULT_ANALYTICS_SINK_PATH,
  createFileSink,
  resolveAnalyticsSinkPath,
} from './sink/fileSink';
export type { AnalyticsSink, FileSinkOptions } from './sink/fileSink';
export {
  AnalyticsConsumer,
  AnalyticsMetricSinkError,
  AnalyticsMetricValidationError,
  startAnalyticsConsumer,
} from './consumer';
