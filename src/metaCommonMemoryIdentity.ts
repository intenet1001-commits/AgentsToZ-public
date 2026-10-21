import {createHash} from 'node:crypto';

/** Retry tokens are independent of memory UUIDs; preserve existing UUID receipts. */
export function metaMemoryCreationId(requestId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return requestId.toLowerCase();
  const hash = createHash('sha256').update('agentstoz-meta-memory-create-v1\0').update(requestId).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
