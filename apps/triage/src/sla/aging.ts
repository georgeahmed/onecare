import { createCounter, createHistogram, logger } from '@onecare/observability';
import type { ResolvedConfig } from '@onecare/config';
import type { MessageBus } from '@onecare/bus';
import { Topics, createEnvelope, type TaskUpdated } from '@onecare/events';
import type { FhirRepository, QueueNotifier } from '@onecare/ports';
import { callWithGuard } from '../application/guard';
import { safePatientReference, safeTaskReference } from '../support/privacy';

export type PriorityCode = 'STAT' | 'URGENT' | 'SOON' | 'ROUTINE';

export interface TrackTaskInput {
  taskId: string;
  patientId: string;
  priority: PriorityCode;
  createdAt: string;
  correlationId?: string;
  queueName?: string;
  queueNotifier?: QueueNotifier;
  ownerReference?: string;
}

export interface TriageSlaTracker {
  track(task: TrackTaskInput): void;
  resolve(taskId: string): void;
}

export interface TriageSlaSchedulerOptions {
  config: ResolvedConfig;
  fhirRepository: FhirRepository;
  bus: MessageBus;
  now?: () => number;
  maxTasksPerTick?: number;
  maxTickDurationMs?: number;
  jitterRatio?: number;
  agingIntervalOverrideMs?: number;
  handleSignals?: boolean;
}

interface SlaRule {
  thresholdMs: number;
  escalateTo?: PriorityCode;
  reason: string;
}

interface SlaRecord {
  taskId: string;
  patientId: string;
  priority: PriorityCode;
  createdAtMs: number;
  lastTransitionAtMs: number;
  correlationId?: string;
  queueName?: string;
  queueNotifier?: QueueNotifier;
  ownerReference?: string;
}

const slaEscalateCounter = createCounter('sla.escalate');
const slaBreachCounter = createCounter('sla.breach');
const slaScanDuration = createHistogram('sla.scan.duration');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const DEFAULT_MAX_TASKS_PER_TICK = 20;
const DEFAULT_MAX_TICK_DURATION_MS = 750;
const DEFAULT_JITTER_RATIO = 0.2;

const DEFAULT_TARGETS_MS = {
  stat_immediate: 0,
  urgent_first_contact: 2 * 60 * 60 * 1_000,
  soon_same_day: 12 * 60 * 60 * 1_000,
  routine_initial_response: 2 * 24 * 60 * 60 * 1_000,
} as const;

function parseIsoDurationToMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallbackMs;
  }
  const value = raw.trim();
  const regex =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;
  const match = value.match(regex);
  if (!match) {
    return fallbackMs;
  }
  const [
    ,
    years,
    months,
    weeks,
    days,
    hours,
    minutes,
    seconds,
  ] = match;

  const ms =
    (years ? Number(years) * 365 * 24 * 60 * 60 * 1_000 : 0) +
    (months ? Number(months) * 30 * 24 * 60 * 60 * 1_000 : 0) +
    (weeks ? Number(weeks) * 7 * 24 * 60 * 60 * 1_000 : 0) +
    (days ? Number(days) * 24 * 60 * 60 * 1_000 : 0) +
    (hours ? Number(hours) * 60 * 60 * 1_000 : 0) +
    (minutes ? Number(minutes) * 60 * 1_000 : 0) +
    (seconds ? Number(seconds) * 1_000 : 0);

  if (!Number.isFinite(ms) || ms < 0) {
    return fallbackMs;
  }
  return ms;
}

function mapPriorityToFhirCode(priority: PriorityCode): 'stat' | 'urgent' | 'asap' | 'routine' {
  switch (priority) {
    case 'STAT':
      return 'stat';
    case 'URGENT':
      return 'urgent';
    case 'SOON':
      return 'asap';
    case 'ROUTINE':
    default:
      return 'routine';
  }
}

function coerceEpochMs(value: string | undefined, fallback: number, now: () => number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return now();
  }
  return parsed;
}

function buildRules(config: ResolvedConfig): Record<PriorityCode, SlaRule> {
  const rawTargets =
    (config as unknown as { sla_targets?: Record<string, unknown> }).sla_targets ?? {};

  const statMs = parseIsoDurationToMs(rawTargets.stat_immediate, DEFAULT_TARGETS_MS.stat_immediate);
  const urgentMs = parseIsoDurationToMs(
    rawTargets.urgent_first_contact,
    DEFAULT_TARGETS_MS.urgent_first_contact,
  );
  const soonMs = parseIsoDurationToMs(rawTargets.soon_same_day, DEFAULT_TARGETS_MS.soon_same_day);
  const routineMs = parseIsoDurationToMs(
    rawTargets.routine_initial_response,
    DEFAULT_TARGETS_MS.routine_initial_response,
  );

  return {
    ROUTINE: { thresholdMs: routineMs, escalateTo: 'SOON', reason: 'sla_escalation' },
    SOON: { thresholdMs: soonMs, escalateTo: 'URGENT', reason: 'sla_escalation' },
    URGENT: { thresholdMs: urgentMs, escalateTo: 'STAT', reason: 'sla_escalation' },
    STAT: { thresholdMs: Math.max(0, statMs), reason: 'sla_breach' },
  };
}

