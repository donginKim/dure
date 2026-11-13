import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { VerifyState } from '@shared/types';
import type { Git } from './git';
import type { RepoStore, WorkspaceStore } from './stores';

const MAX_COMMAND = 500;
const KEEP_OUTPUT = 6000;
const DEFAULT_TIMEOUT_MS = 300_000;
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

export type VerifyResult =
  /** 확인 명령이 없다: 그대로 통과 */
  | { ok: true; ran: false }
  /** 통과했다. reused: 작업 폴더가 지난번 통과한 때와 같아 다시 돌리지 않았다 */
  | { ok: true; ran: true; reused: boolean }
  | { ok: false; command: string; output: string; timedOut: boolean };

interface Row { workspace_id: string; state: string; tree: string; command: string; output: string; at: number }

/** 명령을 돌리는 쪽 (시험에서 바꾼다). 끝나면 종료 코드와 출력의 끝부분을 돌려준다. */
export type VerifyRunner = (o: { command: string; cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ code: number | null; output: string; timedOut: boolean }>;

const shellRunner: VerifyRunner = ({ command, cwd, env, timeoutMs }) => new Promise((resolve) => {
  // 로그인 셸로 돌린다: 사용자가 터미널에서 치는 것과 같은 PATH 를 쓴다 (node, pnpm 등).
  const child = spawn(env.SHELL || '/bin/zsh', ['-lc', command], { cwd, env: { ...env, CI: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let timedOut = false;
  const take = (b: Buffer): void => { out = (out + b.toString('utf8')).slice(-KEEP_OUTPUT * 2); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  // 명령이 띄운 것까지 함께 끝낸다 (묶음째로).
  const kill = (): void => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, output: `명령을 띄우지 못했습니다: ${e.message}`, timedOut: false }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: plain(out).slice(-KEEP_OUTPUT), timedOut }); });
});

/**
 * 끝난 일의 확인. 저장소마다 사용자가 "확인 명령" (시험, 빌드, 린트) 을 정해 둔다.
 * 에이전트가 TODO 를 완료로 바꾸려 하면 두레가 그 워크스페이스의 작업 폴더에서 이 명령을 돌리고, 실패하면 완료를 받지 않는다.
 * - 명령은 사용자만 정한다 (에이전트가 자기 확인을 느슨하게 바꿀 수 없다).
 * - 작업 폴더가 지난번 통과한 때와 같으면 다시 돌리지 않는다.
 * - 같은 워크스페이스에서 겹쳐 돌리지 않는다: 도는 중에 온 요청은 그 결과를 함께 받는다.
 * 이벤트: 'changed'
 */
export class VerifyService extends EventEmitter {
  private readonly running = new Map<string, Promise<VerifyResult>>();
  private readonly run: VerifyRunner;

  constructor(private readonly d: {
    db: Database.Database; repos: RepoStore; workspaces: WorkspaceStore; git: Git; env: Record<string, string>;
    /** 확인 명령의 시간 제한 (ms). 없으면 5분 */
    timeoutMs?: () => number;
    runner?: VerifyRunner;
  }) {
    super();
    this.run = d.runner ?? shellRunner;
  }

  /** 저장소의 확인 명령을 정한다. 빈 글이면 없앤다. 사용자만 부른다. */
  setCommand(repoId: string, command: string): void {
    const c = plain(String(command ?? '')).replace(/\n+/g, ' ').trim();
    if (c.length > MAX_COMMAND) throw new Error(`확인 명령이 너무 깁니다 (${MAX_COMMAND}자까지).`);
    if (!this.d.repos.get(repoId) || this.d.repos.isInternal(repoId)) throw new Error('등록된 저장소가 아닙니다.');
    this.d.repos.setVerifyCommand(repoId, c);
    this.emit('changed');
  }

  private commandOf(workspaceId: string): { command: string; cwd: string } | null {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || ws.role === 'coordinator') return null;
    const command = this.d.repos.get(ws.repoId)?.verifyCommand ?? '';
    return command ? { command, cwd: ws.worktreePath } : null;
  }

  private row(workspaceId: string): Row | undefined {
    return this.d.db.prepare('SELECT * FROM verifications WHERE workspace_id = ?').get(workspaceId) as Row | undefined;
  }

  /** 워크스페이스의 마지막 확인. 확인 명령이 없으면 null */
  status(workspaceId: string): VerifyState | null {
    const c = this.commandOf(workspaceId);
    if (!c) return null;
    if (this.running.has(workspaceId)) return { state: 'running', command: c.command, output: '', at: Date.now() };
    const r = this.row(workspaceId);
    // 명령이 바뀌었으면 앞의 결과는 그 명령의 것이 아니다.
    if (!r || r.command !== c.command) return { state: 'none', command: c.command, output: '', at: 0 };
    return { state: r.state === 'passed' ? 'passed' : 'failed', command: c.command, output: r.output, at: r.at };
  }

  /** 프로젝트의 워크스페이스마다의 마지막 확인 (확인 명령이 있는 것만). */
  statuses(projectId: string): Record<string, VerifyState> {
    const out: Record<string, VerifyState> = {};
    for (const w of this.d.workspaces.list(projectId)) { const s = this.status(w.id); if (s) out[w.id] = s; }
    return out;
  }

  /**
   * 확인 명령을 돌린다. 명령이 없으면 그대로 통과. force 가 아니면, 작업 폴더가 지난번 통과한 때와 같을 때 다시 돌리지 않는다.
   */
  check(workspaceId: string, o: { force?: boolean } = {}): Promise<VerifyResult> {
    const c = this.commandOf(workspaceId);
    if (!c) return Promise.resolve({ ok: true, ran: false });
    const going = this.running.get(workspaceId);
    if (going) return going;
    const job = this.doCheck(workspaceId, c, o.force === true).finally(() => { this.running.delete(workspaceId); this.emit('changed'); });
    this.running.set(workspaceId, job);
    this.emit('changed');
    return job;
  }

  private async doCheck(workspaceId: string, c: { command: string; cwd: string }, force: boolean): Promise<VerifyResult> {
    // 작업 폴더의 지금 모양 (커밋하지 않은 것까지). 알아내지 못하면 늘 돌린다.
    const tree = await this.d.git.snapshotTree(c.cwd).catch(() => '');
    const last = this.row(workspaceId);
    if (!force && tree && last && last.state === 'passed' && last.tree === tree && last.command === c.command) return { ok: true, ran: true, reused: true };
    const timeoutMs = Math.max(5000, this.d.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS);
    const r = await this.run({ command: c.command, cwd: c.cwd, env: this.d.env, timeoutMs });
    const passed = r.code === 0 && !r.timedOut;
    const output = r.timedOut ? `${r.output}\n(확인 명령이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다)`.trim() : r.output;
    this.d.db.prepare('INSERT INTO verifications (workspace_id, state, tree, command, output, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET state = excluded.state, tree = excluded.tree, command = excluded.command, output = excluded.output, at = excluded.at')
      .run(workspaceId, passed ? 'passed' : 'failed', tree, c.command, output, Date.now());
    return passed ? { ok: true, ran: true, reused: false } : { ok: false, command: c.command, output, timedOut: r.timedOut };
  }
}
