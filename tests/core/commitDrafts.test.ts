import { CommitDraftStore } from '@core/commitDrafts';
import { openDatabase } from '@core/db';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';

function setup() {
  const db = openDatabase(':memory:');
  const p = new ProjectStore(db).create('p');
  const r = new RepoStore(db).add(p.id, '/tmp/r');
  const workspaces = new WorkspaceStore(db);
  const ws = workspaces.insert({
    id: crypto.randomUUID(), projectId: p.id, repoId: r.id, name: 'w', nameLocked: true, branch: 'b', baseBranch: 'main',
    worktreePath: '/tmp/w', agentKind: 'claude', permissionMode: 'ask', token: 't',
  });
  return { drafts: new CommitDraftStore(db), workspaces, ws };
}

test('save 는 덮어쓰고 get 은 마지막 것을 준다', () => {
  const { drafts, ws } = setup();
  const seen: string[] = [];
  drafts.on('changed', (id) => seen.push(id));
  expect(drafts.get(ws.id)).toBeUndefined();
  drafts.save(ws.id, 'feat: 첫 초안');
  const d = drafts.save(ws.id, 'feat: 둘째 초안\n\n본문 "따옴표"');
  expect(d).toMatchObject({ workspaceId: ws.id, message: 'feat: 둘째 초안\n\n본문 "따옴표"' });
  expect(drafts.get(ws.id)?.message).toBe('feat: 둘째 초안\n\n본문 "따옴표"');
  expect(seen).toEqual([ws.id, ws.id]);
});

test('빈 글은 오류', () => {
  const { drafts, ws } = setup();
  expect(() => drafts.save(ws.id, '  \n')).toThrow('커밋 메시지를 입력하세요.');
});

test('clear 뒤에는 없다', () => {
  const { drafts, ws } = setup();
  drafts.save(ws.id, 'x');
  drafts.clear(ws.id);
  expect(drafts.get(ws.id)).toBeUndefined();
});

test('워크스페이스를 지우면 초안도 사라진다', () => {
  const { drafts, workspaces, ws } = setup();
  drafts.save(ws.id, 'x');
  workspaces.remove(ws.id);
  expect(drafts.get(ws.id)).toBeUndefined();
});