export class TriageSlaScheduler implements TriageSlaTracker {
  private readonly fhirRepository: FhirRepository;
  private readonly bus: MessageBus;
  private readonly now: () => number;
  private readonly rules: Record<PriorityCode, SlaRule>;
  private readonly maxTasksPerTick: number;
  private readonly maxTickDurationMs: number;
  private readonly jitterRatio: number;
  private readonly agingIntervalMs: number;

  private readonly records = new Map<string, SlaRecord>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;
  private sigtermHandler: (() => void) | null = null;

  constructor(private readonly options: TriageSlaSchedulerOptions) {
    this.fhirRepository = options.fhirRepository;
    this.bus = options.bus;
    this.now = options.now ?? (() => Date.now());
    this.rules = buildRules(options.config);
    this.maxTasksPerTick = Math.max(1, Math.floor(options.maxTasksPerTick ?? DEFAULT_MAX_TASKS_PER_TICK));
    this.maxTickDurationMs = Math.max(100, Math.floor(options.maxTickDurationMs ?? DEFAULT_MAX_TICK_DURATION_MS));
    this.jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? DEFAULT_JITTER_RATIO));
    this.agingIntervalMs = Math.max(
      5_000,
      Math.floor(options.agingIntervalOverrideMs ?? this.resolveIntervalMs(options.config)),
    );
  }

  track(task: TrackTaskInput): void {
    const timestamp = this.now();
    const createdAtMs = coerceEpochMs(task.createdAt, timestamp, this.now);
    const record: SlaRecord = {
      taskId: task.taskId,
      patientId: task.patientId,
      priority: task.priority,
      createdAtMs,
      lastTransitionAtMs: createdAtMs,
      correlationId: task.correlationId,
      queueName: task.queueName,
      queueNotifier: task.queueNotifier,
      ownerReference: task.ownerReference,
    };
    this.records.set(task.taskId, record);
  }

  resolve(taskId: string): void {
    this.records.delete(taskId);
  }

  getPendingCount(): number {
    return this.records.size;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    if (this.options.handleSignals !== false && typeof process !== 'undefined') {
      this.sigtermHandler = () => {
        void this.stop({ reason: 'sigterm' });
      };
      process.once('SIGTERM', this.sigtermHandler);
    }
  }

  async stop(input: { reason?: string } = {}): Promise<void> {
    if (!this.running && !this.tickPromise) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sigtermHandler) {
      process.off('SIGTERM', this.sigtermHandler);
      this.sigtermHandler = null;
    }
    if (this.tickPromise) {
      try {
        await this.tickPromise;
      } catch (error) {
        logger.error('triage.sla.stop_failed', {
          component: 'triage',
          reason: input.reason ?? 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.tickPromise = null;
    }
  }

  private resolveIntervalMs(config: ResolvedConfig): number {
    const triageConfig = (config as unknown as { triage?: Record<string, unknown> }).triage ?? {};
    return parseIsoDurationToMs(triageConfig.aging_interval, DEFAULT_INTERVAL_MS);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    const jitterBounds = Math.floor(this.agingIntervalMs * this.jitterRatio);
    const jitter = jitterBounds > 0 ? Math.floor((Math.random() * 2 - 1) * jitterBounds) : 0;
    const delay = Math.max(0, delayMs > 0 ? delayMs : this.agingIntervalMs + jitter);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.tickPromise = this.runTick()
        .catch((error) => {
          logger.error('triage.sla.tick_failed', {
            component: 'triage',
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.tickPromise = null;
          if (this.running) {
            this.scheduleNext(this.agingIntervalMs);
          }
        });
    }, delay);
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.records.size === 0) {
      return;
    }

    const startedAt = this.now();
    let processed = 0;
    const snapshot = Array.from(this.records.values()).sort(
      (a, b) => a.lastTransitionAtMs - b.lastTransitionAtMs,
    );

    for (const record of snapshot) {
      if (processed >= this.maxTasksPerTick) {
        break;
      }
      const loopNow = this.now();
      if (loopNow - startedAt > this.maxTickDurationMs) {
        logger.info('triage.sla.tick_budget_exhausted', {
          component: 'triage',
          processed,
          remaining: this.records.size - processed,
        });
        break;
      }

      const rule = this.rules[record.priority];
      if (!rule || rule.thresholdMs <= 0) {
        continue;
      }
      const elapsed = loopNow - record.lastTransitionAtMs;
      if (elapsed < rule.thresholdMs) {
        continue;
      }

      if (rule.escalateTo) {
        const escalated = await this.handleEscalation(record, rule, loopNow);
        if (escalated) {
          processed += 1;
        }
      } else {
        const breached = await this.handleBreach(record, loopNow, rule.reason);
        if (breached) {
          processed += 1;
        }
      }
    }

    const duration = this.now() - startedAt;
    slaScanDuration.record(duration, { processed: String(processed) });
  }

  private async handleEscalation(record: SlaRecord, rule: SlaRule, nowMs: number): Promise<boolean> {
    const nextPriority = rule.escalateTo!;
    const previousPriority = record.priority;
    const iso = new Date(nowMs).toISOString();

    const updated = await this.updateTaskRecord(record, {
      resourceType: 'Task',
      id: record.taskId,
      priority: mapPriorityToFhirCode(nextPriority),
      lastModified: iso,
    });

    if (!updated) {
      return false;
    }

    record.priority = nextPriority;
    record.lastTransitionAtMs = nowMs;

    const payload: TaskUpdated = {
      taskId: record.taskId,
      patientId: record.patientId,
      priority: nextPriority,
      previousPriority,
      reason: rule.reason,
      updatedAt: iso,
    };

    await this.publishTaskUpdated(record, payload);
    await this.notifyQueue(record, payload);

    slaEscalateCounter.add(1, {
      from: previousPriority,
      to: nextPriority,
    });
    logger.info('triage.sla.escalated', {
      component: 'triage',
      taskRef: safeTaskReference(record.taskId),
      patientRef: safePatientReference(record.patientId),
      from: previousPriority,
      to: nextPriority,
      correlationId: record.correlationId,
    });
    return true;
  }

  private async handleBreach(record: SlaRecord, nowMs: number, reason: string): Promise<boolean> {
    const iso = new Date(nowMs).toISOString();

    const updated = await this.updateTaskRecord(record, {
      resourceType: 'Task',
      id: record.taskId,
      lastModified: iso,
      businessStatus: { text: 'sla-breached' },
      note: [
        {
          text: `SLA breached (${iso})`,
        },
      ],
    });

    if (!updated) {
      return false;
    }

    const payload: TaskUpdated = {
      taskId: record.taskId,
      patientId: record.patientId,
      priority: record.priority,
      reason,
      breached: true,
      updatedAt: iso,
    };

    await this.publishTaskUpdated(record, payload);
    await this.notifyQueue(record, payload);
    this.records.delete(record.taskId);

    slaBreachCounter.add(1, { priority: record.priority });
    logger.warn('triage.sla.breached', {
      component: 'triage',
      taskRef: safeTaskReference(record.taskId),
      patientRef: safePatientReference(record.patientId),
      priority: record.priority,
      correlationId: record.correlationId,
    });
    return true;
  }

  private async updateTaskRecord(record: SlaRecord, patch: Record<string, unknown>): Promise<boolean> {
    if (typeof this.fhirRepository.updateTask !== 'function') {
      logger.warn('triage.sla.update_task_unsupported', {
        component: 'triage',
        taskRef: safeTaskReference(record.taskId),
      });
      return true;
    }
    try {
      await callWithGuard(
        'fhir.updateTaskPriority',
        async (signal) => {
          void signal;
          await this.fhirRepository.updateTask!(record.taskId, patch);
        },
        {
          correlationId: record.correlationId,
          timeoutMs: 1_500,
          maxRetries: 1,
        },
      );
      return true;
    } catch (error) {
      logger.error('triage.sla.update_task_failed', {
        component: 'triage',
        taskRef: safeTaskReference(record.taskId),
        correlationId: record.correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async publishTaskUpdated(record: SlaRecord, payload: TaskUpdated): Promise<void> {
    const envelope = createEnvelope(Topics.tasks.updated, payload, record.correlationId);
    const headers: Record<string, string> = {
      'x-message-id': envelope.id,
      'x-idempotency-key': `task:${payload.taskId}:${payload.reason}:${payload.priority}`,
    };
    if (record.correlationId) {
      headers['x-correlation-id'] = record.correlationId;
    }
    try {
      await this.bus.publish(Topics.tasks.updated, envelope, headers);
    } catch (error) {
      logger.error('triage.sla.publish_failed', {
        component: 'triage',
        taskRef: safeTaskReference(record.taskId),
        reason: payload.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyQueue(record: SlaRecord, payload: TaskUpdated): Promise<void> {
    if (!record.queueNotifier) {
      return;
    }
    const queue = record.queueName ?? record.ownerReference ?? 'triage.default';
    try {
      await record.queueNotifier.notify(queue, {
        type: payload.reason,
        taskId: payload.taskId,
        patientId: payload.patientId,
        priority: payload.priority,
        timestamp: payload.updatedAt ?? new Date(this.now()).toISOString(),
        breached: payload.breached ?? false,
      });
    } catch (error) {
      logger.warn('triage.sla.queue_notify_failed', {
        component: 'triage',
        queue,
        taskId: record.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startTriageSlaScheduler(options: TriageSlaSchedulerOptions): TriageSlaScheduler {
  const scheduler = new TriageSlaScheduler(options);
  scheduler.start();
  return scheduler;
}
