import { mkdir, open } from 'fs/promises';
import { dirname, resolve } from 'path';
import { homedir, tmpdir } from 'os';
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
  return resolve(expandHomePath(target));
};

export const createFileSink = (options: FileSinkOptions = {}): AnalyticsSink => {
  let activePath = options.filePath ? resolve(expandHomePath(options.filePath)) : resolveAnalyticsSinkPath(options.env);
  const fallbackPath = resolve(tmpdir(), 'onecare', 'analytics', 'metrics.jsonl');

  const writeLine = async (line: string, attempt = 0): Promise<void> => {
    try {
      await mkdir(dirname(activePath), { recursive: true });
      const handle = await open(activePath, 'a');
      try {
        await handle.appendFile(line, { encoding: 'utf8' });
        await handle.datasync();
      } catch (err) {
        if (!isIgnorableSyncError(err)) {
          throw err;
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (isPermissionDeniedError(err) && activePath !== fallbackPath) {
        console.warn('[AnalyticsSink] falling back to tmp path after permission error', {
          originalPath: activePath,
          fallbackPath,
        });
        activePath = fallbackPath;
        await writeLine(line, attempt);
        return;
      }
      if (isRecoverableFsError(err) && attempt < MAX_WRITE_RETRIES) {
        await writeLine(line, attempt + 1);
        return;
      }
      throw err;
    }
  };

  return {
    async write(metric: Metric): Promise<void> {
      const line = `${JSON.stringify(metric, jsonReplacer)}\n`;
      await writeLine(line);
    },
  };
};

const MAX_WRITE_RETRIES = 3;

function normalizeErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const candidate = (error as { code?: unknown }).code;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim().toUpperCase();
  }
  return null;
}

function isRecoverableFsError(error: unknown): boolean {
  const code = normalizeErrorCode(error);
  if (!code) return false;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EBADF' || code === 'EISDIR' || code === 'EBUSY';
}

function isIgnorableSyncError(error: unknown): boolean {
  const code = normalizeErrorCode(error);
  return code === 'ENOSYS' || code === 'EINVAL';
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = normalizeErrorCode(error);
  return code === 'EACCES' || code === 'EROFS';
}

function expandHomePath(pathCandidate: string): string {
  if (!pathCandidate.startsWith('~')) {
    return pathCandidate;
  }
  const home = homedir();
  if (!home) {
    return pathCandidate;
  }
  const remainder = pathCandidate.slice(1).replace(/^\/+/, '');
  return resolve(home, remainder);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}
