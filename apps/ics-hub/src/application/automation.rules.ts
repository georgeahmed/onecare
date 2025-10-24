import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import type { TaskCreated } from '@onecare/events';

export type TaskPriority = TaskCreated['priority'];

export type AutomationRuleCategory = 'recall' | 'repeat' | 'documentation' | 'custom';

export interface AutomationTaskSnapshot {
  taskId: string;
  patientId: string;
  status?: string;
  priority?: TaskPriority;
  owner?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AutomationTriggerEvent {
  topic: string;
  correlationId?: string;
  occurredAt?: string;
  current: AutomationTaskSnapshot;
  previous?: Partial<AutomationTaskSnapshot> | null;
}

export interface PathEqualsCondition {
  path: string;
  equals: unknown;
}

export interface AutomationConditions {
  topics?: string[];
  statusEquals?: string[];
  previousStatusEquals?: string[];
  requireStatusChange?: boolean;
  priorityIn?: TaskPriority[];
  ownerIn?: string[];
  tagsIncludeAny?: string[];
  tagsIncludeAll?: string[];
  pathEquals?: PathEqualsCondition[];
  pathChanged?: string[];
}

export interface AutomationTaskTemplate {
  priority: TaskPriority;
  owner?: string;
  copyPatientId?: boolean;
  patientIdPath?: string;
}

export interface AutomationRule {
  name: string;
  category: AutomationRuleCategory;
  reason: string;
  when: AutomationConditions;
  create: AutomationTaskTemplate;
  debounceWindowSeconds?: number;
}

export interface AutomationTriggerConfig {
  rules: AutomationRule[];
}

export interface AutomationIntent {
  type: 'create_task';
  ruleName: string;
  category: AutomationRuleCategory;
  reason: string;
  sourceTaskId: string;
  correlationId?: string;
  payload: {
    patientId: string;
    priority: TaskPriority;
    owner?: string;
  };
  context: Record<string, unknown>;
  debounceWindowSeconds?: number;
}

export interface AutomationTaskCreation {
  task: TaskCreated;
  ruleName: string;
  reason: string;
  category: AutomationRuleCategory;
  sourceTaskId: string;
  correlationId?: string;
  triggeredAt: string;
  context: Record<string, unknown>;
  debounceWindowSeconds?: number;
}

export interface BuildAutomationTaskOptions {
  createTaskId?: () => string;
  correlationId?: string;
  now?: () => string;
}

export interface AutomationConfigSource {
  json?: string;
  filePath?: string;
  fallback?: AutomationTriggerConfig;
}

const PRIORITY_SET: Set<string> = new Set(['STAT', 'URGENT', 'SOON', 'ROUTINE']);

export function evaluateAutomationTriggers(
  event: AutomationTriggerEvent,
  config: AutomationTriggerConfig | undefined,
): AutomationIntent[] {
  if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
    return [];
  }

  const intents: AutomationIntent[] = [];
  const seenRules = new Set<string>();

  for (const rule of config.rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (seenRules.has(rule.name)) continue;
    if (!matchesRule(event, rule)) continue;

    const patientId = derivePatientId(event, rule.create);
    if (!patientId) continue;

    const payload = {
      patientId,
      priority: rule.create.priority,
      ...(rule.create.owner ? { owner: rule.create.owner } : {}),
    };

    intents.push({
      type: 'create_task',
      ruleName: rule.name,
      category: rule.category,
      reason: rule.reason,
      sourceTaskId: event.current.taskId,
      correlationId: event.correlationId,
      payload,
      context: buildIntentContext(event, rule),
      debounceWindowSeconds: rule.debounceWindowSeconds,
    });
    seenRules.add(rule.name);
  }

  return intents;
}

export function buildAutomationTaskCreations(
  intents: readonly AutomationIntent[],
  options: BuildAutomationTaskOptions = {},
): AutomationTaskCreation[] {
  if (!Array.isArray(intents) || intents.length === 0) {
    return [];
  }

  const createTaskId = options.createTaskId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const correlationId = options.correlationId;

  return intents.map((intent) => {
    const task: TaskCreated = {
      taskId: createTaskId(),
      patientId: intent.payload.patientId,
      priority: intent.payload.priority,
      ...(intent.payload.owner ? { owner: intent.payload.owner } : {}),
    };
    return {
      task,
      ruleName: intent.ruleName,
      reason: intent.reason,
      category: intent.category,
      sourceTaskId: intent.sourceTaskId,
      correlationId: correlationId ?? intent.correlationId,
      triggeredAt: now(),
      context: { ...intent.context },
      debounceWindowSeconds: intent.debounceWindowSeconds,
    };
  });
}

