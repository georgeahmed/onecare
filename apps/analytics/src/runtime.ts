import { createFileSink, resolveAnalyticsSinkPath } from './sink/fileSink';
import { AnalyticsConsumer, startAnalyticsConsumer } from './consumer';
import { TriageDecisionObserver, startTriageDecisionObserver } from './triageDecisionObserver';
import { logger } from '@onecare/observability';
import { getBus, markNatsBusConnected, withMessageGuards } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { Topics } from '@onecare/events';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

async function establishBus(): Promise<MessageBus> {
  const wantsNats = Boolean(process.env.NATS_URL?.trim());
  const bus = withMessageGuards(getBus(), {
    allowedTopics: new Set([Topics.analytics.metric, Topics.triage.decision ?? 'triage.decision']),
  });
  if (!wantsNats) {
    markNatsBusConnected(bus, true);
  }
  return bus;
}

async function main(): Promise<void> {
  const sinkPath = resolveAnalyticsSinkPath();
  logger.info('starting analytics consumer runtime', { sinkPath });

  const bus = await establishBus();
  let consumer: AnalyticsConsumer | null = null;
  let decisionObserver: TriageDecisionObserver | null = null;

  try {
    consumer = await startAnalyticsConsumer({ bus, sink: createFileSink({ filePath: sinkPath }) });
    decisionObserver = await startTriageDecisionObserver({ bus });
    logger.info('analytics consumer ready', { topic: 'analytics.metric' });
    logger.info('triage decision observer ready', { topic: Topics.triage.decision ?? 'triage.decision' });
  } catch (err) {
    logger.error('failed to start analytics consumer', {
      error: err instanceof Error ? err.message : err,
    });
    process.exitCode = 1;
    return;
  }

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (!consumer && !decisionObserver) {
      process.exit(exitCode);
      return;
    }
    logger.info('shutting down analytics consumer', { reason });
    try {
      if (decisionObserver) {
        await decisionObserver.stop();
      }
      if (consumer) {
        await consumer.stop();
      }
    } catch (err) {
      logger.error('error during analytics consumer shutdown', {
        error: err instanceof Error ? err.message : err,
      });
      process.exitCode = exitCode;
      return;
    }
    process.exit(exitCode);
  };

  SHUTDOWN_SIGNALS.forEach((signal) => {
    process.once(signal, () => {
      void shutdown(signal, 0);
    });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection in analytics runtime', {
      reason: reason instanceof Error ? reason.message : reason,
    });
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception in analytics runtime', {
      error: err instanceof Error ? err.message : err,
    });
    void shutdown('uncaughtException', 1);
  });
}

void main();
