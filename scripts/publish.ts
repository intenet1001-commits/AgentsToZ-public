#!/usr/bin/env bun
/**
 * 공개 배포 스크립트 — 현재 main의 파일 상태를 커밋 1개짜리 orphan 브랜치로 만들어
 * publish 리모트에 밀어 넣는다. private 히스토리는 절대 따라가지 않는다.
 *
 *   bun run publish            실제 배포
 *   bun run publish --dry-run  스캔까지만 하고 push는 생략
 *
 * 왜 이 스크립트가 필요한가:
 *  - orphan 브랜치는 배포할 때마다 새로 만들어야 한다. 손으로 하면 브랜치 전환 중
 *    미커밋 파일과 충돌해서 워킹트리가 엉킨다 (실제로 겪음).
 *  - `git push --all` 을 실수로 치면 private 히스토리가 공개 레포로 넘어간다.
 *    여기서는 refspec을 고정해 그 경로 자체를 없앤다.
 */
import { $ } from "bun";
import { githubRepositoryFromRemote, publicationTargetError } from "../src/publicRepositoryRemote";

const PUBLISH_REMOTE = "publish";
const PUBLISH_BRANCH = "publish-clean";
const SOURCE_BRANCH = "main";
const DRY_RUN = process.argv.includes("--dry-run");

/** 커밋되면 안 되는 것들. 파일명이 아니라 실제 값의 형태로 잡는다. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Supabase JWT (실제 키)", re: /eyJhbGciOi[A-Za-z0-9._-]{140,}/ },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", re: /\b(ghp_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Supabase 개인 액세스 토큰", re: /\bsbp_[a-f0-9]{40}\b/ },
  { name: "PEM 개인키", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
const PRIVATE_ONLY_PATHS = {
  exact: new Set([
    "CLAUDE.md",
    ".cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc",
  ]),
  prefixes: ["docs/superpowers/"],
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

const sh = async (cmd: string[]): Promise<string> =>
  (await $`${cmd}`.quiet().nothrow().text()).trim();

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

const remotes = await sh(["git", "remote"]);
if (!remotes.split("\n").includes(PUBLISH_REMOTE)) {
  die(
    `'${PUBLISH_REMOTE}' 리모트가 없다. 먼저 등록해라:\n` +
      `    git remote add ${PUBLISH_REMOTE} <공개레포 URL>`,
  );
}

const privatePathResult = await $`git ls-tree -rz --name-only ${SOURCE_BRANCH}`
  .quiet()
  .nothrow();
if (privatePathResult.exitCode !== 0) die("private-only source paths를 확인하지 못했다.");
const trackedPrivatePaths = privatePathResult.stdout
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter(isPrivateOnlyPath);

// ── 2. orphan 브랜치 재생성 ─────────────────────────────────────
console.log(`▸ ${PUBLISH_BRANCH} 재생성 중...`);
await $`git branch -D ${PUBLISH_BRANCH}`.quiet().nothrow();
const checkoutResult = await $`git checkout --orphan ${PUBLISH_BRANCH}`.quiet().nothrow();
if (checkoutResult.exitCode !== 0) {
  die(`orphan 브랜치를 만들지 못했다: ${checkoutResult.stderr.toString().trim() || "git checkout 실패"}`);
}

// checkout --orphan 이후 반드시 main으로 되돌린다. 중간에 죽어도 워킹트리를 남기지 않는다.
const backToMain = async () => {
  if (trackedPrivatePaths.length > 0) {
    const restoreResult = await $`git checkout ${SOURCE_BRANCH} -- ${trackedPrivatePaths}`.quiet().nothrow();
    if (restoreResult.exitCode !== 0) die("private-only source files를 복원하지 못했다.");
  }
  const returnResult = await $`git checkout ${SOURCE_BRANCH}`.quiet().nothrow();
  if (returnResult.exitCode !== 0) die(`${SOURCE_BRANCH} 브랜치로 돌아오지 못했다.`);
};

try {
  const exclusionResult = trackedPrivatePaths.length > 0
    ? await $`git rm --cached --ignore-unmatch -- ${trackedPrivatePaths}`.quiet().nothrow()
    : null;
  if (exclusionResult && exclusionResult.exitCode !== 0) {
    die(`private-only 파일을 snapshot에서 제외하지 못했다: ${exclusionResult.stderr.toString().trim() || "git rm 실패"}`);
  }
  const commitResult = await $`git commit -q -m ${"initial: 배포 스냅샷 (히스토리 없음)"}`.quiet().nothrow();
  if (commitResult.exitCode !== 0) {
    die(`공개 snapshot commit을 만들지 못했다: ${commitResult.stderr.toString().trim() || "git commit 실패"}`);
  }

  const filesResult = await $`git ls-tree -rz --name-only ${PUBLISH_BRANCH}`.quiet().nothrow();
  if (filesResult.exitCode !== 0) die("공개 snapshot 파일 목록을 읽지 못했다.");
  const files = filesResult.stdout.toString().split("\0").filter(Boolean);
  console.log(`▸ 대상 파일 ${files.length}개`);

  // ── 3. 시크릿 스캔 — 커밋된 blob을 직접 읽는다 (워킹트리가 아니라) ──
  console.log("▸ 시크릿 스캔 중...");
  const hits: string[] = [];
  for (const f of files) {
    const contentResult = await $`git show ${`${PUBLISH_BRANCH}:${f}`}`.quiet().nothrow();
    if (contentResult.exitCode !== 0) die(`시크릿 스캔 중 blob을 읽지 못했다: ${f}`);
    const content = contentResult.stdout.toString();
    if (!content) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(content)) hits.push(`${f}  →  ${name}`);
    }
  }

  if (hits.length > 0) {
    die(
      `시크릿이 발견되어 배포를 중단한다:\n${hits.map(h => `    ${h}`).join("\n")}\n\n` +
        `  해당 값을 플레이스홀더로 바꾸거나, 산출물이면 .gitignore 추가 후\n` +
        `  git rm -r --cached <경로> 로 추적을 해제해라.`,
    );
  }
  console.log("  시크릿 없음");

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
    const candidateSha = await sh(["git", "rev-parse", PUBLISH_BRANCH]);
    const lease = `--force-with-lease=refs/heads/main:${remoteSha}`;
    const refspec = `${PUBLISH_BRANCH}:main`;

    const probe = await $`git push --dry-run ${lease} ${PUBLISH_REMOTE} ${refspec}`.quiet().nothrow();
    if (probe.exitCode !== 0) {
      die(`publish dry-run이 실패했다: ${probe.stderr.toString().trim() || "권한/lease 확인 필요"}`);
    }

    console.log(`▸ ${PUBLISH_REMOTE} 로 lease-protected push 중...`);
    const pushed = await $`git push ${lease} ${PUBLISH_REMOTE} ${refspec}`.quiet().nothrow();
    if (pushed.exitCode !== 0) {
      die(`publish push가 실패했다: ${pushed.stderr.toString().trim() || "원격 확인 필요"}`);
    }
    if (await readRemoteSha() !== candidateSha) die("push 후 원격 SHA가 candidate와 다르다.");
    console.log(`\n✓ 배포 완료 → https://github.com/${repository}`);
  }
} finally {
  await backToMain();
  const now = await sh(["git", "branch", "--show-current"]);
  if (now !== SOURCE_BRANCH) die(`브랜치 복구 검증 실패 (현재: ${now || "detached"}).`);
}
};

try {
  await main();
} catch (error) {
  if (!(error instanceof PublishAbort)) throw error;
  console.error(`\n✗ ${error.message}\n`);
  process.exitCode = 1;
}
