import type {AiTerminalAgent} from './aiTerminalProtocol';

export interface WorkroomMentionProject {
  targetId: string;
  label: string;
  projectTargetId?: string;
  scope?: 'main' | 'worktree';
  branch?: string;
  locked?: boolean;
  worktreeCapable?: boolean;
}

/**
 * The Project/Folder registry owns what is visible. Runtime discovery proves
 * executability and contributes live metadata, but cannot add aliases or
 * detached worktrees of its own — only worktrees of a registered project. A temporarily incomplete runtime response
 * must not make a registered project disappear from Workroom.
 */
export function reconcileRegisteredWorkroomTargets(
  registered: readonly WorkroomMentionProject[],
  discovered: readonly WorkroomMentionProject[],
): WorkroomMentionProject[] {
  const runtime = new Map(discovered.map(project => [project.targetId, project]));
  const reconciled = registered.map(project => {
    const live = runtime.get(project.targetId);
    return live ? {...live, ...project, label: project.label} : {...project};
  });
  // A git worktree of a registered project is part of that project even when it was never
  // registered on its own (created in a terminal or by another AI). Without it, a Workroom
  // started from that worktree's row ran but its session tab never appeared. Worktrees with
  // no registered parent stay out.
  const registeredIds = new Set(registered.map(project => project.targetId));
  for (const live of discovered) {
    if (live.scope !== 'worktree' || registeredIds.has(live.targetId)) continue;
    if (!live.projectTargetId || !registeredIds.has(live.projectTargetId)) continue;
    reconciled.push({...live});
    registeredIds.add(live.targetId);
  }
  return reconciled;
}

const key = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();

/** `@` routes the message to that project's Workroom; `#` only references it (several allowed). */
export type WorkroomMentionKind = 'route' | 'reference';

