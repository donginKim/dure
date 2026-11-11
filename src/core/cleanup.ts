import { EventEmitter } from 'node:events';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, type Stats } from 'node:fs';
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
export const DONE_PROJECT_CLEANUP = '완료된 프로젝트입니다. 다시 열어야 정리 대기를 바꿀 수 있습니다.';

/** 이름을 견줄 때의 모양. macOS 의 파일 시스템은 대소문자와 유니코드 조합 방식을 가리지 않는다. */
const fold = (name: string): string => name.normalize('NFC').toLowerCase();
const isGitName = (name: string): boolean => fold(name) === '.git';

/** 파일이나 폴더의 크기와 항목 수, 그리고 안에 다른 저장소(.git)가 있는지. 링크는 따라가지 않는다. */
function measure(path: string): { size: number; entries: number; nestedGit: boolean } {
  const st = lstatSync(path);
  if (!st.isDirectory()) return { size: st.size, entries: 1, nestedGit: false };
  let size = 0; let entries = 1; let nestedGit = false;
  for (const name of readdirSync(path)) {
    if (isGitName(name)) { nestedGit = true; continue; }
    const m = measure(join(path, name));
    size += m.size; entries += m.entries; nestedGit ||= m.nestedGit;
    if (entries > MAX_ENTRIES || nestedGit) break;
  }
  return { size, entries, nestedGit };
}

/**
 * 같은 디스크면 이름만 바꾼다. 다른 디스크면 임시 이름으로 다 복사한 뒤에 제 이름을 붙이고, 그 뒤에 원본을 지운다:
 * 복사하다 실패하면 원본은 그대로이고 반쯤 복사된 것은 치운다.
 */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) throw new Error(`옮길 자리에 이미 다른 것이 있습니다: ${to}`);
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    const partial = `${to}.partial`;
    try {
      cpSync(from, partial, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    } catch (copyError) {
      rmSync(partial, { recursive: true, force: true });
      throw copyError;
    }
    renameSync(partial, to);
    rmSync(from, { recursive: true, force: true });
  }
}

const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

export interface CleanupResult {
  moved: CleanupItem[];
  /** 옮기지 않은 것과 그 이유 */
  skipped: { path: string; reason: string }[];
}

