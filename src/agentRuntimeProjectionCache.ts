import type { AgentTaskProjection } from './agentRuntimeState';

export const AGENT_RUNTIME_PROJECTION_CACHE_LIMIT = 10;
export const AGENT_RUNTIME_PROJECTION_CACHE_BYTES = 8 * 1024 * 1024;
const eventSizes = new WeakMap<object, number>();
const projectionSizes = new WeakMap<AgentTaskProjection, number>();

// Estimates retained UTF-16 strings and container overhead without serializing
// payloads into a second large string. Unchanged event objects are counted once.
function estimatedValueBytes(value: unknown): number {
  let bytes = 0;
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      bytes += 24 + item.length * 2;
      continue;
    }
    if (!item || typeof item !== 'object') {
      bytes += 8;
      continue;
    }
    if (seen.has(item)) continue;
    seen.add(item);
    bytes += 32;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      bytes += 16 + key.length * 2;
      pending.push((item as Record<string, unknown>)[key]);
    }
  }
  return bytes;
}

export function estimatedAgentRuntimeProjectionBytes(projection: AgentTaskProjection): number {
  const cached = projectionSizes.get(projection);
  if (cached !== undefined) return cached;
  let bytes = 128 + (projection.taskId?.length ?? 0) * 2 + projection.events.length * 8;
  for (const event of projection.events) {
    let size = eventSizes.get(event);
    if (size === undefined) {
      size = estimatedValueBytes(event);
      eventSizes.set(event, size);
    }
    bytes += size;
  }
  projectionSizes.set(projection, bytes);
  return bytes;
}

/** Evicts only transient UI copies. Missing projections restart at journal cursor zero. */
export function retainAgentRuntimeProjection(
  cache: ReadonlyMap<string, AgentTaskProjection>,
  taskId: string,
  projection: AgentTaskProjection,
  activeTaskId: string | null,
  limit = AGENT_RUNTIME_PROJECTION_CACHE_LIMIT,
): ReadonlyMap<string, AgentTaskProjection> {
  const next = new Map(cache);
  next.delete(taskId);
  next.set(taskId, projection);
  let bytes = 0;
  for (const value of next.values()) bytes += estimatedAgentRuntimeProjectionBytes(value);
  for (const id of next.keys()) {
    if (next.size <= Math.max(1, limit) && bytes <= AGENT_RUNTIME_PROJECTION_CACHE_BYTES) break;
    if (id !== activeTaskId) {
      bytes -= estimatedAgentRuntimeProjectionBytes(next.get(id)!);
      next.delete(id);
    }
  }
  return next;
}

export function pruneAgentRuntimeProjections(
  cache: ReadonlyMap<string, AgentTaskProjection>,
  taskIds: ReadonlySet<string>,
  activeTaskId: string | null,
): ReadonlyMap<string, AgentTaskProjection> {
  const next = new Map([...cache].filter(([id]) => id === activeTaskId || taskIds.has(id)));
  return next.size === cache.size ? cache : next;
}
