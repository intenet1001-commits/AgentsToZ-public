#!/usr/bin/env bun
/**
 * 공개 배포 스크립트 — 현재 main의 파일 상태를 커밋 1개짜리 orphan snapshot으로 만들어
 * publish 리모트에 밀어 넣는다. private 히스토리는 절대 따라가지 않는다.
 *
 *   bun run publish            실제 배포
 *   bun run publish --dry-run  스캔까지만 하고 push는 생략
 *
 * 왜 이 스크립트가 필요한가:
 *  - 별도 index에서 snapshot을 만들어 현재 checkout·작업 파일을 유지한다.
 *  - `git push --all` 을 실수로 치면 private 히스토리가 공개 레포로 넘어간다.
 *    여기서는 refspec을 고정해 그 경로 자체를 없앤다.
 */
import { $ } from "bun";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { githubRepositoryFromRemote, publicationTargetError } from "../src/publicRepositoryRemote";

const PUBLISH_REMOTE = "publish";
const SOURCE_BRANCH = "main";
const DRY_RUN = process.argv.includes("--dry-run");

/** 커밋되면 안 되는 것들. 파일명이 아니라 실제 값의 형태로 잡는다. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Supabase JWT (실제 키)", re: /eyJhbGciOi[A-Za-z0-9._-]{140,}/ },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", re: /\b(ghp_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe API key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Supabase 개인 액세스 토큰", re: /\bsbp_[a-f0-9]{40}\b/ },
  { name: "PEM 개인키", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
/** 공개 저장소에는 운영자의 개인 배포 주소도 남기지 않는다. */
const privatePortalProjectPrefix = ["portmanager", "portal"].join("-");
const vercelHostSuffixPattern = ["vercel", "app"].join("\\.");
const supabaseHostedDomainPattern = ["supabase", "(?:co|in|red)"].join("\\.");
const privateSourceOwner = ["intenet1001", "commits"].join("-");
const privateSourceRepository = ["AgentsToZ", "byCS"].join("_");
const PRIVATE_DEPLOYMENT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "개인용 Vercel 배포 주소",
    // canonical hostname뿐 아니라 Vercel이 만드는 project-prefix deployment alias도 차단한다.
    // 조각을 런타임에 조합해 이 검사 코드 자체가 금지 literal에 걸리지 않게 한다.
    re: new RegExp(
      `(?:^|[^a-z0-9-])${privatePortalProjectPrefix}(?:-[a-z0-9][a-z0-9-]*)?(?:\\.${vercelHostSuffixPattern})?(?=$|[^a-z0-9.-])`,
      "i",
    ),
  },
  {
    name: "비공개 원본 GitHub 저장소 식별자",
    // 제품명이나 공개 저장소 owner는 각각 공개값이다. 둘이 private source identity로
    // 결합된 owner/repository 또는 owner:repository 형태만 차단한다.
    re: new RegExp(
      `(?:^|[^a-z0-9_.-])${privateSourceOwner}(?:/|:)${privateSourceRepository}(?:\\.git)?(?=$|[^a-z0-9_.-])`,
      "i",
    ),
  },
  {
    name: "실제 Supabase project URL",
    // 플레이스홀더가 아닌 hosted project URL은 공개 snapshot에 둘 이유가 없다.
    // 조각을 런타임에 조합해 특정 운영자 project ref를 검사 코드에 새로 남기지 않는다.
    re: new RegExp(`https?:\\/\\/[a-z0-9]{16,64}\\.${supabaseHostedDomainPattern}`, "i"),
  },
];

/** URL 전체가 한두 번 percent-encoded된 문서/QR 링크도 같은 값으로 검사한다. */
function publicationScanVariants(content: string): string[] {
  const variants = [content];
  let candidate = content;
  for (let pass = 0; pass < 2; pass += 1) {
    // 파일 전체를 decodeURIComponent 하면 코드의 평범한 `%` 하나 때문에 throw되어
    // 뒤쪽 encoded URL을 놓친다. 유효한 percent-byte 연속 구간만 독립적으로 푼다.
    const decoded = candidate.replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
      try { return decodeURIComponent(encoded); } catch { return encoded; }
    });
    if (decoded === candidate) break;
    variants.push(decoded);
    candidate = decoded;
  }
  return variants;
}
const PRIVATE_ONLY_PATHS = {
  exact: new Set([
    "CLAUDE.md",
    ".cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc",
  ]),
  prefixes: ["docs/superpowers/", "docs/design/", "docs/handoffs/", "release/"],
  patterns: [/^docs\/PROJECT_MEMORY.*_HANDOFF.*\.md$/i],
};
const isPrivateOnlyPath = (path: string): boolean =>
  PRIVATE_ONLY_PATHS.exact.has(path) ||
  PRIVATE_ONLY_PATHS.prefixes.some(prefix => path.startsWith(prefix)) ||
  PRIVATE_ONLY_PATHS.patterns.some(pattern => pattern.test(path));

