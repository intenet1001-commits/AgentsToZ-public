/**
 * Short, stable per-project reference derived from the port's UUID `id`.
 * Surfaced as 「로컬프로젝트해시」 — the name says device-local on purpose.
 *
 * The `id` is minted by `crypto.randomUUID()` when the project is registered on
 * THIS machine, and a cross-device pull deliberately mints a fresh one
 * (`mergePortsFromOtherDevice`), so the same repository carries a different code
 * on every device. That is fine for what this value is for — pasting into a note
 * outside the project — but it is not a shared identity, and calling it 「코드」
 * invited exactly that misreading. Cross-device identity is the GitHub URL's job
 * (and, for memory, `canonicalProjectRepositoryKey` → `memoryId`).
 *
 * Names change (renamed, forked, duplicated across devices) and full UUIDs
 * are unwieldy to type or paste into a note written outside this project —
 * e.g. a blog draft in an unrelated folder that references "which project
 * this came from" without pulling in an absolute local path. The first UUID
 * segment is already 32 bits of randomness, which is enough entropy for a
 * user's own project list (collision odds stay negligible into the low
 * thousands of projects) while staying short enough to read aloud or retype.
 */
export const projectCode = (id: string): string => (id.split('-')[0] || id).toUpperCase();
