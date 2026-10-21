/**
 * What this Mac's common-memory host understands beyond the original request forms. Sent inside the `list` result (an
 * opaque inner payload, so old phones ignore it) so a client can pick the memoryId-native forms without probing:
 * - memory-members: knowledge saves accept {memoryId, mode} members (long-term memory, not a project card).
 * - recall-by-memory: `recall` takes {memoryId, query} for a long-term memory registered on this Mac.
 * - project-links-by-memory: `project-links` takes {memoryId}; this also answers phones ("which groups hold this memory")
 *   in one lookup instead of reading every group.
 * - compact-inspect: a phone's paged `inspect` returns at most 5 source entries per page and keeps `nextOffset`.
 * - lean-read: a knowledge `read` with `withProjects:false` leaves out this Mac's project inventory (about 19 KB for 100
 *   projects, two extra relay frames). The phone loads `projects` only when its long-term-memory picker opens.
 */
export const COMMON_MEMORY_HOST_CAPABILITIES=['memory-members','recall-by-memory','project-links-by-memory','compact-inspect','lean-read'] as const;
export type CommonMemoryHostCapability=typeof COMMON_MEMORY_HOST_CAPABILITIES[number];
/** Source entries per `inspect` page for a remote (phone) owner. */
export const COMMON_MEMORY_REMOTE_INSPECT_PAGE_SIZE=5;
