import { EventEmitter } from 'node:events';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { CleanupItem } from '@shared/types';
import type { Git } from './git';
import type { WorkspaceStore } from './stores';

interface Row {
  id: string; project_id: string; workspace_id: string | null; workspace_name: string; path: string; stored_path: string;
  reason: string; size: number; is_dir: number; created_at: number;
}
const toItem = (r: Row): CleanupItem => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, workspaceName: r.workspace_name, path: r.path,
  reason: r.reason, size: r.size, isDir: r.is_dir === 1, createdAt: r.created_at,
});

/** 한 번에 옮길 수 있는 크기. 이보다 크면 다시 만들 수 있는 산출물일 가능성이 높다: 옮기지 않고 알린다 */
export const MAX_MOVE_BYTES = 200 << 20;
const MAX_ENTRIES = 20_000;

/** 파일이나 폴더의 크기와 안의 항목 수. 링크는 따라가지 않는다. */
function measure(path: string): { size: number; entries: number } {
  const st = lstatSync(path);
  if (!st.isDirectory()) return { size: st.size, entries: 1 };
  let size = 0; let entries = 1;
  for (const name of readdirSync(path)) {
    const m = measure(join(path, name));
    size += m.size; entries += m.entries;
    if (entries > MAX_ENTRIES) break;
  }
  return { size, entries };
}

/** 같은 디스크면 이름만 바꾸고, 다른 디스크면 복사한 뒤 원본을 지운다. */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export interface CleanupResult {
  moved: CleanupItem[];
  /** 옮기지 않은 것과 그 이유 */
  skipped: { path: string; reason: string }[];
}

/**
 * "정리 대기": 최종 산출물이 아닌 파일(실험 스크립트, 로그, 임시 메모)을 지우지 않고 저장소 밖으로 옮겨 둔다.
 * 프로젝트를 완료 처리할 때 사용자가 목록을 보고 지운다. 그 전에는 언제든 제자리로 되돌릴 수 있다.
 * 이벤트: 'changed' (projectId)
 */
export class CleanupService extends EventEmitter {
  constructor(private readonly d: {
    db: Database.Database;
    workspaces: WorkspaceStore;
    git: Git;
    /** 옮긴 것을 두는 폴더 (두레 데이터 폴더 아래) */
    dir: string;
  }) {
    super();
  }