export function loadAutomationConfig(source: AutomationConfigSource = {}): AutomationTriggerConfig {
  const { json, filePath, fallback } = source;
  let raw = json ?? process.env.ICS_AUTOMATION_TRIGGERS;

  if (!raw && (filePath ?? process.env.ICS_AUTOMATION_TRIGGERS_FILE)) {
    const resolved = resolvePath(filePath ?? process.env.ICS_AUTOMATION_TRIGGERS_FILE!);
    raw = readFileSync(resolved, 'utf8');
  }

  if (!raw) {
    return fallback ?? { rules: [] };
  }

  const parsed = parseAutomationConfig(raw);
  return normalizeAutomationConfig(parsed);
}

export function parseAutomationConfig(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`automation_config_parse_failed:${(error as Error).message}`);
  }
}

export function normalizeAutomationConfig(input: unknown): AutomationTriggerConfig {
  const rules = Array.isArray((input as { rules?: unknown }).rules)
    ? ((input as { rules?: unknown }).rules as unknown[])
    : Array.isArray(input)
      ? (input as unknown[])
      : [];

  const normalisedRules = rules.map((rule, index) => normaliseRule(rule, index));
  return {
    rules: normalisedRules.filter((rule): rule is AutomationRule => Boolean(rule)),
  };
}

function normaliseRule(raw: unknown, index: number): AutomationRule | undefined {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`automation_rule_invalid:${index}`);
  }
  const candidate = raw as {
    name?: unknown;
    category?: unknown;
    reason?: unknown;
    when?: unknown;
    create?: unknown;
    debounceWindowSeconds?: unknown;
  };

  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    throw new Error(`automation_rule_name_invalid:${index}`);
  }
  const name = candidate.name.trim();

  const category = typeof candidate.category === 'string' && isValidCategory(candidate.category)
    ? (candidate.category as AutomationRuleCategory)
    : 'custom';

  const reason =
    typeof candidate.reason === 'string' && candidate.reason.trim().length > 0
      ? candidate.reason.trim()
      : name;

  const when = normaliseConditions(candidate.when);

  const create = normaliseTaskTemplate(candidate.create, index);
  const debounceWindowSeconds = normaliseDebounceWindow(candidate.debounceWindowSeconds);

  return {
    name,
    category,
    reason,
    when,
    create,
    ...(debounceWindowSeconds ? { debounceWindowSeconds } : {}),
  };
}

function normaliseConditions(raw: unknown): AutomationConditions {
  if (!raw || typeof raw !== 'object') {
    return { requireStatusChange: true };
  }
  const candidate = raw as Record<string, unknown>;
  return {
    topics: normaliseStringArray(candidate.topics),
    statusEquals: normaliseStringArray(candidate.statusEquals),
    previousStatusEquals: normaliseStringArray(candidate.previousStatusEquals),
    requireStatusChange:
      typeof candidate.requireStatusChange === 'boolean' ? candidate.requireStatusChange : true,
    priorityIn: normalisePriorityArray(candidate.priorityIn),
    ownerIn: normaliseStringArray(candidate.ownerIn),
    tagsIncludeAny: normaliseStringArray(candidate.tagsIncludeAny),
    tagsIncludeAll: normaliseStringArray(candidate.tagsIncludeAll),
    pathEquals: normalisePathEquals(candidate.pathEquals),
    pathChanged: normaliseStringArray(candidate.pathChanged),
  };
}

function normaliseTaskTemplate(raw: unknown, index: number): AutomationTaskTemplate {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`automation_rule_template_invalid:${index}`);
  }
  const candidate = raw as { priority?: unknown; owner?: unknown; copyPatientId?: unknown; patientIdPath?: unknown };
  if (typeof candidate.priority !== 'string' || !PRIORITY_SET.has(candidate.priority)) {
    throw new Error(`automation_rule_priority_invalid:${index}`);
  }
  const copyPatientId =
    typeof candidate.copyPatientId === 'boolean' ? candidate.copyPatientId : true;

  const template: AutomationTaskTemplate = {
    priority: candidate.priority as TaskPriority,
    ...(typeof candidate.owner === 'string' && candidate.owner.trim().length > 0
      ? { owner: candidate.owner.trim() }
      : {}),
    copyPatientId,
    ...(typeof candidate.patientIdPath === 'string' && candidate.patientIdPath.trim().length > 0
      ? { patientIdPath: candidate.patientIdPath.trim() }
      : {}),
  };
  return template;
}

function normaliseDebounceWindow(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  const coerced = Math.floor(parsed);
  const bounded = Math.min(coerced, 30 * 24 * 60 * 60); // cap at 30 days
  return bounded > 0 ? bounded : undefined;
}

function normaliseStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const strings = arr
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function normalisePriorityArray(value: unknown): TaskPriority[] | undefined {
  if (!value) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const prioritised = arr
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => PRIORITY_SET.has(item));
  return prioritised.length > 0 ? (prioritised as TaskPriority[]) : undefined;
}

function normalisePathEquals(value: unknown): PathEqualsCondition[] | undefined {
  if (!value) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const mapped = arr
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const record = item as { path?: unknown; equals?: unknown };
      if (typeof record.path !== 'string' || record.path.trim().length === 0) return undefined;
      return { path: record.path.trim(), equals: record.equals };
    })
    .filter((item): item is PathEqualsCondition => Boolean(item));
  return mapped.length > 0 ? mapped : undefined;
}

function isValidCategory(value: string): value is AutomationRuleCategory {
  return value === 'recall' || value === 'repeat' || value === 'documentation' || value === 'custom';
}

function matchesRule(event: AutomationTriggerEvent, rule: AutomationRule): boolean {
  if (!event || !event.current) return false;
  const conditions = rule.when ?? {};
  const previous = event.previous ?? undefined;

  if (conditions.topics && conditions.topics.length > 0) {
    if (!conditions.topics.includes(event.topic)) {
      return false;
    }
  }

  const statusChanged = previous && typeof previous.status !== 'undefined'
    ? previous.status !== event.current.status
    : true;

  if (conditions.requireStatusChange !== false && !statusChanged) {
    return false;
  }

  if (conditions.statusEquals && conditions.statusEquals.length > 0) {
    if (!conditions.statusEquals.includes(event.current.status ?? '')) {
      return false;
    }
  }

  if (conditions.previousStatusEquals && conditions.previousStatusEquals.length > 0) {
    const prevStatus = previous?.status ?? '';
    if (!conditions.previousStatusEquals.includes(prevStatus)) {
      return false;
    }
  }

  if (conditions.priorityIn && conditions.priorityIn.length > 0) {
    const currentPriority = event.current.priority;
    if (!currentPriority || !conditions.priorityIn.includes(currentPriority)) {
      return false;
    }
  }

  if (conditions.ownerIn && conditions.ownerIn.length > 0) {
    const currentOwner = event.current.owner;
    if (!currentOwner || !conditions.ownerIn.includes(currentOwner)) {
      return false;
    }
  }

  if (conditions.tagsIncludeAny && conditions.tagsIncludeAny.length > 0) {
    const tags = Array.isArray(event.current.tags) ? event.current.tags : [];
    if (!conditions.tagsIncludeAny.some((tag) => tags.includes(tag))) {
      return false;
    }
  }

  if (conditions.tagsIncludeAll && conditions.tagsIncludeAll.length > 0) {
    const tags = Array.isArray(event.current.tags) ? event.current.tags : [];
    if (!conditions.tagsIncludeAll.every((tag) => tags.includes(tag))) {
      return false;
    }
  }

  if (conditions.pathEquals && conditions.pathEquals.length > 0) {
    for (const condition of conditions.pathEquals) {
      const value = getValueByPath(event.current, condition.path);
      if (!isEqual(value, condition.equals)) {
        return false;
      }
    }
  }

  if (conditions.pathChanged && conditions.pathChanged.length > 0) {
    if (!previous) {
      return false;
    }
    const changed = conditions.pathChanged.every((path) => {
      const currentValue = getValueByPath(event.current, path);
      const previousValue = getValueByPath(previous, path);
      return !isEqual(currentValue, previousValue);
    });
    if (!changed) {
      return false;
    }
  }

  return true;
}

function derivePatientId(event: AutomationTriggerEvent, template: AutomationTaskTemplate): string | undefined {
  if (template.copyPatientId === false && template.patientIdPath) {
    const value = getValueByPath(event.current, template.patientIdPath);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }
  if (template.copyPatientId === false) {
    return undefined;
  }
  return event.current.patientId;
}

function buildIntentContext(event: AutomationTriggerEvent, rule: AutomationRule): Record<string, unknown> {
  const context: Record<string, unknown> = {
    topic: event.topic,
    rule: rule.name,
    category: rule.category,
    triggerStatus: event.current.status ?? null,
    previousStatus: event.previous?.status ?? null,
  };
  if (event.current.priority) context.triggerPriority = event.current.priority;
  if (event.current.owner) context.triggerOwner = event.current.owner;
  if (Array.isArray(event.current.tags)) context.triggerTags = [...event.current.tags];
  return context;
}

function getValueByPath(record: Record<string, unknown> | undefined, path: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const segments = path.split('.').filter(Boolean);
  let cursor: unknown = record;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => isEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => isEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
