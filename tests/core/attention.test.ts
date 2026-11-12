import { AttentionService, type AttentionSources } from '@core/attention';
import type { AttentionItem } from '@shared/types';

function sources(o: Partial<AttentionSources> = {}): AttentionSources {
  return {
    projects: () => [{ id: 'p1', name: '로그인 개편' }, { id: 'p2', name: '끝난 것' }],
    isClosed: (id) => id === 'p2',
    workspaces: () => [{ id: 'c1', name: '조율', role: 'coordinator', status: 'idle' }, { id: 'w1', name: '화면', status: 'working' }],
    plan: () => null, db: () => [], slack: () => [], browser: () => [], held: () => [], assignments: () => [], briefs: () => [], pairs: () => [], invites: () => [],
    ...o,
  };
}

test('흩어진 요청을 한 목록으로 모은다. 완료된 프로젝트의 것은 뺀다', () => {
  const s = new AttentionService(sources({
    workspaces: (id) => (id === 'p1' ? [{ id: 'c1', name: '조율', role: 'coordinator', status: 'idle' }, { id: 'w1', name: '화면', status: 'waiting_user' }] : [{ id: 'w9', name: 'x', status: 'waiting_user' }]),
    plan: (id) => (id === 'p1' ? { id: 'pl', items: [1, 2], projectTodos: [1] } : null),
    db: () => [{ id: 'd1', workspaceId: 'w1', connectionName: 'shop' }],
    slack: () => [{ id: 's1', workspaceId: 'c1', what: '채널 "dev" 의 메시지 30개까지' }],
    browser: () => [{ id: 'b1', workspaceId: 'w1', origin: 'http://localhost:3000' }],
    held: () => [{ id: 'h1', toWorkspaceId: '', toPerson: true, fromLabel: '조율@기획', body: '어느 저장소?' }, { id: 'h2', toWorkspaceId: 'w1', toPerson: false, fromLabel: '서버@개발', body: 'API 형식' }],
    assignments: () => [{ id: 'a1', fromName: '기획', state: 'pending', items: [1] }, { id: 'a2', fromName: '기획', state: 'accepted', items: [1] }],
    pairs: () => [{ id: 'r1', name: '큰형', direction: 'in', confirmed: false }, { id: 'r2', name: '나', direction: 'out', confirmed: false }, { id: 'r3', name: '확인함', direction: 'in', confirmed: true }],
    invites: () => [{ id: 'i1', name: '카탈로그', fromName: '큰형' }],
  }));
  const list = s.list();
  expect(list.map((i) => i.id)).toEqual(['plan:pl', 'agent:w1', 'db:d1', 'slack:s1', 'browser:b1', 'held:h1', 'held:h2', 'assign:a1', 'pair:r1', 'invite:i1']);
  expect(list.every((i) => i.projectId !== 'p2')).toBe(true);
  expect(list.find((i) => i.id === 'agent:w1')).toMatchObject({ projectName: '로그인 개편', workspaceId: 'w1', title: '"화면" 에이전트가 답을 기다립니다' });
  expect(list.find((i) => i.id === 'slack:s1')!.title).toBe('조율 에이전트가 슬랙을 읽으려 합니다');
  expect(list.find((i) => i.id === 'held:h1')).toMatchObject({ workspaceId: null, title: '"조율@기획" 이(가) 나에게 물었습니다' });
  expect(list.find((i) => i.id === 'pair:r1')).toMatchObject({ projectId: null });
});

test('새로 생긴 것만 알린다. 켤 때 이미 있던 것과 사라진 것은 알리지 않는다', () => {
  let db: { id: string; workspaceId: string; connectionName: string }[] = [{ id: 'old', workspaceId: 'w1', connectionName: 'shop' }];
  const s = new AttentionService(sources({ db: () => db }));
  const added: AttentionItem[][] = []; let changed = 0;
  s.on('added', (items: AttentionItem[]) => added.push(items));
  s.on('changed', () => { changed += 1; });
  s.refresh();
  expect(added).toEqual([]);
  expect(changed).toBe(1);
  // 그대로면 아무것도 알리지 않는다
  s.refresh();
  expect(changed).toBe(1);
  db = [...db, { id: 'new', workspaceId: 'w1', connectionName: 'shop' }];
  s.refresh();
  expect(added.map((l) => l.map((i) => i.id))).toEqual([['db:new']]);
  // 처리돼 사라지면 목록만 바뀐다
  db = [];
  s.refresh();
  expect(added.length).toBe(1);
  expect(changed).toBe(3);
});

test('한 곳이 오류를 내도 나머지는 모은다', () => {
  const s = new AttentionService(sources({ db: () => { throw new Error('x'); }, slack: () => [{ id: 's1', workspaceId: 'w1', what: 'y' }] }));
  expect(s.list().map((i) => i.id)).toEqual(['slack:s1']);
});
