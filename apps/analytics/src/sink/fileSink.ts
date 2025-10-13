import { appendFile, mkdir, open } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { Metric } from '@onecare/events';

/**
 * Overrides where analytics metrics are written. Accepts absolute or relative paths.
 */
export const ANALYTICS_SINK_PATH_ENV = 'ANALYTICS_SINK_PATH';
export const DEFAULT_ANALYTICS_SINK_PATH = 'var/analytics/metrics.jsonl';

export interface AnalyticsSink {
  write(metric: Metric): Promise<void>;
}

export interface FileSinkOptions {
  /**
   * Optional absolute or relative path to override where metrics are written.
   * Relative paths resolve from the current working directory.
   */
  filePath?: string;
  /**
   * Optional environment bag used when resolving the sink path.
   * Defaults to the running process environment.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the analytics sink path using the provided environment (defaults to process env).
 */
export const resolveAnalyticsSinkPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env[ANALYTICS_SINK_PATH_ENV]?.trim();
  const target = configured && configured.length > 0 ? configured : DEFAULT_ANALYTICS_SINK_PATH;
  return resolve(target);
};

export const createFileSink = (options: FileSinkOptions = {}): AnalyticsSink => {
  const filePath = options.filePath ? resolve(options.filePath) : resolveAnalyticsSinkPath(options.env);
  let readiness: Promise<void> | undefined;

  const ensureReady = async (): Promise<void> => {
    if (!readiness) {
      readiness = (async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const handle = await open(filePath, 'a');
        await handle.close();
      })();
    }
    await readiness;
  };

  return {
    async write(metric: Metric): Promise<void> {
      await ensureReady();
      const line = `${JSON.stringify(metric)}\n`;
      await appendFile(filePath, line, { encoding: 'utf8' });
    },
  };
};
