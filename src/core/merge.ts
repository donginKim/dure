import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MergePlan, MergeStep, Todo, Workspace } from '@shared/types';
import type { Git } from './git';
import type { MessageService } from './messages';
import type { RepoStore, WorkspaceStore } from './stores';
import type { VerifyRunner } from './verify';

/** 합친 결과를 담는 브랜치의 이름 (기준 브랜치마다 하나) */
export const mergeBranchOf = (base: string): string => `dure/merge-${base.replace(/[^A-Za-z0-9._-]+/g, '-')}`;

/**
 * 워크스페이스들의 순서. 다른 워크스페이스의 일을 기다리는 TODO 가 있으면 그 워크스페이스를 먼저 합친다 (일의 순서).
 * 순서가 돌고 돌거나 상관이 없으면 만든 순서.
 */
export function mergeOrder(ws: Pick<Workspace, 'id' | 'createdAt'>[], todos: Pick<Todo, 'id' | 'workspaceId' | 'after'>[]): string[] {
  const ids = new Set(ws.map((w) => w.id));
  const owner = new Map(todos.map((t) => [t.id, t.workspaceId]));
  const before = new Map<string, Set<string>>(ws.map((w) => [w.id, new Set<string>()]));
  for (const t of todos) {
    if (!t.workspaceId || !ids.has(t.workspaceId)) continue;
    for (const a of t.after) { const o = owner.get(a); if (o && o !== t.workspaceId && ids.has(o)) before.get(t.workspaceId)!.add(o); }
  }
  const byAge = [...ws].sort((a, b) => a.createdAt - b.createdAt).map((w) => w.id);
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < byAge.length) {
    const next = byAge.find((id) => !done.has(id) && [...before.get(id)!].every((b) => done.has(b))) ?? byAge.find((id) => !done.has(id))!;
    done.add(next);
    out.push(next);
  }
  return out;
}

/**
 * 합치기 도우미. 한 저장소의 워크스페이스 브랜치들을 기준 브랜치에 차례로 합친다.
 * - 미리 보기: 작업 폴더 없이 git 객체만으로 차례로 합쳐 보고, 충돌하는 브랜치와 파일, 함께 충돌하는 앞의 브랜치를 찾는다. 아무것도 바꾸지 않는다.
 * - 합치기 브랜치 만들기: 충돌 없이 합친 결과를 `dure/merge-<기준>` 브랜치에 두고, 임시 작업 폴더에서 저장소의 확인 명령을 돌린다.
 *   기준 브랜치와 사용자의 작업 폴더는 건드리지 않는다.
 * - 기준 브랜치로 옮기기: 사용자가 누를 때만, 앞으로 감기(fast-forward)로만 한다.
 * - 충돌: 그 워크스페이스의 에이전트에게 함께 충돌하는 브랜치를 자기 브랜치에 합쳐 풀라고 보낸다 (마무리 커밋은 사용자가 커밋 창에서 한다).
 * 이벤트: 'changed' (projectId)
 */
export class MergeService extends EventEmitter {
  private readonly busy = new Set<string>();

  constructor(private readonly d: {
    repos: RepoStore; workspaces: WorkspaceStore; git: Git; messages: MessageService;
    todos(projectId: string): Todo[];
    worktreeRoot: string; env: Record<string, string>;
    run: VerifyRunner; timeoutMs: () => number;
    isProjectClosed(projectId: string): boolean;
  }) {
    super();
  }

  private git(path: string, ...args: string[]): Promise<string> { return this.d.git.raw(['-C', path, ...args]).then((s) => s.trim()); }