export function workroomMentionQuery(value: string, cursor = value.length): {start: number; query: string; kind: WorkroomMentionKind} | null {
  const before = value.slice(0, Math.max(0, Math.min(value.length, cursor)));
  const match = /(?:^|\s)([@#])([^\s@#]*)$/u.exec(before);
  if (!match || match.index === undefined) return null;
  const at = match.index + (/^[@#]/.test(match[0]) ? 0 : 1);
  return {start: at, query: match[2] ?? '', kind: match[1] === '#' ? 'reference' : 'route'};
}

export function workroomMentionCandidates(
  value: string,
  projects: readonly WorkroomMentionProject[],
  cursor = value.length,
  limit = 8,
): WorkroomMentionProject[] {
  const mention = workroomMentionQuery(value, cursor);
  if (!mention) return [];
  const query = key(mention.query);
  return projects
    .filter(project => !query || key(project.label).includes(query))
    .slice(0, limit);
}

export function selectWorkroomMention(
  value: string,
  cursor: number,
  project: WorkroomMentionProject,
): {value: string; cursor: number; target: WorkroomMentionProject; kind: WorkroomMentionKind} {
  const mention = workroomMentionQuery(value, cursor);
  if (!mention) return {value, cursor, target: project, kind: 'route'};
  const suffix = value.slice(cursor);
  if (mention.kind === 'reference') {
    // The reference stays readable in the message; the host adds its folder on send.
    const token = `#${project.label} `;
    return {value: `${value.slice(0, mention.start)}${token}${suffix.replace(/^\s+/, '')}`, cursor: mention.start + token.length, target: project, kind: 'reference'};
  }
  const next = `${value.slice(0, mention.start)}${suffix}`.replace(/^\s+/, '');
  return {value: next, cursor: Math.max(0, mention.start), target: project, kind: 'route'};
}

/** Exact saved labels only. Natural-language matching never silently routes. */
export function suggestedWorkroomTargets(
  value: string,
  projects: readonly WorkroomMentionProject[],
  selectedTargetId = '',
  referencedTargetIds: readonly string[] = [],
): WorkroomMentionProject[] {
  if (selectedTargetId || !value.trim()) return [];
  // A `#label` is a reference, not a hint to deliver there.
  let normalized = key(value);
  for (const project of projects) normalized = normalized.split(`#${key(project.label)}`).join(' ');
  return projects.filter(project => {
    const label = key(project.label);
    return !referencedTargetIds.includes(project.targetId) && label.length >= 2 && normalized.includes(label);
  }).slice(0, 4);
}

/**
 * The sending AI is named because the receiving session may be a different AI (2026-09-29), and the
 * sending device because the receiver may be another AgentsToZ in the community (2026-10-05): the
 * handoff then has to say which Mac to report back to. Self-contained (the LAN page embeds it).
 */
export function workroomDeliveryInstruction(input: {
  task: string;
  sourceLabel: string;
  sourceAgentLabel?: string;
  sourceDeviceLabel?: string;
  targetLabel: string;
}): string {
  const task = input.task.trim();
  return [
    'AgentsToZ 프로젝트 전달',
    `보낸 프로젝트: ${input.sourceLabel}`,
    ...(input.sourceAgentLabel ? [`보낸 AI: ${input.sourceAgentLabel}`] : []),
    ...(input.sourceDeviceLabel ? [`보낸 기기: ${input.sourceDeviceLabel}`] : []),
    `받는 프로젝트: ${input.targetLabel}`,
    '',
    task,
  ].join('\n');
}

/** What `@` routing reads from a Workroom session summary. */
export interface WorkroomRouteSession {
  id: string;
  targetId: string;
  agent: AiTerminalAgent;
  state: string;
  createdAt?: string;
}
/** The session whose composer is sending. Null when nothing is selected (LAN page). */
export interface WorkroomRouteSource {
  targetId: string;
  agent: AiTerminalAgent;
}
export type WorkroomRoutePlan<S extends WorkroomRouteSession = WorkroomRouteSession> =
  | {kind: 'current'}
  | {kind: 'deliver'; session: S}
  | {kind: 'start'};

/*
 * The routing functions below are self-contained on purpose: the LAN phone page embeds them
 * with `toString()` (remoteControlMobilePage.ts), so they may not reference module scope.
 */

/**
 * Where an `@` route goes for the chosen AI. Routing is not limited to the sender's AI: the same
 * project and AI is the current conversation; otherwise the newest running session of that AI in
 * the target receives it, and only when none runs does a new session start (the handoff becomes
 * its initial prompt instead of being typed into a CLI that is still starting).
 */
export function planWorkroomRoute<S extends WorkroomRouteSession>(
  sessions: readonly S[],
  source: WorkroomRouteSource | null | undefined,
  targetId: string,
  agent: AiTerminalAgent,
): WorkroomRoutePlan<S> {
  if (source && source.targetId === targetId && source.agent === agent) return {kind: 'current'};
  let newest: S | undefined;
  for (const session of sessions) {
    if (session.targetId !== targetId || session.agent !== agent || session.state !== 'running') continue;
    if (!newest || String(session.createdAt ?? '') > String(newest.createdAt ?? '')) newest = session;
  }
  return newest ? {kind: 'deliver', session: newest} : {kind: 'start'};
}

/** The AI an `@` route suggests before the user picks: whoever already runs in the target, else the sender's AI. */
export function defaultWorkroomRouteAgent(
  sessions: readonly WorkroomRouteSession[],
  source: WorkroomRouteSource | null | undefined,
  targetId: string,
  fallback: AiTerminalAgent,
): AiTerminalAgent {
  if (source && source.targetId === targetId) return source.agent;
  let newest: WorkroomRouteSession | undefined;
  for (const session of sessions) {
    if (session.targetId !== targetId || session.state !== 'running') continue;
    if (!newest || String(session.createdAt ?? '') > String(newest.createdAt ?? '')) newest = session;
  }
  return newest ? newest.agent : source ? source.agent : fallback;
}

/** What the route dialog knows about the receiving session (2026-09-29 review, M2/L4). */
export interface WorkroomRouteDetail {
  /** The receiving session's tab label, with ` #n` when that project runs several sessions of the AI. */
  sessionLabel?: string;
  /** Last lines of the receiving session's screen; null when they could not be read. */
  screen?: readonly string[] | null;
  /** The new session cannot carry the message as its first request, so it is typed once the session is ready. */
  typed?: boolean;
}

/**
 * The route dialog. `deliver` types into a live session the user is not looking at, so it always
 * says that Enter is pressed there and shows that session's last lines. `blocked` is a running
 * session waiting on a question or approval: it is never typed into, and the dialog offers a new
 * session instead (OK) or keeps the draft (Cancel). Self-contained: the LAN page embeds it.
 */
export function workroomRouteConfirmation(kind: 'deliver' | 'start' | 'blocked', targetLabel: string, agentName: string, detail: WorkroomRouteDetail = {}): string {
  const screen = detail.screen;
  const screenBlock = screen && screen.length ? ['', '그 세션 화면의 마지막 줄:', ...screen.map(line => `│ ${line}`)] : [];
  const label = detail.sessionLabel ? [`받는 세션: ${detail.sessionLabel}`] : [];
  if (kind === 'deliver') {
    return [
      `‘${targetLabel}’ 프로젝트에서 실행 중인 ${agentName} 워크룸 세션으로 이 메시지를 전달할까요?`,
      ...label,
      '실행 중인 세션에 이 메시지를 입력하고 Enter를 누릅니다.',
      ...(screen === null ? ['그 세션 화면을 확인하지 못했습니다. 질문이나 승인 화면이 떠 있으면 이 입력과 Enter가 그 답이 될 수 있습니다.'] : []),
      ...screenBlock,
    ].join('\n');
  }
  const start = detail.typed
    ? [`‘${targetLabel}’ 프로젝트에 ${agentName} 워크룸 세션을 새로 열고, 준비되면 이 메시지를 입력할까요?`,
      '메시지가 길어 첫 요청에 담지 못합니다. 새 세션 화면이 준비되면 입력하고 Enter를 누르며, 그 화면이 질문(폴더 신뢰·승인 등)을 띄우면 입력하지 않습니다.']
    : [`‘${targetLabel}’ 프로젝트에 ${agentName} 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?`];
  if (kind === 'start') return start.join('\n');
  return [
    `‘${targetLabel}’의 ${agentName} 세션이 질문이나 승인에 대한 답을 기다리는 화면입니다. 이 메시지를 입력하면 Enter가 그 답으로 쓰일 수 있어 그 세션에는 입력하지 않습니다.`,
    ...label,
    ...screenBlock,
    '',
    `대신 ${start[0]}`,
    ...start.slice(1),
    '취소하면 작성 중인 내용을 그대로 둡니다.',
  ].join('\n');
}

/**
 * After delivery the sender stays in its own session; this names the session that received it.
 * `typed`: a new session could not carry the message as its first request (`size`: too long for this
 * connection, `host`: this Mac refused it), so it was typed in once the session was ready.
 */
export function workroomRouteReceipt(input: {started: boolean; targetLabel: string; agentName: string; referencesDropped?: boolean; sessionLabel?: string; typed?: 'size' | 'host'}): string {
  const label = input.sessionLabel ? [`받는 세션: ${input.sessionLabel}`] : [];
  if (!input.started) return [`‘${input.targetLabel}’의 ${input.agentName} 세션에 전달했습니다.`, ...label].join(' ');
  if (input.typed) {
    return [
      `‘${input.targetLabel}’에 새 ${input.agentName} 세션을 열고, 화면이 준비된 뒤 메시지를 입력했습니다.`,
      input.typed === 'size' ? '메시지가 길어 첫 요청에 담지 못했습니다.' : '이 Mac 버전은 새 세션의 첫 요청으로 받지 못했습니다.',
      ...label,
    ].join(' ');
  }
  return [
    `‘${input.targetLabel}’에 새 ${input.agentName} 세션을 열고 첫 요청으로 전달했습니다.`,
    ...(input.referencesDropped ? ['이 Mac 버전은 새 세션에 # 참고 폴더를 함께 넘기지 못해 프로젝트 이름만 전달했습니다.'] : []),
    '처음 여는 폴더라면 그 세션에서 폴더 신뢰 확인이 먼저 나올 수 있습니다.',
    ...label,
  ].join(' ');
}

/** A new session was opened, but the message was not typed: it keeps the draft and says why. */
export function workroomRouteHeldReceipt(input: {targetLabel: string; agentName: string; reason: 'awaiting' | 'timeout' | 'exited'; sessionLabel?: string; screen?: readonly string[] | null}): string {
  const opened = `‘${input.targetLabel}’에 새 ${input.agentName} 세션을 열었지만`;
  const why = input.reason === 'awaiting'
    ? `${opened}, 그 세션이 질문이나 승인에 대한 답을 기다리고 있어 메시지를 입력하지 않았습니다. 그 세션에서 답한 뒤 다시 전달하세요.`
    : input.reason === 'exited'
      ? `${opened}, 그 세션이 곧바로 종료되어 메시지를 입력하지 않았습니다. 그 세션의 마지막 출력을 확인하세요.`
      : `${opened}, 화면이 준비되지 않아 메시지를 입력하지 않았습니다. 그 세션 화면을 확인한 뒤 다시 전달하세요.`;
  const screen = input.reason === 'awaiting' && input.screen?.length ? [`마지막 줄: ${input.screen.slice(-3).join(' / ')}`] : [];
  return [why, ...screen, '작성 중인 내용은 유지했습니다.', ...(input.sessionLabel ? [`받는 세션: ${input.sessionLabel}`] : [])].join(' ');
}

export function workroomRoutePreview(kind: WorkroomRoutePlan['kind'], targetLabel: string, agentName: string, detail: {sessionLabel?: string; typed?: boolean} = {}): string {
  if (kind === 'current') return '현재 세션에 그대로 보냅니다.';
  if (kind === 'deliver') {
    return `‘${targetLabel}’에서 실행 중인 ${agentName} 세션에 전달합니다.${detail.sessionLabel ? ` (받는 세션: ${detail.sessionLabel})` : ''}`;
  }
  return detail.typed
    ? `‘${targetLabel}’에 새 ${agentName} 세션을 열고, 준비되면 메시지를 입력합니다. 첫 요청에 담기에는 긴 메시지입니다.`
    : `‘${targetLabel}’에 새 ${agentName} 세션을 열고 첫 요청으로 전달합니다.`;
}

export function remoteProjectMentionClipboard(name: string, controlId: string): string {
  const hash = controlId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8).toUpperCase();
  return `#${name.trim()} [원격프로젝트해시: ${hash}]`;
}
