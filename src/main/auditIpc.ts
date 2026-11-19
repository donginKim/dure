import type { AuditInput } from '@core/audit';
import type { Core } from '@core/index';
import type { AuditOutcome } from '@shared/types';

type Detail = Record<string, string | number | boolean | null>;
interface Spec {
  /** 감사 기록의 동작 이름 (바꾸지 않는다) */
  action: string;
  /** 첫 인자가 무엇인가: 워크스페이스 id, 프로젝트 id, 또는 둘 다 아님 */
  scope?: 'w' | 'p';
  /** 대상의 이름·식별자 (본문은 적지 않는다) */
  target?: (a: unknown[]) => unknown;
  detail?: (a: unknown[]) => Detail;
  /** 사용자가 거절한 것처럼 결과가 인자에 있는 경우 */
  outcome?: (a: unknown[]) => AuditOutcome;
  project?: (a: unknown[]) => unknown;
}
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const o = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const len = (v: unknown): number => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 0);
const first = (a: unknown[]): unknown => a[0];
const allow = (a: unknown[]): AuditOutcome => (a[1] === true ? 'ok' : 'denied');

/**
 * 사용자가 화면에서 한 일 가운데 감사 기록에 남기는 것. 여기에 없는 채널(읽기, 화면 조작)은 적지 않는다.
 * 글의 본문(메시지, 프롬프트, SQL, 명령)은 적지 않고 길이·개수·이름만 적는다.
 */
