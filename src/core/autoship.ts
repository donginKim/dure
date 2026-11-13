import { EventEmitter } from 'node:events';
import type { ShipEvent } from '@shared/types';
import type { CommitService } from './commitService';
import type { CommitDraftStore } from './commitDrafts';
import type { MergeService } from './merge';
import type { MessageService } from './messages';
import type { ReviewService } from './review';
import type { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import type { VerifyService } from './verify';

const KEEP = 50;

/** 비밀 값처럼 보이는 파일 이름 */
const SECRET_FILES = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|.*\.key|credentials(\.json)?|\.npmrc|\.netrc|secrets?\.(json|ya?ml|toml))$/i;
/** 비밀 값처럼 보이는 글 (더한 줄에서만 찾는다) */
const SECRET_TEXT: [string, RegExp][] = [
  ['개인 키', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS 키', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub 토큰', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['슬랙 토큰', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['API 키', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['구글 API 키', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

/** 바뀐 것에서 비밀 값처럼 보이는 것을 찾는다. 찾은 것의 설명 (값은 담지 않는다). */
export function findSecrets(files: { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (SECRET_FILES.test(f.path) && !/\.(example|sample|template)$/i.test(f.path)) out.push(`${f.path}: 비밀 값이 들어 있을 수 있는 파일`);
    const added = f.text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    for (const [what, re] of SECRET_TEXT) if (re.test(added)) out.push(`${f.path}: ${what}처럼 보이는 글`);
  }
  return out;
}

/**
 * 자동 반영. 프로젝트 설정이 켜져 있으면, 에이전트가 커밋 초안을 올렸을 때 두레가 차례로 확인하고 반영한다:
 *   1. 확인 명령 (저장소에 정해 둔 것. 없으면 자동으로 하지 않는다) 이 통과한다
 *   2. 리뷰 에이전트가 "높음" 문제를 찾지 않았다
 *   3. 바뀐 것에 비밀 값처럼 보이는 것이 없다
 *   4. 워크스페이스 브랜치에 커밋한다 (commit 이상)
 *   5. 기준 브랜치에 차례로 합쳐 보고, 합친 결과로 확인 명령을 다시 돌려 통과하면 기준 브랜치를 앞으로 감는다 (main)
 * 하나라도 걸리면 거기서 멈추고 기록과 "확인할 것" 에 올린다. push 는 하지 않는다. 같은 프로젝트에서는 하나씩 한다.
 * 이벤트: 'changed' (projectId)
 */
export class AutoShipService extends EventEmitter {
  private readonly log = new Map<string, ShipEvent[]>();
  private readonly queue = new Map<string, Promise<void>>();

  constructor(private readonly d: {
    projects: ProjectStore; repos: RepoStore; workspaces: WorkspaceStore; drafts: CommitDraftStore; messages: MessageService;
    commit: CommitService; verify: VerifyService; review: ReviewService; merges: MergeService;
    isProjectClosed(projectId: string): boolean;
  }) {
    super();
  }

  events(projectId: string): ShipEvent[] { return [...(this.log.get(projectId) ?? [])].reverse(); }

  /** 워크스페이스마다 가장 최근 기록이 실패인 것 (확인할 것에 올린다). */
  failures(projectId: string): ShipEvent[] {
    const last = new Map<string, ShipEvent>();
    for (const e of this.log.get(projectId) ?? []) last.set(e.workspaceId, e);
    return [...last.values()].filter((e) => !e.ok);
  }

  private note(projectId: string, workspaceId: string, stage: ShipEvent['stage'], ok: boolean, message: string): void {
    const list = this.log.get(projectId) ?? [];
    list.push({ id: crypto.randomUUID(), projectId, workspaceId, workspaceName: this.d.workspaces.get(workspaceId)?.name ?? '', at: Date.now(), stage, ok, message });
    this.log.set(projectId, list.slice(-KEEP));
    this.emit('changed', projectId);
  }

  /** 초안이 올라온 워크스페이스를 반영해 본다. 프로젝트마다 하나씩 차례로 한다. */
  run(workspaceId: string): Promise<void> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) return Promise.resolve();
    const prev = this.queue.get(ws.projectId) ?? Promise.resolve();
    const next = prev.then(() => this.shipOnce(workspaceId)).catch(() => undefined);
    this.queue.set(ws.projectId, next);
    return next;
  }

  private async shipOnce(workspaceId: string): Promise<void> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || ws.role === 'coordinator') return;
    const project = this.d.projects.get(ws.projectId);
    if (!project || project.autoShip === 'off' || this.d.isProjectClosed(ws.projectId)) return;
    const draft = this.d.drafts.get(workspaceId);
    if (!draft) return;
    const p = ws.projectId;
    const fail = (stage: ShipEvent['stage'], message: string): void => this.note(p, workspaceId, stage, false, message);
    const repo = this.d.repos.get(ws.repoId);
    if (!repo?.verifyCommand) { fail('verify', '이 저장소에 확인 명령이 없어 자동으로 반영하지 않았습니다. 현황 탭의 저장소 줄에 확인 명령을 적으세요.'); return; }
    const state = await this.d.commit.state(workspaceId);
    if (state.files.length === 0) return;
    // 1. 확인 명령
    const v = await this.d.verify.check(workspaceId);
    if (!v.ok) { fail('verify', `확인 명령이 ${v.timedOut ? '시간 안에 끝나지 않았습니다' : '실패했습니다'}: ${v.command}`); return; }
    // 2. 리뷰 (같은 작업 폴더를 이미 봤으면 그 결과를 쓴다)
    let r;
    try { r = await this.d.review.review(workspaceId); } catch (e) { fail('review', `리뷰를 받지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (r.state !== 'done') { fail('review', `리뷰를 받지 못했습니다: ${r.error}`); return; }
    const high = r.findings.filter((f) => f.severity === '높음');
    if (high.length) { fail('review', `리뷰가 높음 ${high.length}건을 찾았습니다: ${high.map((f) => f.title).join(', ')}. 커밋 창에서 보고 에이전트에게 고치게 하세요.`); return; }
    // 3. 비밀 값
    const changes = await Promise.all(state.files.map(async (f) => ({ path: f.path, text: (await this.d.commit.diff(workspaceId, f.path).catch(() => ({ text: '' }))).text })));
    const secrets = findSecrets(changes);
    if (secrets.length) { fail('secret', `비밀 값이 들어 있을 수 있어 멈췄습니다: ${secrets.slice(0, 5).join(' / ')}`); return; }
    // 그사이 초안이 바뀌었으면 (에이전트가 더 고쳤다) 다음 차례에 맡긴다.
    if (this.d.drafts.get(workspaceId)?.updatedAt !== draft.updatedAt) return;
    // 4. 커밋
    let hash = '';
    try { hash = (await this.d.commit.commit(workspaceId, { files: state.files.map((f) => f.path), message: draft.message }, { auto: true })).hash; } catch (e) {
      fail('commit', `커밋하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return;
    }
    this.note(p, workspaceId, 'commit', true, `${ws.branch} 에 커밋했습니다 (${hash.slice(0, 7)}).`);
    if (project.autoShip !== 'main') return;
    // 5. 기준 브랜치로
    const plan = await this.d.merges.plan(p, repo.id, ws.baseBranch).catch((e: unknown) => { fail('merge', `합쳐 보지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (!plan) return;
    const step = plan.steps.find((s) => s.workspaceId === workspaceId);
    if (step?.state === 'conflict') {
      await this.d.merges.askToResolve(p, repo.id, ws.baseBranch, workspaceId).catch(() => undefined);
      fail('merge', `${ws.baseBranch} 와(과) 충돌합니다 (${step.conflicts.slice(0, 5).join(', ')}). 에이전트에게 풀라고 보냈습니다.`);
      return;
    }
    let prepared;
    try { prepared = await this.d.merges.prepare(p, repo.id, ws.baseBranch); } catch (e) { fail('merge', `합치지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (prepared.verify && !prepared.verify.ok) { fail('merge', `합친 결과로 돌린 확인 명령이 실패했습니다. ${ws.baseBranch} 는 그대로입니다.`); return; }
    try {
      const msg = await this.d.merges.advance(p, repo.id, ws.baseBranch);
      this.note(p, workspaceId, 'done', true, msg);
      try {
        this.d.messages.send({ projectId: p, from: { kind: 'system' }, toWorkspaceId: workspaceId, title: '자동 반영', body: `[두레] 네 커밋이 ${ws.baseBranch} 에 들어갔다 (자동 반영). 다음 일을 이어서 하라. push 는 사용자가 한다.` });
      } catch { /* 알림 실패는 반영을 되돌리지 않는다 */ }
    } catch (e) {
      fail('advance', `${ws.baseBranch} 로 옮기지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
