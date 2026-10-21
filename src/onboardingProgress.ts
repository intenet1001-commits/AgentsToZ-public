import type { OnboardingPlatform, OnboardingToolDiagnostic } from './onboardingInfrastructure';

export const PREPARATION_TOOLS = ['claude', 'codex', 'antigravity', 'hermes', 'github', 'supabase', 'vercel'] as const;
export type PreparationTool = typeof PREPARATION_TOOLS[number];
export type PreparationState = 'pending' | 'installed' | 'configured' | 'ready' | 'needs-login' | 'missing' | 'unknown' | 'deferred';
export interface PreparationStep { tool: PreparationTool; state: PreparationState; checkedAt: string | null }
export interface OnboardingProgress {
  schemaVersion: 1;
  recipeVersion: 1;
  revision: string;
  runId: string;
  platform: OnboardingPlatform;
  steps: PreparationStep[];
  operation: { id: string; startedAt: string } | null;
  updatedAt: string;
}
export const ONBOARDING_PROGRESS_PATH = '/api/onboarding/progress';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const isPreparationTool = (v: unknown): v is PreparationTool => PREPARATION_TOOLS.includes(v as PreparationTool);
export function preparationSelection(value: unknown): PreparationTool[] {
  if (!Array.isArray(value) || !value.length || value.length > PREPARATION_TOOLS.length
    || value.some(v => !isPreparationTool(v)) || new Set(value).size !== value.length) throw new Error('ONBOARDING_INVALID_INPUT');
  return PREPARATION_TOOLS.filter(tool => value.includes(tool));
}
export function parseOnboardingProgress(value: unknown): OnboardingProgress {
  const p = value as OnboardingProgress;
  if (!p || typeof p !== 'object' || p.schemaVersion !== 1 || p.recipeVersion !== 1
    || !uuid.test(p.revision) || !uuid.test(p.runId) || !['mac', 'windows', 'linux'].includes(p.platform)
    || !time(p.updatedAt) || !Array.isArray(p.steps) || p.steps.length > PREPARATION_TOOLS.length
    || !p.steps.length || new Set(p.steps.map(s => s?.tool)).size !== p.steps.length
    || p.steps.some(s => !s || !isPreparationTool(s.tool)
      || !['pending', 'installed', 'configured', 'ready', 'needs-login', 'missing', 'unknown', 'deferred'].includes(s.state)
      || !(s.checkedAt === null || time(s.checkedAt)))
    || !(p.operation === null || (p.operation && uuid.test(p.operation.id) && time(p.operation.startedAt)))) {
    throw new Error('ONBOARDING_PROGRESS_UNREADABLE');
  }
  // Project paths, credentials and CLI output are not part of this DTO.
  if (Object.keys(p).some(k => !['schemaVersion', 'recipeVersion', 'revision', 'runId', 'platform', 'steps', 'operation', 'updatedAt'].includes(k))
    || p.steps.some(s => Object.keys(s).some(k => !['tool', 'state', 'checkedAt'].includes(k)))
    || (p.operation && Object.keys(p.operation).some(k => !['id', 'startedAt'].includes(k)))) throw new Error('ONBOARDING_PROGRESS_UNREADABLE');
  return p;
}

export function preparationEvidence(tool: PreparationTool, diagnostic?: OnboardingToolDiagnostic): PreparationState {
  if (!diagnostic || diagnostic.id !== tool || diagnostic.state === 'unknown') return 'unknown';
  if (diagnostic.state === 'missing' && diagnostic.installed === false) return 'missing';
  if (diagnostic.state === 'needs-login' && diagnostic.authenticated === false) return 'needs-login';
  if (diagnostic.state === 'ready' && diagnostic.installed === true) {
    // A --version check on an AI binary is not a verified login or first task.
    return diagnostic.authenticationEvidence === 'cached' ? 'configured' : diagnostic.authenticated === true ? 'ready' : 'installed';
  }
  return 'unknown';
}