  list(projectId: string): CleanupItem[] {
    return (this.d.db.prepare('SELECT * FROM cleanup_items WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[]).map(toItem);
  }

  private row(id: string): Row | undefined {
    return this.d.db.prepare('SELECT * FROM cleanup_items WHERE id = ?').get(id) as Row | undefined;
  }

  /**
   * 워크스페이스의 작업 폴더에 있는 것을 정리 대기로 옮긴다. 옮길 수 없는 것은 건너뛰고 이유를 돌려준다.
   * 옮기는 것은 git 이 추적하지 않는 것뿐이다: 커밋됐거나 고치는 중인 파일, git 이 무시하는 파일(빌드 결과, 캐시)은 건드리지 않는다.
   */
  async stash(workspaceId: string, paths: string[], reason: string): Promise<CleanupResult> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error(`워크스페이스가 없습니다: ${workspaceId}`);
    if (!existsSync(ws.worktreePath)) throw new Error('작업 폴더가 없습니다.');
    const root = realpathSync(ws.worktreePath);
    // eslint-disable-next-line no-control-regex
    const why = String(reason ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);
    const result: CleanupResult = { moved: [], skipped: [] };
    const seen = new Set<string>();
    for (const given of Array.isArray(paths) ? paths.slice(0, 200) : []) {
      const shown = String(given);
      const skip = (r: string): void => { result.skipped.push({ path: shown, reason: r }); };
      try {
        if (typeof given !== 'string' || !given.trim()) { skip('경로가 비어 있다'); continue; }
        const full = isAbsolute(given) ? resolve(given) : resolve(root, given);
        if (!existsSync(full)) { skip('없는 파일이다'); continue; }
        // 링크 자체를 옮긴다: 링크가 가리키는 곳은 따라가지 않는다. 부모 폴더까지만 실제 위치로 푼다.
        const real = join(realpathSync(dirname(full)), basename(full));
        const rel = relative(root, real);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) { skip('작업 폴더 밖이거나 작업 폴더 자체다'); continue; }
        if (rel === '.git' || rel.startsWith(`.git${sep}`)) { skip('git 의 내부 파일이다'); continue; }
        if (seen.has(rel) || [...seen].some((s) => rel.startsWith(s + sep))) continue; // 이미 옮긴 폴더 안의 것
        // git 이 아는 파일이 하나라도 있으면(추적 중) 옮기지 않는다.
        const tracked = (await this.d.git.raw(['-C', root, 'ls-files', '-z', '--', rel])).split('\0').filter(Boolean);
        if (tracked.length > 0) { skip('git 이 추적하는 파일이다 (결과물일 수 있다). 지우려면 사용자에게 알려라'); continue; }
        const ignored = await this.d.git.raw(['-C', root, 'check-ignore', '-q', '--', rel]).then(() => true, () => false);
        if (ignored) { skip('git 이 무시하는 파일이다 (빌드 결과나 캐시). 옮기지 않는다'); continue; }
        const m = measure(real);
        if (m.entries > MAX_ENTRIES || m.size > MAX_MOVE_BYTES) { skip('너무 크다 (다시 만들 수 있는 산출물이라면 그대로 둬라)'); continue; }
        const id = crypto.randomUUID();
        const stored = join(this.d.dir, ws.projectId, id, basename(real));
        const isDir = lstatSync(real).isDirectory();
        move(real, stored);
        const now = Date.now();
        this.d.db.prepare(
          `INSERT INTO cleanup_items (id, project_id, workspace_id, workspace_name, path, stored_path, reason, size, is_dir, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, ws.projectId, ws.id, ws.name, rel, stored, why, m.size, isDir ? 1 : 0, now);
        seen.add(rel);
        result.moved.push(toItem(this.row(id)!));
      } catch (e) {
        skip(e instanceof Error ? e.message : String(e));
      }
    }
    if (result.moved.length > 0) this.emit('changed', ws.projectId);
    return result;
  }

  /** 옮겨 둔 것을 제자리로 되돌린다. 그 자리에 이미 다른 것이 있으면 덮어쓰지 않고 오류를 낸다. */
  restore(id: string): void {
    const r = this.row(id);
    if (!r) throw new Error('정리 대기에 없는 항목입니다.');
    const ws = r.workspace_id ? this.d.workspaces.get(r.workspace_id) : undefined;
    if (!ws || !existsSync(ws.worktreePath)) throw new Error('되돌릴 작업 폴더가 없습니다 (워크스페이스나 작업 폴더가 지워졌습니다).');
    if (!existsSync(r.stored_path)) {
      this.forget([id]);
      throw new Error('옮겨 둔 파일이 사라졌습니다. 목록에서 뺐습니다.');
    }
    const root = realpathSync(ws.worktreePath);
    const target = resolve(root, r.path);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('되돌릴 위치가 작업 폴더 밖입니다.');
    if (existsSync(target)) throw new Error(`그 자리에 이미 다른 것이 있습니다: ${r.path}`);
    move(r.stored_path, target);
    this.forget([id]);
  }

  /** 옮겨 둔 것을 지운다 (완료 처리, 프로젝트 삭제). 지운 수를 돌려준다. */
  remove(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      const r = this.row(id);
      if (!r) continue;
      // 저장 폴더 안의 것만 지운다: DB 값이 잘못돼 있어도 다른 곳을 지우지 않는다.
      const dir = resolve(this.d.dir, r.project_id, r.id);
      if (dir.startsWith(resolve(this.d.dir) + sep)) rmSync(dir, { recursive: true, force: true });
      n++;
    }
    this.forget(ids);
    return n;
  }

  /** 프로젝트의 것을 모두 지운다. */
  removeProject(projectId: string): void {
    this.remove(this.list(projectId).map((i) => i.id));
    const dir = resolve(this.d.dir, projectId);
    if (dir.startsWith(resolve(this.d.dir) + sep)) rmSync(dir, { recursive: true, force: true });
  }

  private forget(ids: string[]): void {
    const projects = new Set<string>();
    for (const id of ids) {
      const r = this.row(id);
      if (!r) continue;
      projects.add(r.project_id);
      this.d.db.prepare('DELETE FROM cleanup_items WHERE id = ?').run(id);
      const dir = resolve(this.d.dir, r.project_id, r.id);
      if (dir.startsWith(resolve(this.d.dir) + sep)) rmSync(dir, { recursive: true, force: true });
    }
    for (const p of projects) this.emit('changed', p);
  }
}
