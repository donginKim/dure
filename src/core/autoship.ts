import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { ShipEvent } from '@shared/types';
import type { CommitService } from './commitService';
import type { Git } from './git';
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
 * 확인 명령의 결과를 바꿀 수 있는 파일 (시험 설정, 빌드 스크립트, CI). 이것이 바뀌면 자동으로 반영하지 않는다:
 * 에이전트가 확인 명령을 늘 통과하게 바꿨을 수 있다.
 */
const CHECK_FILES = /(^|\/)((vitest|jest|playwright|cypress|karma|mocha|ava|babel|webpack|vite|rollup|tsup|turbo|nx|lerna)\.config\.[cm]?[jt]s|\.mocharc[^/]*|pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|noxfile\.py|Makefile|makefile|justfile|Taskfile\.ya?ml|\.github\/workflows\/[^/]+|\.gitlab-ci\.yml|Jenkinsfile|\.husky\/[^/]+|\.git-hooks\/[^/]+|build\.gradle(\.kts)?|pom\.xml)$/;
/** package.json 의 scripts 를 건드렸는가 (더하거나 뺀 줄에 scripts 의 항목이 있다) */
const touchesScripts = (diff: string): boolean => diff.split('\n').some((l) => /^[+-](?![+-])/.test(l) && /"(scripts|test|pretest|posttest|prepare|lint|typecheck|build|check|verify)"\s*:/.test(l));

