# Goal-specific common memory SDK

Portable goal, source-evidence, review, publication, recommendation, recall and application contracts.
The app owns `src/commonMemory.ts` and `src/commonMemoryClient.ts`; exports copy these exact files.
No provider, filesystem, Supabase secret, project memory or device ID is bundled.

```ts
import {createCommonMemoryClient,commonMemoryHttpTransport} from '@agentstoz/common-memory-sdk';
const memory=createCommonMemoryClient(commonMemoryHttpTransport('/api/common-memory'));
const candidates=await memory.recommend('SwiftUI iPhone driving game');
// Explain conditions and let the user choose. Recommendations never attach memory.
const capsule=await memory.recall(selectedGroupId,task,selectedRevisionId);
// Pass chosen group/revision/goalVersion as expectedSelections when connecting a project.
// Keep that revision pinned throughout the task. Report actual evidence separately.
```

Supply a custom transport for an authenticated native host or MCP. The local sidecar owns writes;
hosted clients must not embed service-role keys. SDK access does not authorize selecting a group,
changing a source memory, publishing a draft, or treating recall as test success.

Changing a goal or source membership requires fresh review. A source content change invalidates
dependent rules; unchanged evidence can rebase without an AI call. Publications and source
excerpts remain immutable, and in-flight tasks can read their exact historical revision.

Recommendations retrieve candidates from goal metadata and topic aliases. They are not an AI
semantic judgment or proof of relevance. A user/MCP conversation makes the final selection.
The first release supports 16 sources, 500 curated items, 12KB per rule, 1MB aggregate state,
2MB of input source documents per scan and 16KB per recall. Oversize or incomplete reads fail
explicitly, never report an empty result as a successful scan.

Export: `bun export-common-memory-sdk.ts /absolute/SDK/common-memory-sdk`.
`--update` replaces only files whose previous exported hashes still match. Local edits are preserved.
Exports from a working tree are marked unpublished; this command never commits, pushes or publishes.

Version 0.2 adds source catalog/full verified entry reads, paged inspection, durable result checks, and current-member project plans. `projectsStatus` reports device-specific missing projects; `projectsPlan` pins a reviewed root/cloud/group/source/repository snapshot. `projectsAdd(plan, requestId, memoryId)` processes exactly one explicit member. Retrying an unknown result must keep all three values; another member needs a new request. A collection may use draft source membership and does not automatically apply its publication or change the original project goal. Exact existing project bindings can be restored from cloud onto a fresh clone.

The portable project planner uses the app's pure GitHub URL and clone-name helpers. The host retains filesystem authority, per-device registration, clone receipts and root grants. A native/mobile transport needs separately approved cloud management, project/root creation and project binding scopes; SDK methods do not grant them.

LAN WebKit request IDs use secure `getRandomValues` when `randomUUID` is unavailable; request hashes remain identical SHA-256 through [noble-hashes](https://github.com/paulmillr/noble-hashes) when WebCrypto digest is unavailable. Missing secure randomness fails closed. This does not change HTTPS relay encryption or grant permissions.
