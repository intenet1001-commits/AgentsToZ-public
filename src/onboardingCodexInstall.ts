/** Reviewed complete official package; changing it requires a fresh installation review. */
export const CODEX_INSTALL_RECIPE = Object.freeze({
  id: 'codex-macos-arm64-0.154.0-v1', version: '0.154.0',
  url: 'https://releases.openai.com/codex/releases/0.154.0/codex-package-aarch64-apple-darwin.tar.gz',
  bytes: 112327068, sha256: '427ca74c027049e0cd1a330d611e7f8d1fe0f1eb6a6d85ac16f61bcf2cb4a485',
  teamId: '2DC432GLL2',
  files: [
    {entry:'bin/codex',bytes:222655232,sha256:'4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',identifier:'codex'},
    {entry:'bin/codex-code-mode-host',bytes:62786144,sha256:'426d73aaeb2aeef45e98b5add99e8ef9594a31673d281489bb2cb06b38c27423',identifier:'codex-code-mode-host'},
    {entry:'codex-path/rg',bytes:4030432,sha256:'6bbb665c5a40785e74c7ccf1c2e606efa7e70b09540c1e00787c3f88827e668d'},
    {entry:'codex-resources/zsh/bin/zsh',bytes:754208,sha256:'25649b16e12a7b1b26686a9553d8a141866ee445319fddb5263d57784f0fd10b'},
    {entry:'codex-package.json',bytes:200,sha256:'6bace96c38debc466a94cd71d48464df1b1dc27a4ac75d8cebbcb2b6a3a6540c'},
  ],
});
export type CodexInstallState = 'reviewed'|'preparing'|'installing'|'installed'|'configured'|'needs-review'|'cancelled';
export interface CodexInstallReceipt {
  schema:1; recipe:string; revision:string; state:CodexInstallState;
  updatedAt:string; reviewedAt:string; ownerPid:number|null;
}
export function parseCodexInstallReceipt(value:unknown):CodexInstallReceipt {
  const r=value as CodexInstallReceipt;
  if (!r || typeof r!=='object' || r.schema!==1 || typeof r.recipe!=='string' || r.recipe.length>80
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.revision)
    || !['reviewed','preparing','installing','installed','configured','needs-review','cancelled'].includes(r.state)
    || ![r.updatedAt,r.reviewedAt].every(t=>typeof t==='string'&&Number.isFinite(Date.parse(t)))
    || !(r.ownerPid===null || Number.isSafeInteger(r.ownerPid)&&r.ownerPid>1)
    || Object.keys(r).sort().join(',')!=='ownerPid,recipe,reviewedAt,revision,schema,state,updatedAt') throw new Error('설치 기록 확인 필요');
  return r;
}
export const CODEX_INSTALL_LABELS:Record<CodexInstallState,string>={
  reviewed:'설치할 내용을 확인하세요', preparing:'공식 파일을 내려받고 검증하고 있습니다',
  installing:'Codex를 설치하고 있습니다', installed:'설치 확인 · 로그인 단계로 진행하세요',
  configured:'로그인 정보 있음 · 첫 응답을 확인하세요',
  'needs-review':'이전 결과를 확인한 뒤 이어가세요', cancelled:'중단됨 · 설치된 파일은 보존됩니다',
};