export const AUDITED: Record<string, Spec> = {
  // 프로젝트·저장소·워크스페이스
  'projects.create': { action: 'project.create', target: first },
  'projects.remove': { action: 'project.remove', scope: 'p' },
  'projects.reopen': { action: 'project.reopen', scope: 'p' },
  'cleanup.complete': { action: 'project.complete', scope: 'p' },
  'projects.setAutoShip': { action: 'project.autoship', scope: 'p', detail: (a) => ({ mode: s(a[1]) }) },
  'projects.setBudget': { action: 'project.budget', scope: 'p', detail: (a) => ({ daily: Number(a[1]) || 0, total: Number(a[2]) || 0 }) },
  'projects.allowToday': { action: 'project.budget.allow_today', scope: 'p' },
  'repos.add': { action: 'repo.add', scope: 'p', target: (a) => a[1] },
  'repos.remove': { action: 'repo.remove', target: first },
  'repos.setVerify': { action: 'repo.verify_command', target: first, detail: (a) => ({ length: len(a[1]) }) },
  'workspaces.create': { action: 'workspace.create', project: (a) => o(a[0]).projectId, target: (a) => o(a[0]).name, detail: (a) => ({ agent: s(o(a[0]).agentKind), permissionMode: s(o(a[0]).permissionMode), base: s(o(a[0]).baseBranch) }) },
  'workspaces.remove': { action: 'workspace.remove', scope: 'w' },
  'workspaces.setPermissionMode': { action: 'workspace.permission_mode', scope: 'w', detail: (a) => ({ mode: s(a[1]) }) },
  'workspaces.setModel': { action: 'workspace.model', scope: 'w', detail: (a) => ({ model: s(a[1]) }) },
  'workspaces.setEngine': { action: 'workspace.engine', scope: 'w', detail: (a) => ({ engine: s(a[1]) }) },
  'workspaces.trustAgentConfig': { action: 'agent_config.trust', scope: 'w', detail: (a) => ({ hash: s(a[1]).slice(0, 16) }) },
  // 에이전트
  'terminals.startAgent': { action: 'agent.start', scope: 'w' },
  'terminals.openShell': { action: 'shell.open', scope: 'w' },
  'workspaces.stopAgent': { action: 'agent.stop', scope: 'w' },
  'workspaces.interrupt': { action: 'agent.interrupt', scope: 'w' },
  'chat.send': { action: 'agent.prompt', scope: 'w', detail: (a) => ({ length: len(a[1]) }) },
  'chat.answerPermission': { action: 'agent.permission', scope: 'w', outcome: (a) => (a[1] === 'deny' ? 'denied' : 'ok'), detail: (a) => ({ answer: s(a[1]) }) },
  'chat.answerQuestion': { action: 'agent.question.answer', scope: 'w' },
  'chat.dismissQuestion': { action: 'agent.question.dismiss', scope: 'w' },
  'messages.send': { action: 'message.send', project: (a) => o(a[0]).projectId, target: (a) => o(a[0]).toWorkspaceId, detail: (a) => ({ length: len(o(a[0]).body) }) },
  'messages.pauseProject': { action: 'message.pause_project', scope: 'p', detail: (a) => ({ paused: a[1] === true }) },
  'messages.resume': { action: 'message.resume', scope: 'p' },
  // 계획과 할 일
  'coordinator.approve': { action: 'plan.approve', target: first },
  'coordinator.reject': { action: 'plan.reject', target: first, outcome: () => 'denied' },
  'coordinator.revise': { action: 'plan.revise', target: first },
  'todos.add': { action: 'todo.add', project: (a) => o(a[0]).projectId, target: (a) => o(a[0]).workspaceId, detail: (a) => ({ assignee: s(o(a[0]).assignee) }) },
  'todos.update': { action: 'todo.update', target: first, detail: (a) => ({ fields: Object.keys(o(a[1])).join(',') }) },
  'todos.remove': { action: 'todo.remove', target: first },
  'schedules.save': { action: 'schedule.save', project: (a) => o(a[0]).projectId, target: (a) => o(a[0]).title },
  'schedules.remove': { action: 'schedule.remove', target: first },
  'schedules.setEnabled': { action: 'schedule.enable', target: first, detail: (a) => ({ on: a[1] === true }) },
  'schedules.runNow': { action: 'schedule.run_now', target: first },
  'memory.add': { action: 'memory.add', scope: 'p', detail: (a) => ({ kind: s(a[1]), length: len(a[2]) }) },
  'memory.remove': { action: 'memory.remove', target: first },
  'agreements.save': { action: 'agreement.save', scope: 'p', target: (a) => o(a[1]).title },
  'agreements.accept': { action: 'agreement.accept', target: first },
  'agreements.remove': { action: 'agreement.remove', target: first },
  // 코드
  'commit.run': { action: 'commit.create', scope: 'w', detail: (a) => ({ files: len(o(a[1]).files) }) },
  'commit.push': { action: 'commit.push', scope: 'w' },
  'pr.create': { action: 'pr.create', scope: 'w' },
  'merge.prepare': { action: 'merge.prepare', scope: 'p', target: (a) => a[2] },
  'merge.advance': { action: 'merge.advance', scope: 'p', target: (a) => a[2] },
  'checkpoints.restore': { action: 'checkpoint.restore', target: first },
  'verify.run': { action: 'verify.run', scope: 'w' },
  'review.run': { action: 'review.run', scope: 'w' },
  'cleanup.restore': { action: 'cleanup.restore', target: first },
  'cleanup.export': { action: 'cleanup.export', target: first },
  // 밖으로 닿는 것: DB, 슬랙, 브라우저
  'db.save': { action: 'db.connection.save', project: (a) => o(a[0]).projectId, target: (a) => o(a[0]).name, detail: (a) => ({ kind: s(o(a[0]).kind), agentAccess: s(o(a[0]).agentAccess), ssl: o(a[0]).ssl === true, sslVerify: o(a[0]).sslVerify !== false }) },
  'db.remove': { action: 'db.connection.remove', target: first },
  'db.query': { action: 'db.query.user', target: first, detail: (a) => ({ length: len(a[1]) }) },
  'db.decide': { action: 'db.query.decide', target: first, outcome: allow, detail: (a) => ({ always: a[2] === true }) },
  'slack.connect': { action: 'slack.connect' },
  'slack.disconnect': { action: 'slack.disconnect' },
  'slack.setAccess': { action: 'slack.access', detail: (a) => ({ access: s(a[0]) }) },
  'slack.decide': { action: 'slack.read.decide', target: first, outcome: allow, detail: (a) => ({ always: a[2] === true }) },
  'browser.decide': { action: 'browser.open.decide', target: first, outcome: allow },
  // 다른 사람과의 연결
  'peers.connect': { action: 'peer.connect', target: first },
  'peers.accept': { action: 'peer.pair.accept', target: first },
  'peers.dismiss': { action: 'peer.pair.dismiss', target: first, outcome: () => 'denied' },
  'peers.remove': { action: 'peer.remove', target: first },
  'peers.setMode': { action: 'peer.mode', target: first, detail: (a) => ({ mode: s(a[1]) }) },
  'peers.createShare': { action: 'share.create', scope: 'p' },
  'peers.invite': { action: 'share.invite', target: (a) => a[1], detail: (a) => ({ observer: a[2] === true }) },
  'peers.acceptInvite': { action: 'share.invite.accept', target: first },
  'peers.declineInvite': { action: 'share.invite.decline', target: first, outcome: () => 'denied' },
  'peers.leave': { action: 'share.leave', target: first },
  'peers.removeMember': { action: 'share.member.remove', target: (a) => a[1] },
  'peers.handOver': { action: 'share.lead.hand_over', scope: 'p', target: (a) => a[1] },
  'peers.setSharing': { action: 'workspace.sharing', scope: 'w', detail: (a) => ({ audience: s(a[1]), peers: len(a[2]) }) },
  'peers.pass': { action: 'peer.message.pass', target: first },
  'peers.drop': { action: 'peer.message.drop', target: first, outcome: () => 'denied' },
  'assignments.accept': { action: 'assign.accept', target: first, detail: (a) => ({ share: a[2] !== false }) },
  'assignments.decline': { action: 'assign.decline', target: first, outcome: () => 'denied' },
  // 플러그인, 만들기, 설정, 업데이트
  'plugins.installFolder': { action: 'plugin.install', detail: () => ({ from: 'folder' }) },
  'plugins.installGit': { action: 'plugin.install', target: first, detail: () => ({ from: 'git' }) },
  'plugins.installFrom': { action: 'plugin.install', target: (a) => `${s(a[0])}#${s(a[1])}`, detail: () => ({ from: 'market' }) },
  'plugins.update': { action: 'plugin.update', target: first },
  'plugins.approve': { action: 'plugin.approve', target: first, detail: (a) => ({ hash: s(a[1]).slice(0, 16) }) },
  'plugins.remove': { action: 'plugin.remove', target: first },
  'plugins.setEnabled': { action: 'plugin.enable', scope: 'p', target: (a) => a[1], detail: (a) => ({ on: a[2] === true }) },
  'makes.create': { action: 'make.create', scope: 'p', detail: (a) => ({ kind: s(a[1]), extraLength: len(a[3]) }) },
  'makes.save': { action: 'make.save', target: first, detail: (a) => ({ original: a[1] === true }) },
  'makes.remove': { action: 'make.remove', target: first },
  'settings.update': { action: 'settings.update', target: (a) => Object.keys(o(a[0])).join(','), detail: (a) => { const p = o(a[0]); const d: Detail = {}; for (const k of ['defaultPermissionMode', 'awayMode', 'autoTrust', 'auditKeepDays', 'shareWorkReport', 'notesForAgents', 'notesWriteForAgents', 'claudeModel', 'coordinatorModel', 'reviewModel']) if (k in p) d[k] = typeof p[k] === 'string' || typeof p[k] === 'number' || typeof p[k] === 'boolean' ? p[k] as string | number | boolean : null; return d; } },
  'update.apply': { action: 'app.update' },
  'away.clear': { action: 'away.review' },
};

