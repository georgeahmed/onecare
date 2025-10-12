export type PromptHandler = (prompt: string) => Promise<void> | void;

const handlers = new Map<string, PromptHandler>();

export function registerPromptHandler(callId: string, handler: PromptHandler): void {
  if (!callId) return;
  handlers.set(callId, handler);
}

export function unregisterPromptHandler(callId: string): void {
  if (!callId) return;
  handlers.delete(callId);
}

export async function queuePromptForCall(callId: string, prompt: string): Promise<void> {
  const handler = handlers.get(callId);
  if (!handler) return;
  await Promise.resolve(handler(prompt));
}
