export function resolveServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT ?? env.PORT_ORCHESTRATOR;
  if (!raw) return 3001;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(parsed)) {
    return 3001;
  }
  return parsed;
}

