import { createHash } from "node:crypto";
import { normalizeGitHubRepositoryUrl } from "./githubUrls";

/** Stable repository identity shared by SSH/HTTPS clones, distinct for forks. */
export function canonicalProjectRepositoryKey(remoteUrl: string | null | undefined): string | null {
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) return null;
  const github = normalizeGitHubRepositoryUrl(remoteUrl);
  if (github) return github.toLocaleLowerCase();
  try {
    const parsed = new URL(remoteUrl.trim());
    if (!parsed.hostname || !parsed.pathname) return null;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (!path) return null;
    return `${parsed.protocol.toLocaleLowerCase()}//${parsed.hostname.toLocaleLowerCase()}/${path.toLocaleLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * A deterministic proposed UUID closes the simultaneous-fresh-clone gap even
 * before either machine reaches Supabase. The database registry remains the
 * authority and can return an older random ID for an existing repository.
 */
export function proposedMemoryIdForRepository(repositoryKey: string): string {
  const bytes = Buffer.from(createHash("sha256")
    .update(`AgentsToZ/project-memory/v1\n${repositoryKey}`, "utf8")
    .digest()
    .subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // UUID version 5 shape
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
