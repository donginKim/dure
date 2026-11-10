import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@core/db';
import { ProjectStore, RepoStore, WorkspaceStore, type NewWorkspace } from '@core/stores';

function setup(file = ':memory:') {
  const db = openDatabase(file);
  return { db, projects: new ProjectStore(db), repos: new RepoStore(db), workspaces: new WorkspaceStore(db) };
}

function newWs(projectId: string, repoId: string, over: Partial<NewWorkspace> = {}): NewWorkspace {
  return {
    id: crypto.randomUUID(), projectId, repoId, name: '프론트', nameLocked: true,
    branch: 'dure/프론트', baseBranch: 'main', worktreePath: '/tmp/wt/프론트',
    agentKind: 'claude', permissionMode: 'ask', token: 'tok-' + crypto.randomUUID(), ...over,
  };
}

test('프로젝트 생성과 목록', () => {
  const { projects } = setup();
  const p = projects.create('쇼핑몰');
  expect(projects.list()).toHaveLength(1);
  expect(projects.list()[0]).toMatchObject({ id: p.id, name: '쇼핑몰' });
  expect(projects.get(p.id)?.name).toBe('쇼핑몰');
});

test('같은 프로젝트에 같은 경로의 저장소를 두 번 등록하면 오류', () => {
  const { projects, repos } = setup();
  const p = projects.create('p');
  repos.add(p.id, '/tmp/a');
  expect(() => repos.add(p.id, '/tmp/a')).toThrow();
});

test('Repo.name 은 경로 마지막 폴더', () => {
  const { projects, repos } = setup();
  const p = projects.create('p');
  expect(repos.add(p.id, '/tmp/a b/프론트').name).toBe('프론트');
});

test('워크스페이스 insert 기본값', () => {
  const { projects, repos, workspaces } = setup();
  const p = projects.create('p');
  const r = repos.add(p.id, '/tmp/a');
  const w = workspaces.insert(newWs(p.id, r.id));
  expect(w.summary).toBe('');
  expect(w.status).toBe('stopped');
  expect(w.nameLocked).toBe(true);
  expect(typeof w.createdAt).toBe('number');
});

test('토큰으로 찾기, 없는 토큰은 undefined', () => {
  const { projects, repos, workspaces } = setup();
  const p = projects.create('p');
  const r = repos.add(p.id, '/tmp/a');
  const w = workspaces.insert(newWs(p.id, r.id, { token: 'secret-1' }));
  expect(workspaces.findByToken('secret-1')?.id).toBe(w.id);
  expect(workspaces.getToken(w.id)).toBe('secret-1');
  expect(workspaces.findByToken('nope')).toBeUndefined();
});

test('get/list 결과에 token 필드가 없다', () => {
  const { projects, repos, workspaces } = setup();
  const p = projects.create('p');
  const r = repos.add(p.id, '/tmp/a');
  const w = workspaces.insert(newWs(p.id, r.id));
  expect('token' in w).toBe(false);
  expect('token' in workspaces.get(w.id)!).toBe(false);
  expect('token' in workspaces.list(p.id)[0]).toBe(false);
  expect('token' in workspaces.findByToken(workspaces.getToken(w.id))!).toBe(false);
});

test('update 는 지정한 필드만 바꾼다', () => {
  const { projects, repos, workspaces } = setup();
  const p = projects.create('p');
  const r = repos.add(p.id, '/tmp/a');
  const w = workspaces.insert(newWs(p.id, r.id));
  const u = workspaces.update(w.id, { summary: '로그인 API' });
  expect(u.summary).toBe('로그인 API');
  expect(u.name).toBe('프론트');
  expect(workspaces.update(w.id, { status: 'idle', nameLocked: false })).toMatchObject({ status: 'idle', nameLocked: false, summary: '로그인 API' });
});

test('프로젝트 삭제 시 저장소·워크스페이스도 삭제', () => {
  const { projects, repos, workspaces } = setup();
  const p = projects.create('p');
  const r = repos.add(p.id, '/tmp/a');
  const w = workspaces.insert(newWs(p.id, r.id));
  projects.remove(p.id);
  expect(projects.list()).toEqual([]);
  expect(repos.get(r.id)).toBeUndefined();
  expect(workspaces.get(w.id)).toBeUndefined();
});

test('워크스페이스가 쓰는 저장소 삭제는 오류', () => {
  const { projects, repos, workspaces } = setup();
  const p = projects.create('p');
  const r = repos.add(p.id, '/tmp/a');
  workspaces.insert(newWs(p.id, r.id));
  expect(() => repos.remove(r.id)).toThrow();
  expect(repos.get(r.id)).toBeDefined();
});

test('파일 DB를 닫았다 다시 열어도 데이터가 남는다', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dure db ')), 'dure.db');
  const a = setup(file);
  const p = a.projects.create('남는다');
  a.db.close();
  const b = setup(file);
  expect(b.projects.get(p.id)?.name).toBe('남는다');
  b.db.close();
});