class PublishAbort extends Error {}

const die = (msg: string): never => {
  throw new PublishAbort(msg);
};

const LOCAL_PRIVATE_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local",
  ".env.production",
  ".env.production.local",
];
const PRIVATE_SUPABASE_ENV_KEYS = [
  "VITE_SUPABASE_URL",
  "SUPABASE_URL",
  "VITE_VOC_ENDPOINT",
  "AGENTSTOZ_VOC_ENDPOINT",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_PROJECT_ID",
];

/**
 * ignored `.env*`와 현재 프로세스 환경에서 개인 Supabase ref를 메모리로만 얻는다.
 * 값은 로그나 오류에 절대 넣지 않고, 공개 snapshot의 blob과 비교하는 데만 사용한다.
 */
function localPrivateSupabasePatterns(root: string): Array<{ name: string; re: RegExp }> {
  const inputs: string[] = PRIVATE_SUPABASE_ENV_KEYS
    .map(key => process.env[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  for (const filename of LOCAL_PRIVATE_ENV_FILES) {
    const path = resolve(root, filename);
    if (!existsSync(path)) continue;
    try {
      inputs.push(readFileSync(path, "utf8"));
    } catch {
      die(`로컬 개인 Supabase 감사 입력(${filename})을 읽지 못했다.`);
    }
  }

  const refs = new Set<string>();
  const hostedRefSource = `([a-z0-9]{16,64})\\.${supabaseHostedDomainPattern}`;
  const directRef = /^[a-z0-9]{16,64}$/i;
  for (const input of inputs) {
    for (const variant of publicationScanVariants(input)) {
      for (const match of variant.matchAll(new RegExp(hostedRefSource, "gi"))) {
        refs.add(match[1]!.toLowerCase());
      }
      const unquoted = variant.trim().replace(/^[\'"](.*)[\'"]$/, "$1");
      if (directRef.test(unquoted)) refs.add(unquoted.toLowerCase());
      for (const line of variant.split(/\r?\n/)) {
        const assignment = line.match(/^\s*(?:export\s+)?(?:SUPABASE_PROJECT_REF|SUPABASE_PROJECT_ID)\s*=\s*[\'"]?([a-z0-9]{16,64})[\'"]?\s*(?:#.*)?$/i);
        if (assignment) refs.add(assignment[1]!.toLowerCase());
      }
    }
  }

  return [...refs].map(ref => ({
    name: "로컬 환경의 개인 Supabase project ref",
    re: new RegExp(`(?:^|[^a-z0-9])${ref}(?=$|[^a-z0-9])`, "i"),
  }));
}

const sh = async (cmd: string[]): Promise<string> => {
  const result = await $`${cmd}`.env({ ...process.env, GIT_OPTIONAL_LOCKS: "0" }).quiet().nothrow();
  if (result.exitCode !== 0) die(`Git 사전 조회 실패: ${cmd[1] ?? "unknown"}`);
  return result.stdout.toString().trim();
};

const main = async () => {
// ── 1. 사전 점검 ────────────────────────────────────────────────
const branch = await sh(["git", "branch", "--show-current"]);
if (branch !== SOURCE_BRANCH) die(`${SOURCE_BRANCH} 브랜치에서 실행해야 한다 (현재: ${branch || "detached"})`);

const dirty = await sh(["git", "status", "--porcelain"]);
if (dirty) {
  die(
    `커밋되지 않은 변경이 있다. 배포는 커밋된 상태에서만 한다:\n${dirty
      .split("\n")
      .slice(0, 10)
      .map(l => `    ${l}`)
      .join("\n")}`,
  );
}
const localPrivatePatterns = localPrivateSupabasePatterns(process.cwd());

const remotes = await sh(["git", "remote"]);
if (!remotes.split("\n").includes(PUBLISH_REMOTE)) {
  die(
    `'${PUBLISH_REMOTE}' 리모트가 없다. 먼저 등록해라:\n` +
      `    git remote add ${PUBLISH_REMOTE} <공개레포 URL>`,
  );
}

const sourceSha = await sh(["git", "rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(sourceSha)) die("source HEAD를 확인하지 못했다.");
const privatePathResult = await $`git ls-tree -rz --name-only ${sourceSha}`
  .quiet()
  .nothrow();
if (privatePathResult.exitCode !== 0) die("private-only source paths를 확인하지 못했다.");
const trackedPrivatePaths = privatePathResult.stdout
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter(isPrivateOnlyPath);

// A private index builds an orphan commit without checking out another branch,
// removing files, running commit hooks, or replacing an existing candidate ref.
const candidateRef = `refs/agentstoz/publication-candidates/${randomUUID()}`;
const scratch = mkdtempSync(join(tmpdir(), "agentstoz-publication-index-"));
const candidateEnv = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
const assertSourceUnchanged = async () => {
  if (await sh(["git", "rev-parse", "HEAD"]) !== sourceSha
    || await sh(["git", "branch", "--show-current"]) !== SOURCE_BRANCH
    || await sh(["git", "status", "--porcelain"])) die("snapshot 준비 중 source가 변경됐다. 현재 작업은 보존했다.");
};
try {
  console.log("▸ 별도 index에서 공개 snapshot 준비 중...");
  const readTreeResult = await $`git read-tree ${sourceSha}`.env(candidateEnv).quiet().nothrow();
  if (readTreeResult.exitCode !== 0) die("snapshot index를 준비하지 못했다.");
  if (trackedPrivatePaths.length > 0) {
    const removals = Buffer.from(trackedPrivatePaths.map(path => `0 ${"0".repeat(40)}\t${path}\0`).join(""));
    const exclusionResult = await $`git update-index -z --index-info < ${removals}`.env(candidateEnv).quiet().nothrow();
    if (exclusionResult.exitCode !== 0) die("private-only snapshot index 제외를 완료하지 못했다.");
  }
  const treeResult = await $`git write-tree`.env(candidateEnv).quiet().nothrow();
  const treeSha = treeResult.stdout.toString().trim();
  if (treeResult.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) die("snapshot tree를 만들지 못했다.");
  const commitResult = await $`git commit-tree ${treeSha} -m ${"initial: 배포 스냅샷 (히스토리 없음)"}`.quiet().nothrow();
  const candidateSha = commitResult.stdout.toString().trim();
  if (commitResult.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(candidateSha)) die("공개 orphan commit을 만들지 못했다.");

  const modes = await $`git ls-tree -rz ${candidateSha}`.quiet().nothrow();
  if (modes.exitCode !== 0 || modes.stdout.toString().split("\0").filter(Boolean)
    .some(record => !/^100(?:644|755) blob [0-9a-f]{40}\t/.test(record))) {
    die("공개 snapshot에 검증하지 않은 symlink/submodule/file mode가 있다.");
  }
  const filesResult = await $`git ls-tree -rz --name-only ${candidateSha}`.quiet().nothrow();
  if (filesResult.exitCode !== 0) die("공개 snapshot 파일 목록을 읽지 못했다.");
  const files = filesResult.stdout.toString().split("\0").filter(Boolean);
  console.log(`▸ 대상 파일 ${files.length}개`);

  // ── 3. 시크릿 스캔 — 커밋된 blob을 직접 읽는다 (워킹트리가 아니라) ──
  console.log("▸ 시크릿 스캔 중...");
  const hits: string[] = [];
  for (const f of files) {
    const contentResult = await $`git show ${`${candidateSha}:${f}`}`.quiet().nothrow();
    if (contentResult.exitCode !== 0) die(`시크릿 스캔 중 blob을 읽지 못했다: ${f}`);
    const content = contentResult.stdout.toString();
    if (!content) continue;
    const scanVariants = publicationScanVariants(content);
    for (const { name, re } of [...SECRET_PATTERNS, ...PRIVATE_DEPLOYMENT_PATTERNS, ...localPrivatePatterns]) {
      if (scanVariants.some(candidate => re.test(candidate))) hits.push(`${f}  →  ${name}`);
    }
  }

  if (hits.length > 0) {
    die(
      `비밀값 또는 개인 배포 참조가 발견되어 배포를 중단한다:\n${hits.map(h => `    ${h}`).join("\n")}\n\n` +
        `  해당 값을 플레이스홀더로 바꾸거나, 산출물이면 .gitignore 추가 후\n` +
        `  git rm -r --cached <경로> 로 추적을 해제해라.`,
    );
  }
  console.log("  시크릿 없음");
  await assertSourceUnchanged();
  const retain = await $`git update-ref ${candidateRef} ${candidateSha} ${""}`.quiet().nothrow();
  if (retain.exitCode !== 0) die("검증한 candidate 참조를 보존하지 못했다.");
  console.log(`  candidate: ${candidateRef} @ ${candidateSha}`);
  console.log(`  source: ${sourceSha}; tree: ${treeSha}; excluded: ${trackedPrivatePaths.length}`);

  // ── 4. push ────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log(`\n▸ --dry-run 이므로 push 생략`);
    console.log(`  실제 배포: bun run publish`);
  } else {
    const publishRemoteUrl = await sh(["git", "remote", "get-url", PUBLISH_REMOTE]);
    const pushRemoteUrls = (await sh(["git", "remote", "get-url", "--push", "--all", PUBLISH_REMOTE]))
      .split(/\r?\n/)
      .map(url => url.trim())
      .filter(Boolean);
    if (pushRemoteUrls.length !== 1 || pushRemoteUrls[0] !== publishRemoteUrl) {
      die("PUBLISH_PUSH_URL_MISMATCH: publish remote must have exactly one push URL matching its audited fetch URL");
    }
    const repository = githubRepositoryFromRemote(publishRemoteUrl);
    if (!repository) die("publish 리모트가 credential 없는 GitHub 저장소 URL이 아니다.");
    const auditedRepository = repository as string;

    const sourceRepositories = (await Promise.all(
      remotes.split("\n")
        .filter(remote => remote && remote !== PUBLISH_REMOTE)
        .map(async remote => {
          const fetchUrls = (await sh(["git", "remote", "get-url", "--all", remote]))
            .split(/\r?\n/)
            .map(url => url.trim())
            .filter(Boolean);
          const sourcePushUrls = (await sh(["git", "remote", "get-url", "--push", "--all", remote]))
            .split(/\r?\n/)
            .map(url => url.trim())
            .filter(Boolean);
          return [...fetchUrls, ...sourcePushUrls].map(githubRepositoryFromRemote);
        }),
    )).flat().filter((value): value is string => Boolean(value));
    const metadataResult = await $`gh repo view ${auditedRepository} --json viewerPermission,visibility,nameWithOwner`
      .quiet()
      .nothrow();
    let metadata: { viewerPermission?: string; visibility?: string; nameWithOwner?: string } = {};
    try {
      metadata = JSON.parse(metadataResult.stdout.toString());
    } catch {
      die("GitHub target metadata를 안전하게 읽지 못했다.");
    }
    if (metadataResult.exitCode !== 0) die("GitHub target metadata를 안전하게 읽지 못했다.");
    const targetError = publicationTargetError(auditedRepository, sourceRepositories, {
      nameWithOwner: metadata.nameWithOwner ?? "",
      visibility: metadata.visibility ?? "",
    });
    if (targetError) die(targetError);
    const viewerPermission = metadata.viewerPermission ?? "";
    if (!["WRITE", "MAINTAIN", "ADMIN"].includes(viewerPermission)) {
      die(`GitHub write 권한이 필요하다 (현재: ${viewerPermission || "확인 실패"}).`);
    }

    const remoteRef = "refs/heads/main";
    const readRemoteSha = async (): Promise<string> => {
      const result = await $`git ls-remote --heads ${PUBLISH_REMOTE} ${remoteRef}`.quiet().nothrow();
      const sha = result.stdout.toString().trim().split(/\s+/)[0] || "";
      if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
        die("publish/main 원격 SHA를 안전하게 읽지 못했다.");
      }
      return sha;
    };
    const remoteSha = await readRemoteSha();
    const lease = `--force-with-lease=refs/heads/main:${remoteSha}`;
    const refspec = `${candidateSha}:refs/heads/main`;

    const probe = await $`git push --dry-run ${lease} ${PUBLISH_REMOTE} ${refspec}`.quiet().nothrow();
    if (probe.exitCode !== 0) {
      die(`publish dry-run이 실패했다: ${probe.stderr.toString().trim() || "권한/lease 확인 필요"}`);
    }

    await assertSourceUnchanged();
    console.log(`▸ ${PUBLISH_REMOTE} 로 lease-protected push 중...`);
    const pushed = await $`git push ${lease} ${PUBLISH_REMOTE} ${refspec}`.quiet().nothrow();
    if (pushed.exitCode !== 0) {
      die(`publish push가 실패했다: ${pushed.stderr.toString().trim() || "원격 확인 필요"}`);
    }
    if (await readRemoteSha() !== candidateSha) die("push 후 원격 SHA가 candidate와 다르다.");
    console.log(`\n✓ 배포 완료 → https://github.com/${repository}`);
  }
} finally {
  // Only our temporary index is removed; source checkout and refs are untouched.
  rmSync(scratch, { recursive: true, force: true });
}
};

try {
  await main();
} catch (error) {
  if (!(error instanceof PublishAbort)) throw error;
  console.error(`\n✗ ${error.message}\n`);
  process.exitCode = 1;
}
