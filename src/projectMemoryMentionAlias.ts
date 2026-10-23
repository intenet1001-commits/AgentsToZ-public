import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MENTION_ALIAS_SCHEMA_VERSION = 1 as const;

export interface MentionAliasRecord {
  memoryId: string;
  primaryAlias: string;
  redirects: string[];
  updatedAt: string;
}

export interface SharedMentionAliasRow {
  alias: string;
  memory_id: string;
  status: "primary" | "redirect";
  updated_at: string;
}

interface MentionAliasRegistryFile {
  schemaVersion: typeof MENTION_ALIAS_SCHEMA_VERSION;
  aliases: MentionAliasRecord[];
}

export function normalizeMentionAlias(value: string): string | null {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    // Keep this alphabet identical to the Postgres CHECK/RPC contract. In
    // particular, Hangul is intentional; accepting arbitrary Unicode here and
    // rejecting it only in SQL makes a suggestion look saveable when it is not.
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || null;
}

function mentionLookupAlias(value: string): string | null {
  const raw = (value.startsWith("#") ? value.slice(1) : value).trim();
  const lower = raw.toLowerCase();
  const normalized = normalizeMentionAlias(raw);
  return normalized && normalized === lower ? normalized : null;
}

export function resolveSharedMentionAlias(
  rows: SharedMentionAliasRow[],
  aliasValue: string,
): { memoryId: string; alias: string; redirected: boolean } | null {
  const requested = mentionLookupAlias(aliasValue);
  if (!requested) return null;
  const matches = rows.filter(row => row.alias === requested);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const primaries = rows.filter(row => row.memory_id === match.memory_id && row.status === "primary");
  if (primaries.length !== 1) return null;
  return {
    memoryId: match.memory_id,
    alias: primaries[0]!.alias,
    redirected: match.status === "redirect",
  };
}

export function groupSharedMentionAliases(rows: SharedMentionAliasRow[]): MentionAliasRecord[] {
  const memoryIds = [...new Set(rows.map(row => row.memory_id))];
  return memoryIds.map(memoryId => {
    const records = rows.filter(row => row.memory_id === memoryId);
    const primaries = records.filter(row => row.status === "primary");
    if (primaries.length !== 1) throw new Error(`invalid shared mention primary count: ${memoryId}`);
    const primary = primaries[0]!;
    return {
      memoryId,
      primaryAlias: primary.alias,
      redirects: records.filter(row => row.status === "redirect").map(row => row.alias).sort(),
      updatedAt: primary.updated_at,
    };
  }).sort((a, b) => a.primaryAlias.localeCompare(b.primaryAlias));
}

export class MentionAliasRegistry {
  constructor(private readonly filePath: string) {}

  private read(): MentionAliasRegistryFile {
    if (!existsSync(this.filePath)) return { schemaVersion: MENTION_ALIAS_SCHEMA_VERSION, aliases: [] };
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as MentionAliasRegistryFile;
    if (parsed.schemaVersion !== MENTION_ALIAS_SCHEMA_VERSION || !Array.isArray(parsed.aliases)) {
      throw new Error("unsupported mention alias registry schema");
    }
    return parsed;
  }

  private write(registry: MentionAliasRegistryFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  list(): MentionAliasRecord[] {
    return this.read().aliases;
  }

  replace(records: MentionAliasRecord[]): void {
    const aliases = new Set<string>();
    const memoryIds = new Set<string>();
    for (const record of records) {
      if (!record.memoryId || memoryIds.has(record.memoryId)) throw new Error("duplicate or missing mention memoryId");
      memoryIds.add(record.memoryId);
      for (const alias of [record.primaryAlias, ...record.redirects]) {
        if (!mentionLookupAlias(alias) || aliases.has(alias)) throw new Error(`invalid or duplicate mention alias: ${alias}`);
        aliases.add(alias);
      }
    }
    this.write({ schemaVersion: MENTION_ALIAS_SCHEMA_VERSION, aliases: records });
  }

  resolve(aliasValue: string): { memoryId: string; alias: string; redirected: boolean } | null {
    const alias = mentionLookupAlias(aliasValue);
    if (!alias) return null;
    const matches = this.read().aliases.filter(record =>
      record.primaryAlias === alias || record.redirects.includes(alias),
    );
    if (matches.length !== 1) return null;
    const record = matches[0]!;
    return { memoryId: record.memoryId, alias: record.primaryAlias, redirected: record.primaryAlias !== alias };
  }

  save(memoryIdValue: string, aliasValue: string): MentionAliasRecord {
    const memoryId = memoryIdValue.trim();
    const alias = normalizeMentionAlias(aliasValue);
    if (!memoryId) throw new Error("memoryId is required");
    if (!alias || alias !== aliasValue.trim().toLowerCase().replace(/\s+/g, "-")) {
      // Human input may contain ordinary spaces/case. Unicode letters and
      // numbers are intentional so project names can be used directly, e.g.
      // #샵 or #한글-프로젝트.
      if (!alias) throw new Error("invalid mention alias");
    }
    const registry = this.read();
    const reserved = registry.aliases.find(record =>
      record.memoryId !== memoryId && (record.primaryAlias === alias || record.redirects.includes(alias)),
    );
    if (reserved) throw new Error(`mention alias already reserved: ${alias}`);
    const existing = registry.aliases.find(record => record.memoryId === memoryId);
    const redirects = (existing?.redirects ?? []).filter(redirect => redirect !== alias);
    if (existing && existing.primaryAlias !== alias && !redirects.includes(existing.primaryAlias)) {
      redirects.push(existing.primaryAlias);
    }
    const updated: MentionAliasRecord = {
      memoryId,
      primaryAlias: alias,
      redirects,
      updatedAt: new Date().toISOString(),
    };
    if (existing) registry.aliases[registry.aliases.indexOf(existing)] = updated;
    else registry.aliases.push(updated);
    this.write(registry);
    return updated;
  }
}
