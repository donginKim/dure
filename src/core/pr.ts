import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { parseRemote, prUrl } from '@shared/pr';
import type { PrInfo, Workspace } from '@shared/types';
import type { Git } from './git';
import type { WorkspaceStore } from './stores';

type Run = (cmd: string, args: string[], cwd: string) => Promise<string>;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

/**
 * PR 만들기. 워크스페이스의 브랜치를 원격에 올린 뒤, 기준 브랜치로 들어가는 PR 을 만든다.
 * - GitHub 이고 gh (GitHub CLI) 가 깔려 있으면 두레 안에서 만든다. 아니면 PR 을 만드는 웹 화면을 연다.
 * - 제목과 설명은 에이전트가 초안으로 적어 둘 수 있다. 만드는 것은 사용자가 누를 때만 한다.
 * 이벤트: 'changed' (workspaceId)
 */
export class PrService extends EventEmitter {
  private gh: boolean | undefined;

  constructor(private readonly d: { db: Database.Database; workspaces: WorkspaceStore; git: Git; env: Record<string, string>; run?: Run }) { super(); }

  private run: Run = (cmd, args, cwd) => (this.d.run ? this.d.run(cmd, args, cwd) : new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: this.d.env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim())); else resolve(`${stdout}`.trim());
    });
  }));

  private mustGet(id: string): Workspace {
    const ws = this.d.workspaces.get(id);
    if (!ws || ws.role === 'coordinator') throw new Error('PR 을 만들 수 있는 워크스페이스가 아닙니다.');
    return ws;
  }

  private async hasGh(cwd: string): Promise<boolean> {
    if (this.gh === undefined) this.gh = await this.run('gh', ['--version'], cwd).then(() => true, () => false);
    return this.gh;
  }

  /** 에이전트가 PR 의 제목과 설명을 초안으로 적어 둔다. */
  saveDraft(workspaceId: string, i: { title?: string; body?: string }): void {
    const ws = this.mustGet(workspaceId);
    const title = oneLine(i.title, MAX_TITLE);
    const body = String(i.body ?? '').trim().slice(0, MAX_BODY);
    if (!title && !body) throw new Error('제목이나 설명을 적어라.');
    this.d.db.prepare('INSERT INTO pr_drafts (workspace_id, title, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at')
      .run(ws.id, title, body, Date.now());
    this.emit('changed', ws.id);
  }

  async info(workspaceId: string): Promise<PrInfo> {
    const ws = this.mustGet(workspaceId);
    const path = ws.worktreePath;
    const [remoteUrl, ahead] = await Promise.all([this.d.git.remoteUrl(path), this.d.git.aheadCount(path, ws.branch).catch(() => null)]);
    const remote = parseRemote(remoteUrl);
    const draft = this.d.db.prepare('SELECT title, body FROM pr_drafts WHERE workspace_id = ?').get(ws.id) as { title: string; body: string } | undefined;
    // 초안이 없으면 이 브랜치의 커밋 제목들로 채운다.
    const subjects = (await this.d.git.raw(['-C', path, 'log', '--no-merges', '--max-count=30', '--format=%s', `${ws.baseBranch}..HEAD`]).catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean);
    const title = draft?.title || subjects[subjects.length - 1] || ws.name;
    const body = draft?.body || [ws.summary, subjects.length > 1 ? subjects.reverse().map((x) => `- ${x}`).join('\n') : ''].filter(Boolean).join('\n\n');
    return {
      host: remote?.host ?? null, url: remote ? prUrl(remote, ws.baseBranch, ws.branch) : null,
      canCreate: remote?.host === 'github' && await this.hasGh(path), pushed: ahead === 0,
      base: ws.baseBranch, head: ws.branch, title: oneLine(title, MAX_TITLE), body,
    };
  }

  /** PR 을 만든다 (GitHub, gh). 만들어진 PR 의 주소를 돌려준다. */
  async create(workspaceId: string, i: { title: string; body: string }): Promise<string> {
    const ws = this.mustGet(workspaceId);
    const info = await this.info(workspaceId);
    if (!info.canCreate) throw new Error(info.host === 'github' ? 'gh (GitHub CLI) 가 없어 여기서 만들 수 없습니다. "브라우저에서 열기" 로 만드세요.' : '이 원격에서는 여기서 PR 을 만들 수 없습니다. "브라우저에서 열기" 로 만드세요.');
    if (!info.pushed) throw new Error('먼저 push 하세요. 원격에 올라간 커밋으로 PR 을 만듭니다.');
    const title = oneLine(i.title, MAX_TITLE);
    if (!title) throw new Error('PR 의 제목을 적으세요.');
    const out = await this.run('gh', ['pr', 'create', '--base', ws.baseBranch, '--head', ws.branch, '--title', title, '--body', String(i.body ?? '').slice(0, MAX_BODY)], ws.worktreePath);
    const url = out.split('\n').map((l) => l.trim()).reverse().find((l) => /^https:\/\/\S+$/.test(l));
    if (!url) throw new Error(`PR 을 만들었는지 알 수 없습니다: ${out.slice(0, 300)}`);
    this.d.db.prepare('DELETE FROM pr_drafts WHERE workspace_id = ?').run(ws.id);
    this.emit('changed', ws.id);
    return url;
  }
}