  private async isAncestor(path: string, a: string, b: string): Promise<boolean> {
    return this.d.git.raw(['-C', path, 'merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
  }

  /** 프로젝트의 저장소마다, 기준 브랜치마다의 합치기 계획. */
  async plans(projectId: string): Promise<MergePlan[]> {
    const workers = this.d.workspaces.list(projectId);
    const out: MergePlan[] = [];
    for (const repo of this.d.repos.list(projectId)) {
      const mine = workers.filter((w) => w.repoId === repo.id);
      for (const base of [...new Set(mine.map((w) => w.baseBranch).filter(Boolean))]) {
        out.push(await this.plan(projectId, repo.id, base));
      }
    }
    return out;
  }

  /** 한 저장소·기준 브랜치의 합치기 계획. 작업 폴더 없이 차례로 합쳐 본다. 아무것도 바꾸지 않는다. */
  async plan(projectId: string, repoId: string, base: string): Promise<MergePlan> {
    const repo = this.d.repos.get(repoId);
    if (!repo || repo.projectId !== projectId) throw new Error('이 프로젝트의 저장소가 아닙니다.');
    const ws = this.d.workspaces.list(projectId).filter((w) => w.repoId === repoId && w.baseBranch === base);
    const order = mergeOrder(ws, this.d.todos(projectId));
    const baseHead = await this.git(repo.path, 'rev-parse', '--verify', `refs/heads/${base}`).catch(() => '');
    if (!baseHead) throw new Error(`기준 브랜치 ${base} 가 없습니다.`);
    const steps: MergeStep[] = [];
    let cur = baseHead;
    const merged: { workspaceId: string; branch: string; files: Set<string> }[] = [];
    for (const id of order) {
      const w = ws.find((x) => x.id === id)!;
      const head = await this.git(repo.path, 'rev-parse', '--verify', `refs/heads/${w.branch}`).catch(() => '');
      const uncommitted = existsSync(w.worktreePath) ? await this.d.git.uncommittedCount(w.worktreePath).catch(() => 0) : 0;
      const step: MergeStep = { workspaceId: w.id, name: w.name, branch: w.branch, ahead: 0, uncommitted, state: 'empty', conflicts: [], with: [] };
      steps.push(step);
      if (!head) { step.state = 'missing'; continue; }
      step.ahead = Number(await this.git(repo.path, 'rev-list', '--count', `${baseHead}..${head}`).catch(() => '0')) || 0;
      if (await this.isAncestor(repo.path, head, baseHead)) { step.state = 'merged'; continue; }
      if (step.ahead === 0) continue;
      const r = await this.d.git.mergeTree(repo.path, cur, head);
      if (r.conflicts.length) {
        step.state = 'conflict';
        step.conflicts = r.conflicts.slice(0, 50);
        // 함께 충돌하는 앞의 브랜치: 같은 파일을 바꾼 것 (없으면 기준 브랜치와 충돌한 것이다).
        step.with = merged.filter((m) => step.conflicts.some((f) => m.files.has(f))).map((m) => m.workspaceId);
        continue;
      }
      // 부모들 가운데 가장 늦은 시각으로 만든다: 다시 미리 봐도 같은 커밋이 나와, 만들어 둔 합치기 브랜치와 비교할 수 있다.
      const when = Math.max(...(await this.git(repo.path, 'show', '-s', '--format=%ct', cur, head)).split('\n').map(Number).filter(Number.isFinite));
      cur = await this.d.git.commitMerge(repo.path, r.tree, [cur, head], `두레: ${w.name} (${w.branch}) 합치기`, when);
      const files = new Set((await this.git(repo.path, 'diff', '--name-only', `${baseHead}...${head}`).catch(() => '')).split('\n').filter(Boolean));
      merged.push({ workspaceId: w.id, branch: w.branch, files });
      step.state = 'ok';
    }
    const branch = mergeBranchOf(base);
    const existing = await this.git(repo.path, 'rev-parse', '--verify', `refs/heads/${branch}`).catch(() => '');
    return {
      projectId, repoId, repoName: repo.name, base, baseHead, steps, result: cur === baseHead ? null : cur,
      mergeBranch: branch, mergeBranchHead: existing || null, ready: cur !== baseHead && existing === cur,
      verifyCommand: repo.verifyCommand,
    };
  }

  /**
   * 합치기 브랜치를 만든다: 충돌하지 않는 브랜치들을 차례로 합친 결과를 `dure/merge-<기준>` 에 둔다 (있으면 옮긴다).
   * 저장소에 확인 명령이 있으면 임시 작업 폴더에서 돌린다. 기준 브랜치와 사용자의 작업 폴더는 건드리지 않는다.
   */
  async prepare(projectId: string, repoId: string, base: string): Promise<{ plan: MergePlan; verify: { ok: boolean; output: string } | null }> {
    if (this.d.isProjectClosed(projectId)) throw new Error('완료된 프로젝트입니다.');
    const key = `${repoId}|${base}`;
    if (this.busy.has(key)) throw new Error('이미 합치는 중입니다.');
    this.busy.add(key);
    this.emit('changed', projectId);
    try {
      const p = await this.plan(projectId, repoId, base);
      if (!p.result) throw new Error('합칠 것이 없습니다 (충돌 없이 합칠 수 있는 커밋이 없습니다).');
      const repo = this.d.repos.get(repoId)!;
      await this.git(repo.path, 'update-ref', `refs/heads/${p.mergeBranch}`, p.result);
      let verify: { ok: boolean; output: string } | null = null;
      if (repo.verifyCommand) {
        const dir = join(this.d.worktreeRoot, '.merge', `${repoId}-${base.replace(/[^A-Za-z0-9._-]+/g, '-')}`);
        rmSync(dir, { recursive: true, force: true });
        await this.d.git.raw(['-C', repo.path, 'worktree', 'prune']).catch(() => undefined);
        mkdirSync(join(this.d.worktreeRoot, '.merge'), { recursive: true });
        await this.git(repo.path, 'worktree', 'add', '--detach', dir, p.result);
        try {
          const r = await this.d.run({ command: repo.verifyCommand, cwd: dir, env: this.d.env, timeoutMs: this.d.timeoutMs() });
          verify = { ok: r.code === 0 && !r.timedOut, output: r.timedOut ? `${r.output}\n(시간 안에 끝나지 않아 멈췄습니다)`.trim() : r.output };
        } finally {
          await this.d.git.raw(['-C', repo.path, 'worktree', 'remove', '--force', dir]).catch(() => rmSync(dir, { recursive: true, force: true }));
        }
      }
      return { plan: await this.plan(projectId, repoId, base), verify };
    } finally {
      this.busy.delete(key);
      this.emit('changed', projectId);
    }
  }

  /**
   * 합치기 브랜치를 기준 브랜치로 옮긴다. 앞으로 감기만 한다 (기준 브랜치가 그사이 바뀌었으면 하지 않는다).
   * 기준 브랜치가 사용자의 작업 폴더에 체크아웃돼 있으면 그 폴더가 깨끗할 때만, git merge --ff-only 로 한다.
   */
  async advance(projectId: string, repoId: string, base: string): Promise<string> {
    if (this.d.isProjectClosed(projectId)) throw new Error('완료된 프로젝트입니다.');
    const repo = this.d.repos.get(repoId);
    if (!repo || repo.projectId !== projectId) throw new Error('이 프로젝트의 저장소가 아닙니다.');
    const branch = mergeBranchOf(base);
    const target = await this.git(repo.path, 'rev-parse', '--verify', `refs/heads/${branch}`).catch(() => '');
    if (!target) throw new Error('합치기 브랜치가 없습니다. 먼저 "합치기 브랜치 만들기" 를 누르세요.');
    const head = await this.git(repo.path, 'rev-parse', '--verify', `refs/heads/${base}`);
    if (head === target) return '이미 옮겼습니다.';
    if (!(await this.isAncestor(repo.path, head, target))) throw new Error(`${base} 가 그사이 바뀌어 앞으로 감기로 옮길 수 없습니다. 다시 미리 보고 합치기 브랜치를 새로 만드세요.`);
    const checkedOut = (await this.git(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')) === base;
    if (checkedOut) {
      if (await this.d.git.uncommittedCount(repo.path) > 0) throw new Error(`저장소 폴더(${repo.path})에 커밋하지 않은 변경이 있어 ${base} 를 옮기지 않았습니다. 정리한 뒤 다시 누르세요.`);
      await this.git(repo.path, 'merge', '--ff-only', target);
    } else {
      await this.git(repo.path, 'update-ref', `refs/heads/${base}`, target, head);
    }
    this.emit('changed', projectId);
    return `${base} 를 ${target.slice(0, 7)} 로 옮겼습니다.`;
  }

  /** 충돌한 워크스페이스의 에이전트에게: 함께 충돌하는 브랜치를 자기 브랜치에 합쳐 풀라고 보낸다. */
  async askToResolve(projectId: string, repoId: string, base: string, workspaceId: string): Promise<void> {
    const p = await this.plan(projectId, repoId, base);
    const step = p.steps.find((s) => s.workspaceId === workspaceId);
    if (!step || step.state !== 'conflict') throw new Error('충돌한 워크스페이스가 아닙니다 (다시 미리 보세요).');
    const others = step.with.map((id) => p.steps.find((s) => s.workspaceId === id)!).filter(Boolean);
    const sources = others.length ? others.map((o) => o.branch) : [base];
    this.d.messages.send({
      projectId, from: { kind: 'system' }, toWorkspaceId: workspaceId, title: '합치기',
      body: [
        `[두레] 사용자가 브랜치들을 ${base} 에 합치려 하는데, 네 브랜치(${step.branch})가 ${others.length ? others.map((o) => `"${o.name}" 의 ${o.branch}`).join(', ') : base} 와(과) 충돌한다.`,
        `충돌하는 파일: ${step.conflicts.join(', ')}`,
        `네 작업 폴더에서 ${sources.map((b) => `git merge ${b}`).join(', 그다음 ')} 를 실행해 충돌을 풀어라. 양쪽의 뜻을 모두 살려라 (한쪽을 지우지 마라). 판단이 서지 않는 곳은 사용자에게 물어라.`,
        '충돌을 고치고 git add 까지 하라. 합치기를 마무리하는 커밋은 사용자가 두레의 커밋 창에서 한다: commit_draft_save 로 커밋 메시지(예: "Merge ... 충돌 해결")를 저장하고 알려라.',
      ].join('\n'),
    });
  }
}