/**
 * "정리 대기": 최종 산출물이 아닌 파일(실험 스크립트, 로그, 임시 메모)을 지우지 않고 저장소 밖으로 옮겨 둔다.
 * 프로젝트를 완료 처리할 때 사용자가 목록을 보고 지운다. 그 전에는 언제든 제자리로 되돌릴 수 있다.
 *
 * 옮겨 달라는 쪽(에이전트)은 믿지 않는다: 조종된 에이전트가 소스나 .git 을 옮기게 하려 할 수 있다.
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

  private projectDone(projectId: string): boolean {
    const r = this.d.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string } | undefined;
    return r?.status === 'done';
  }

  /** 항목 하나를 두는 폴더. DB 의 값이 이상해도 저장 폴더 밖을 가리키지 않게 여기서 한 번 더 본다. */
  private itemDir(projectId: string, id: string): string | undefined {
    const dir = resolve(this.d.dir, projectId, id);
    return dir.startsWith(resolve(this.d.dir) + sep) && dir !== resolve(this.d.dir, projectId) ? dir : undefined;
  }

  /** 옮겨 둔 것의 실제 위치. 저장 폴더에서 찾는다 (DB 에 적힌 절대 경로는 데이터 폴더를 옮기면 틀려진다). */
  private storedPath(r: Row): string | undefined {
    const dir = this.itemDir(r.project_id, r.id);
    if (!dir) return undefined;
    let names: string[];
    try { names = readdirSync(dir).filter((n) => !n.endsWith('.partial')); } catch { return undefined; }
    return names.length === 1 ? join(dir, names[0]!) : undefined;
  }

  /**
   * 워크스페이스의 작업 폴더에 있는 것을 정리 대기로 옮긴다. 옮길 수 없는 것은 건너뛰고 이유를 돌려준다.
   * 옮기는 것은 git 이 추적하지 않고 무시하지도 않는 것뿐이다: 커밋됐거나 고치는 중인 파일, 빌드 결과와 캐시는 건드리지 않는다.
   */
  async stash(workspaceId: string, paths: string[], reason: string): Promise<CleanupResult> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error(`워크스페이스가 없습니다: ${workspaceId}`);
    if (this.projectDone(ws.projectId)) throw new Error(DONE_PROJECT_CLEANUP);
    if (!existsSync(ws.worktreePath)) throw new Error('작업 폴더가 없습니다.');
    const root = realpathSync.native(ws.worktreePath);
    // git 이 이 작업 폴더를 제대로 알아야 "추적하는 파일인가" 를 믿을 수 있다. 아니면 아무것도 옮기지 않는다.
    const top = await this.d.git.raw(['-C', root, 'rev-parse', '--show-toplevel']).then((s) => s.trim(), () => '');
    if (!top || realpathSync.native(top) !== root) throw new Error('작업 폴더의 git 상태를 확인할 수 없어 아무것도 옮기지 않았습니다.');
    // eslint-disable-next-line no-control-regex
    const why = String(reason ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);
    const result: CleanupResult = { moved: [], skipped: [] };
    const seen: string[] = [];
    for (const given of Array.isArray(paths) ? paths.slice(0, 200) : []) {
      const shown = String(given);
      const skip = (r: string): void => { result.skipped.push({ path: shown, reason: r }); };
      try {
        if (typeof given !== 'string' || !given.trim()) { skip('경로가 비어 있다'); continue; }
        const full = isAbsolute(given) ? resolve(given) : resolve(root, given);
        let before: Stats;
        try { before = lstatSync(full); } catch { skip('없는 파일이다'); continue; }
        // 링크 자체를 옮긴다: 링크가 가리키는 곳은 따라가지 않는다. 부모 폴더까지만 실제 위치로 푼다.
        const parent = realpathSync.native(dirname(full));
        const real = join(parent, basename(full));
        const rel = relative(root, real);
        if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) { skip('작업 폴더 밖이거나 작업 폴더 자체다'); continue; }

        // 디스크에 적힌 그대로의 이름으로 다시 걷는다. 대소문자만 바꾼 이름("readme.md", ".GIT")은 같은 파일을 가리키지만
        // git 은 다른 이름으로 본다: 표기가 다르면 옮기지 않는다. 가는 길에 다른 저장소(.git)가 있어도 옮기지 않는다.
        const parts = rel.split(sep);
        let cursor = root;
        let problem = '';
        const exact: string[] = [];
        for (let i = 0; i < parts.length && !problem; i++) {
          const names = readdirSync(cursor);
          if (i > 0 && names.some(isGitName)) { problem = '다른 저장소(서브모듈이나 중첩 저장소) 안의 것이다'; break; }
          const onDisk = names.find((n) => n === parts[i]) ?? names.find((n) => n.normalize('NFC') === parts[i]!.normalize('NFC'));
          if (isGitName(parts[i]!)) problem = 'git 의 내부 파일이다';
          else if (!onDisk) problem = names.some((n) => fold(n) === fold(parts[i]!)) ? '이름의 대소문자가 디스크의 것과 다르다. 정확한 이름으로 다시 줘라' : '없는 파일이다';
          else { exact.push(onDisk); cursor = join(cursor, onDisk); }
        }
        if (problem) { skip(problem); continue; }
        const exactRel = exact.join('/');
        const target = join(root, ...exact);
        if (seen.some((s) => exactRel === s || exactRel.startsWith(`${s}/`))) continue; // 이미 옮긴 것(또는 그 안의 것)

        // git 에게 묻는다. 경로를 글자 그대로 받게 한다: ":(glob)…" 같은 이름이 특별한 뜻으로 읽히면 판정이 틀린다.
        const ask = (args: string[]): Promise<string[] | null> =>
          this.d.git.raw(['--literal-pathspecs', '-C', root, 'ls-files', '-z', ...args, '--', exactRel]).then((o) => o.split('\0').filter(Boolean), () => null);
        const tracked = await ask([]);
        if (tracked === null) { skip('git 으로 확인할 수 없다'); continue; }
        if (tracked.length > 0) { skip('git 이 추적하는 파일이다 (결과물일 수 있다). 지우려면 사용자에게 알려라'); continue; }
        // 자신이 무시되는 파일이거나, 폴더 안에 무시되는 파일(.env, 빌드 결과)이 있으면 옮기지 않는다.
        const ignored = await ask(['-o', '-i', '--exclude-standard']);
        if (ignored === null) { skip('git 으로 확인할 수 없다'); continue; }
        if (ignored.length > 0) { skip('git 이 무시하는 파일이거나 안에 그런 파일이 있다 (빌드 결과, 캐시, 비밀 값). 옮기지 않는다'); continue; }

        const m = measure(target);
        if (m.nestedGit) { skip('안에 다른 저장소(.git)가 있다'); continue; }
        if (m.entries > MAX_ENTRIES || m.size > MAX_MOVE_BYTES) { skip('너무 크다 (다시 만들 수 있는 산출물이라면 그대로 둬라)'); continue; }

        // 확인하는 사이에 다른 것으로 바뀌지 않았는지 본다 (폴더를 밖을 가리키는 링크로 바꿔치기하는 경우).
        const now = lstatSync(target);
        if (!sameFile(before, now) || realpathSync.native(dirname(target)) !== dirname(target)) { skip('확인하는 사이에 파일이 바뀌었다'); continue; }

        const id = crypto.randomUUID();
        const dir = this.itemDir(ws.projectId, id);
        if (!dir) { skip('저장할 자리를 만들 수 없다'); continue; }
        const stored = join(dir, basename(target));
        // 기록을 먼저 남긴다: 옮긴 뒤에 기록이 실패하면 파일이 어디에도 보이지 않게 된다.
        this.d.db.prepare(
          `INSERT INTO cleanup_items (id, project_id, workspace_id, workspace_name, path, stored_path, reason, size, is_dir, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, ws.projectId, ws.id, ws.name, exact.join(sep), stored, why, m.size, now.isDirectory() ? 1 : 0, Date.now());
        try {
          move(target, stored);
        } catch (e) {
          this.d.db.prepare('DELETE FROM cleanup_items WHERE id = ?').run(id);
          rmSync(dir, { recursive: true, force: true });
          throw e;
        }
        seen.push(exactRel);
        result.moved.push(toItem(this.row(id)!));
      } catch (e) {
        skip(e instanceof Error ? e.message : String(e));
      }
    }
    if (result.moved.length > 0) this.emit('changed', ws.projectId);
    return result;
  }

  /** 옮겨 둔 것을 dest 로 옮기고 목록에서 뺀다. dest 는 부른 쪽이 안전한지 확인한 경로다. */
  private takeOut(r: Row, dest: string): void {
    const from = this.storedPath(r);
    // 찾지 못했다고 지우지 않는다: 데이터 폴더가 옮겨졌거나 잠깐 못 읽은 것일 수 있다.
    if (!from) throw new Error('옮겨 둔 파일을 찾을 수 없습니다. 두레 데이터 폴더를 확인하세요.');
    try { lstatSync(dest); throw new Error(`그 자리에 이미 다른 것이 있습니다: ${dest}`); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    move(from, dest);
    this.drop([r.id]);
    const dir = this.itemDir(r.project_id, r.id);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  /** 옮겨 둔 것을 제자리로 되돌린다. 그 자리에 이미 다른 것이 있으면 덮어쓰지 않고 오류를 낸다. */
  restore(id: string): void {
    const r = this.row(id);
    if (!r) throw new Error('정리 대기에 없는 항목입니다.');
    if (this.projectDone(r.project_id)) throw new Error(DONE_PROJECT_CLEANUP);
    const ws = r.workspace_id ? this.d.workspaces.get(r.workspace_id) : undefined;
    if (!ws || !existsSync(ws.worktreePath)) throw new Error('되돌릴 작업 폴더가 없습니다 (워크스페이스나 작업 폴더가 지워졌습니다). "내보내기" 로 다른 폴더에 꺼낼 수 있습니다.');
    const root = realpathSync.native(ws.worktreePath);
    const target = resolve(root, r.path);
    const rel = relative(root, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || rel.split(sep).some(isGitName)) throw new Error('되돌릴 위치가 작업 폴더 밖입니다.');
    try { lstatSync(target); throw new Error(`그 자리에 이미 다른 것이 있습니다: ${r.path}`); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    // 돌려놓을 폴더가 그 사이 밖을 가리키는 링크로 바뀌었을 수 있다. 지금 있는 가장 가까운 폴더의 실제 위치를 본다.
    let parent = dirname(target);
    while (!existsSync(parent)) parent = dirname(parent);
    const realParent = realpathSync.native(parent);
    if (realParent !== root && !realParent.startsWith(root + sep)) throw new Error('되돌릴 위치가 작업 폴더 밖을 가리킵니다.');
    this.takeOut(r, join(realParent, relative(parent, target)));
  }

  /**
   * 옮겨 둔 것을 사용자가 고른 폴더로 꺼낸다 (워크스페이스가 지워져 되돌릴 자리가 없을 때).
   * 화면에서 사용자가 직접 고른 폴더만 받는다. 에이전트에게는 열어 주지 않는다.
   */
  exportTo(id: string, folder: string): string {
    const r = this.row(id);
    if (!r) throw new Error('정리 대기에 없는 항목입니다.');
    if (!isAbsolute(folder) || !existsSync(folder) || !lstatSync(folder).isDirectory()) throw new Error('꺼낼 폴더가 없습니다.');
    const dest = join(realpathSync.native(folder), basename(r.path));
    this.takeOut(r, dest);
    return dest;
  }

  /** 옮겨 둔 것을 지운다 (완료 처리, 프로젝트 삭제). 지운 수를 돌려준다. */
  remove(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      const r = this.row(id);
      if (!r) continue;
      const dir = this.itemDir(r.project_id, r.id);
      try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { continue; } // 못 지운 것은 목록에 남긴다
      this.drop([id]);
      n++;
    }
    return n;
  }

  /** 프로젝트의 것을 모두 지운다. */
  removeProject(projectId: string): void {
    this.remove(this.list(projectId).map((i) => i.id));
    const dir = resolve(this.d.dir, projectId);
    if (dir.startsWith(resolve(this.d.dir) + sep)) rmSync(dir, { recursive: true, force: true });
  }

  /** 목록에서만 뺀다. 디스크는 건드리지 않는다. */
  private drop(ids: string[]): void {
    const projects = new Set<string>();
    for (const id of ids) {
      const r = this.row(id);
      if (!r) continue;
      projects.add(r.project_id);
      this.d.db.prepare('DELETE FROM cleanup_items WHERE id = ?').run(id);
    }
    for (const p of projects) this.emit('changed', p);
  }
}