/** 채널과 인자에서 감사 기록 한 줄을 만든다. 적지 않는 채널이면 null. */
export function auditOf(core: Core, channel: string, args: unknown[], error?: unknown): AuditInput | null {
  const spec = AUDITED[channel];
  if (!spec) return null;
  let projectId = ''; let workspaceId = ''; let target = '';
  try {
    if (spec.scope === 'w') { workspaceId = s(args[0]); const w = core.workspaces.get(workspaceId); projectId = w?.projectId ?? ''; target = w ? (w.role === 'coordinator' ? '조율 에이전트' : w.name) : ''; }
    if (spec.scope === 'p') projectId = s(args[0]);
    if (spec.project) projectId = s(spec.project(args));
    if (spec.target) { const t = spec.target(args); target = typeof t === 'string' || typeof t === 'number' ? String(t) : target; }
    const failed = error !== undefined;
    return {
      actor: 'user', action: spec.action, projectId, workspaceId, target,
      outcome: failed ? 'failed' : spec.outcome ? spec.outcome(args) : 'ok',
      reason: failed ? (error instanceof Error ? error.message : String(error)) : '',
      detail: spec.detail ? spec.detail(args) : undefined,
    };
  } catch { return { actor: 'user', action: spec.action, outcome: error !== undefined ? 'failed' : 'ok' }; }
}
