/** Pinned, reviewed recipe. Changes require a new recipe ID and renewed review. */
export const GITHUB_RECIPE = Object.freeze({
  id:'github-macos-arm64-2.100.0-v2', version:'2.100.0',
  url:'https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_macOS_arm64.zip',
  sha256:'45f9a62da2f6e641a7fad57e2ce39656dfd7ef331372d80a2a2aed65abb01642',
  bytes:14212224, binaryBytes:40024608,
  binarySha256:'51f1bd7ed1724774d2c1d91fb4efdb676d3eb200ce95c0021c8544fe7435bc13',
  entry:'gh_2.100.0_macOS_arm64/bin/gh', teamId:'VEKTX9H2N7',
});
export const ONBOARDING_EXECUTION_PATH='/api/onboarding/github';
export const ONBOARDING_EXECUTION_HEADER='x-agentstoz-onboarding-capability';
export const ONBOARDING_PROOF_DOMAIN='agentstoz-onboarding-health-proof-v1\0';
export type GithubSetupState='reviewed'|'preparing'|'installing'|'installed'|'authenticating'|'ready'|'needs-review'|'storage-review'|'cancelled';
export interface GithubSetupReceipt {
  schema:1; recipe:string; id:string; revision:string; state:GithubSetupState;
  updatedAt:string; reviewedAt:string; ownerPid:number|null; guardPid:number|null;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseGithubReceipt(v:unknown):GithubSetupReceipt {
 const r=v as GithubSetupReceipt;
 if(!r||typeof r!=='object'||r.schema!==1||!uuid.test(r.id)||!uuid.test(r.revision)
  ||typeof r.recipe!=='string'||r.recipe.length>80
  ||!['reviewed','preparing','installing','installed','authenticating','ready','needs-review','storage-review','cancelled'].includes(r.state)
  ||![r.updatedAt,r.reviewedAt].every(t=>typeof t==='string'&&Number.isFinite(Date.parse(t)))
  ||![r.ownerPid,r.guardPid].every(n=>n===null||(Number.isSafeInteger(n)&&n!>1))
  ||Object.keys(r).some(k=>!['schema','recipe','id','revision','state','updatedAt','reviewedAt','ownerPid','guardPid'].includes(k))) throw new Error('기존 설치 기록을 확인하지 못했습니다.');
 return r;
}
export const GITHUB_SETUP_LABELS:Record<GithubSetupState,string>={
 reviewed:'설치 준비 내용을 확인하세요',preparing:'공식 설치 파일을 확인하고 있습니다',
 installing:'GitHub CLI를 이 기기에 설치하고 있습니다',
installed:'설치 확인 · GitHub 연결 가능',
 authenticating:'GitHub 로그인을 기다리고 있습니다',ready:'GitHub 연결 확인',
 'storage-review':'로그인 정보 저장 방식 확인 필요',
 'needs-review':'결과를 다시 확인해 주세요',cancelled:'중단됨 · 다시 확인해서 이어갈 수 있습니다',
};