/** 확인 명령의 결과를 바꿀 수 있는 변경. 찾은 것의 설명 */
export function findCheckChanges(files: { path: string; text: string }[], command: string): string[] {
  const out: string[] = [];
  const words = command.split(/[\s;&|<>()'"]+/).filter((w) => /[./]/.test(w) && w.length > 2);
  for (const f of files) {
    if (CHECK_FILES.test(f.path)) out.push(`${f.path}: 시험·빌드 설정`);
    else if (/(^|\/)package\.json$/.test(f.path) && touchesScripts(f.text)) out.push(`${f.path}: scripts`);
    else if (words.some((w) => f.path === w.replace(/^\.\//, '') || f.path.endsWith(`/${w.replace(/^\.\//, '')}`))) out.push(`${f.path}: 확인 명령이 실행하는 파일`);
  }
  return out;
}

/**
 * 자동 반영. 프로젝트 설정이 켜져 있으면, 에이전트가 커밋 초안을 올렸을 때 두레가 차례로 확인하고 반영한다:
 *   1. 저장소에 확인 명령이 있어야 하고, 확인 명령의 결과를 바꿀 수 있는 파일(시험 설정, scripts)은 바뀌지 않았어야 한다
 *   2. 확인 명령이 통과한다
 *   3. 리뷰 에이전트의 답이 정해진 모양 그대로이고 "높음" 이 없다
 *   4. 바뀐 것에 비밀 값처럼 보이는 것이 없다
 *   5. 위를 모두 같은 작업 폴더의 모양(트리)에 대해 본 뒤, 그 모양이 그대로이고 작업 폴더가 이 워크스페이스의 브랜치에 있을 때만 커밋한다
 *   6. (main) 이 워크스페이스의 브랜치만 기준 브랜치에 합쳐 보고, 합친 결과로 확인 명령을 다시 돌려 통과하면 기준 브랜치를 앞으로 감는다
 * 하나라도 걸리면 거기서 멈추고 기록, "확인할 것", 그 에이전트에게 까닭을 알린다. push 는 하지 않는다.
 * 같은 프로젝트에서는 하나씩, 같은 워크스페이스는 기다리는 것을 하나로 합친다. 워크스페이스마다 한 시간에 6번까지.
 * 이벤트: 'changed' (projectId)
 */
export class AutoShipService extends EventEmitter {
  static readonly PER_HOUR = 6;
  private readonly log = new Map<string, ShipEvent[]>();
  private readonly queue = new Map<string, Promise<void>>();
  private readonly waiting = new Set<string>();
  private readonly runs = new Map<string, number[]>();
  private closed = false;
  /** 두레를 닫는다: 기다리던 것은 하지 않는다. */
  dispose(): void { this.closed = true; }

  constructor(private readonly d: {
    projects: ProjectStore; repos: RepoStore; workspaces: WorkspaceStore; drafts: CommitDraftStore; messages: MessageService;
    commit: CommitService; verify: VerifyService; review: ReviewService; merges: MergeService; git: Git;
    isProjectClosed(projectId: string): boolean;
    /** 기록을 적어 둔다 (없으면 메모리에만) */
    db?: Database.Database;
  }) {
    super();
    // 적어 둔 기록을 읽는다 (두레를 다시 켜도 남게).
    if (d.db) {
      const rows = d.db.prepare('SELECT * FROM ship_events ORDER BY at').all() as { id: string; project_id: string; workspace_id: string; workspace_name: string; at: number; stage: string; ok: number; message: string }[];
      for (const r of rows) {
        const list = this.log.get(r.project_id) ?? [];
        list.push({ id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, workspaceName: r.workspace_name, at: r.at, stage: r.stage as ShipEvent['stage'], ok: r.ok === 1, message: r.message });
        this.log.set(r.project_id, list.slice(-KEEP));
      }
    }
  }

  events(projectId: string): ShipEvent[] { return [...(this.log.get(projectId) ?? [])].reverse(); }

  /**
   * 멈춘 것 (확인할 것에 올린다): 자동 반영이 켜져 있고, 워크스페이스에 아직 초안이 있고, 가장 최근 기록이 실패인 것.
   * id 는 워크스페이스와 단계로 만든다: 같은 실패를 되풀이해도 새 알림이 뜨지 않는다.
   */
  failures(projectId: string): ShipEvent[] {
    if (this.d.projects.get(projectId)?.autoShip === 'off') return [];
    const last = new Map<string, ShipEvent>();
    for (const e of this.log.get(projectId) ?? []) last.set(e.workspaceId, e);
    return [...last.values()].filter((e) => !e.ok && this.d.workspaces.get(e.workspaceId) && this.d.drafts.get(e.workspaceId))
      .map((e) => ({ ...e, id: `${e.workspaceId}:${e.stage}` }));
  }

  private note(projectId: string, workspaceId: string, stage: ShipEvent['stage'], ok: boolean, message: string): void {
    const list = this.log.get(projectId) ?? [];
    const e: ShipEvent = { id: crypto.randomUUID(), projectId, workspaceId, workspaceName: this.d.workspaces.get(workspaceId)?.name ?? '', at: Date.now(), stage, ok, message };
    list.push(e);
    this.log.set(projectId, list.slice(-KEEP));
    if (this.d.db) {
      try {
        this.d.db.prepare('INSERT INTO ship_events (id, project_id, workspace_id, workspace_name, at, stage, ok, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(e.id, projectId, workspaceId, e.workspaceName, e.at, stage, ok ? 1 : 0, message);
        this.d.db.prepare('DELETE FROM ship_events WHERE project_id = ? AND id NOT IN (SELECT id FROM ship_events WHERE project_id = ? ORDER BY at DESC LIMIT ?)').run(projectId, projectId, KEEP);
      } catch { /* 기록만 빠진다 */ }
    }
    this.emit('changed', projectId);
  }

  /** 초안이 올라온 워크스페이스를 반영해 본다. 같은 워크스페이스가 이미 기다리고 있으면 하나로 합친다. */
  run(workspaceId: string): Promise<void> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) return Promise.resolve();
    if (this.waiting.has(workspaceId)) return this.queue.get(ws.projectId) ?? Promise.resolve();
    this.waiting.add(workspaceId);
    const prev = this.queue.get(ws.projectId) ?? Promise.resolve();
    const next = prev.then(async () => {
      this.waiting.delete(workspaceId);
      if (this.closed) return;
      try { await this.shipOnce(workspaceId); } catch (e) {
        // 생각하지 못한 오류도 기록에 남긴다 (조용히 사라지지 않게). 두레를 닫는 중이면 넘어간다.
        try {
          const w = this.d.workspaces.get(workspaceId);
          if (w) this.note(w.projectId, workspaceId, 'commit', false, `자동 반영 중 오류가 났습니다: ${e instanceof Error ? e.message : String(e)}`);
        } catch { /* 닫는 중 */ }
      }
    });
    this.queue.set(ws.projectId, next);
    return next;
  }

  private mode(projectId: string): 'off' | 'commit' | 'main' {
    if (this.d.isProjectClosed(projectId)) return 'off';
    return this.d.projects.get(projectId)?.autoShip ?? 'off';
  }

  private async shipOnce(workspaceId: string): Promise<void> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || ws.role === 'coordinator') return;
    const p = ws.projectId;
    if (this.mode(p) === 'off') return;
    const draft = this.d.drafts.get(workspaceId);
    if (!draft) return;
    const fail = (stage: ShipEvent['stage'], message: string): void => {
      this.note(p, workspaceId, stage, false, message);
      // 에이전트에게도 까닭을 알린다: 모른 채 같은 초안을 다시 올리지 않게.
      try { this.d.messages.send({ projectId: p, from: { kind: 'system' }, toWorkspaceId: workspaceId, title: '자동 반영', body: `[두레] 자동 반영이 멈췄다 (${message}) 커밋되지 않았다. 고칠 수 있는 것이면 고치고 커밋 초안을 다시 저장하라. 확인 명령이나 시험 설정을 느슨하게 바꿔 통과시키지 마라 (그런 변경은 자동 반영하지 않는다).` }); } catch { /* 알림 실패는 넘어간다 */ }
    };
    // 한 시간 상한 (확인 명령과 리뷰가 사용량을 쓴다)
    const now = Date.now();
    const recent = (this.runs.get(workspaceId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= AutoShipService.PER_HOUR) { this.note(p, workspaceId, 'verify', false, `한 시간에 ${AutoShipService.PER_HOUR}번까지만 자동으로 확인합니다. 커밋 창에서 직접 커밋하거나 잠시 뒤에 초안을 다시 저장하세요.`); return; }
    this.runs.set(workspaceId, [...recent, now]);
    const repo = this.d.repos.get(ws.repoId);
    if (!repo?.verifyCommand) { fail('verify', '이 저장소에 확인 명령이 없어 자동으로 반영하지 않았습니다. 현황 탭의 저장소 줄에 확인 명령을 적으세요.'); return; }
    // 검사할 모양: 지금 작업 폴더의 트리. 아래의 검사는 모두 이 모양에 대한 것이어야 한다.
    const tree = await this.d.git.snapshotTree(ws.worktreePath);
    const state = await this.d.commit.state(workspaceId);
    if (state.files.length === 0) return;
    const changes: { path: string; text: string }[] = [];
    for (const f of state.files) {
      // 변경을 읽지 못하면 넘어가지 않고 멈춘다.
      try { changes.push({ path: f.path, text: (await this.d.commit.diff(workspaceId, f.path)).text }); } catch (e) { fail('secret', `${f.path} 의 변경을 읽지 못해 멈췄습니다: ${e instanceof Error ? e.message : String(e)}`); return; }
    }
    const touched = findCheckChanges(changes, repo.verifyCommand);
    if (touched.length) { fail('verify', `확인 명령의 결과를 바꿀 수 있는 파일이 바뀌어 사람에게 넘깁니다: ${touched.slice(0, 5).join(' / ')}. 커밋 창에서 보고 직접 커밋하세요.`); return; }
    const secrets = findSecrets(changes);
    if (secrets.length) { fail('secret', `비밀 값이 들어 있을 수 있어 멈췄습니다: ${secrets.slice(0, 5).join(' / ')}`); return; }
    // 확인 명령
    const v = await this.d.verify.check(workspaceId);
    if (!v.ok) { fail('verify', `확인 명령이 ${v.timedOut ? '시간 안에 끝나지 않았습니다' : '실패했습니다'}: ${v.command}`); return; }
    // 리뷰 (같은 작업 폴더를 이미 봤으면 그 결과를 쓴다)
    let r;
    try { r = await this.d.review.review(workspaceId); } catch (e) { fail('review', `리뷰를 받지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (r.state !== 'done') { fail('review', `리뷰를 받지 못했습니다: ${r.error}`); return; }
    if (!r.strict) { fail('review', '리뷰어의 답이 정해진 모양이 아니어서 믿을 수 없습니다. 커밋 창에서 리뷰를 보고 직접 커밋하세요.'); return; }
    const high = r.findings.filter((f) => f.severity === '높음');
    if (high.length) { fail('review', `리뷰가 높음 ${high.length}건을 찾았습니다: ${high.map((f) => f.title).join(', ')}. 커밋 창에서 보고 에이전트에게 고치게 하세요.`); return; }
    // 검사한 모양 그대로인가: 검사하는 사이에 바뀌었으면 (에이전트가 더 고쳤다) 커밋하지 않는다.
    if (r.tree !== tree) { fail('review', '리뷰한 뒤에 작업 폴더가 바뀌었습니다. 다음 초안에서 다시 봅니다.'); return; }
    if (await this.d.git.snapshotTree(ws.worktreePath) !== tree) { fail('commit', '확인하는 사이에 작업 폴더가 바뀌었습니다. 다음 초안에서 다시 봅니다.'); return; }
    if (this.d.drafts.get(workspaceId)?.updatedAt !== draft.updatedAt) return;
    // 설정을 그사이 껐거나 프로젝트를 완료했으면 하지 않는다.
    if (this.mode(p) === 'off') return;
    // 작업 폴더가 이 워크스페이스의 브랜치에 있어야 한다 (다른 브랜치나 기준 브랜치를 체크아웃해 두었으면 거기에 커밋되면 안 된다).
    const head = await this.d.git.raw(['-C', ws.worktreePath, 'symbolic-ref', '-q', 'HEAD']).then((s) => s.trim(), () => '');
    if (head !== `refs/heads/${ws.branch}`) { fail('commit', `작업 폴더가 이 워크스페이스의 브랜치(${ws.branch})에 있지 않아 커밋하지 않았습니다 (지금: ${head ? head.replace('refs/heads/', '') : '브랜치 없음'}).`); return; }
    let hash = '';
    try { hash = (await this.d.commit.commit(workspaceId, { files: state.files.map((f) => f.path), message: draft.message }, { auto: true })).hash; } catch (e) {
      fail('commit', `커밋하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return;
    }
    // 커밋된 것이 검사한 모양과 같아야 한다.
    const committed = await this.d.git.raw(['-C', ws.worktreePath, 'rev-parse', `${hash}^{tree}`]).then((s) => s.trim(), () => '');
    if (committed !== tree) { fail('commit', `커밋은 했지만 검사한 모양과 달라 ${ws.baseBranch} 로는 옮기지 않습니다 (${hash.slice(0, 7)}). 합치기에서 보고 직접 옮기세요.`); return; }
    this.note(p, workspaceId, 'commit', true, `${ws.branch} 에 커밋했습니다 (${hash.slice(0, 7)}).`);
    if (this.mode(p) !== 'main') return;
    // 기준 브랜치로: 이 워크스페이스의 브랜치만 합친다 (검사를 거치지 않은 다른 워크스페이스의 커밋은 넣지 않는다).
    const only = [workspaceId];
    const plan = await this.d.merges.plan(p, repo.id, ws.baseBranch, only).catch((e: unknown) => { fail('merge', `합쳐 보지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (!plan) return;
    const step = plan.steps.find((s) => s.workspaceId === workspaceId);
    if (step?.state === 'conflict') {
      await this.d.merges.askToResolve(p, repo.id, ws.baseBranch, workspaceId).catch(() => undefined);
      this.note(p, workspaceId, 'merge', false, `${ws.baseBranch} 와(과) 충돌합니다 (${step.conflicts.slice(0, 5).join(', ')}). 에이전트에게 풀라고 보냈습니다.`);
      return;
    }
    let prepared;
    try { prepared = await this.d.merges.prepare(p, repo.id, ws.baseBranch, only); } catch (e) { fail('merge', `합치지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (prepared.verify && !prepared.verify.ok) { fail('merge', `합친 결과로 돌린 확인 명령이 실패했습니다. ${ws.baseBranch} 는 그대로입니다.`); return; }
    if (this.mode(p) !== 'main') return;
    try {
      const msg = await this.d.merges.advance(p, repo.id, ws.baseBranch, only);
      this.note(p, workspaceId, 'done', true, msg);
      try {
        this.d.messages.send({ projectId: p, from: { kind: 'system' }, toWorkspaceId: workspaceId, title: '자동 반영', body: `[두레] 네 커밋이 ${ws.baseBranch} 에 들어갔다 (자동 반영). 다음 일을 이어서 하라. push 는 사용자가 한다.` });
      } catch { /* 알림 실패는 반영을 되돌리지 않는다 */ }
    } catch (e) {
      fail('advance', `${ws.baseBranch} 로 옮기지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
