import { openDatabase } from '@core/db';
import { StewardService, type StewardDeps } from '@core/steward';
import type { AttentionItem, ChatView, Settings, StewardApproval } from '@shared/types';

/** 비서가 스스로 정해도 되는 범위를, 가짜 출처로 종류마다 본다. */
function make(level: StewardApproval, items: Partial<AttentionItem>[], over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const view: { v: Partial<ChatView> } = { v: {} };
  const deps = {
    db: openDatabase(':memory:'),
    settings: () => ({ stewardApproval: level, stewardName: '비서', stewardAuto: false }) as Settings,
    projects: { list: () => [], get: (id: string) => ({ id, name: 'p' }), steward: () => undefined, ensureSteward: () => { throw new Error('x'); } },
    workspaces: { get: () => undefined, listAll: () => [] },
    ensureCoordinator: () => { throw new Error('x'); },
    isClosed: () => false, blocked: () => null,
    attention: () => items.map((i) => ({ projectId: 'p1', projectName: 'p', workspaceId: 'w1', title: 't', detail: '', ...i })) as AttentionItem[],
    chatView: () => view.v as ChatView,
    todos: {},
    answerPermission: (_w: string, a: string, r: string) => calls.push(`permission ${a} ${r}`),
    answerQuestion: (_w: string, r: string, a: Record<string, string>) => calls.push(`question ${r} ${JSON.stringify(a)}`),
    nudge: async () => { calls.push('nudge'); }, dismissStuck: () => calls.push('dismiss'),
    plan: { pending: () => null },
    dbs: { pending: () => [{ id: 'd1', connectionName: 'main', sql: 'select 1', warnings: [] }, { id: 'd2', connectionName: 'main', sql: 'select 1', warnings: ['이 계정은 쓰기도 할 수 있습니다'] }], decide: async (id: string, allow: boolean) => { calls.push(`db ${id} ${allow}`); } },
    slack: { pending: () => [{ id: 's1', what: '#general 읽기' }], decide: async (id: string, allow: boolean) => { calls.push(`slack ${id} ${allow}`); } },
    browser: { pending: () => [{ id: 'b1', origin: 'http://localhost:3000', url: 'http://localhost:3000/' }, { id: 'b2', origin: 'https://localhost.evil.com', url: 'https://localhost.evil.com/' }], decide: (id: string, allow: boolean) => calls.push(`browser ${id} ${allow}`) },
    peers: { held: () => [{ id: 'h1', fromLabel: '화면@준호', toPerson: false, toWorkspaceId: 'w1', body: 'x', artifacts: [] }, { id: 'h2', fromLabel: '준호', toPerson: true, toWorkspaceId: '', body: 'x', artifacts: [] }], pass: (id: string) => calls.push(`pass ${id}`), drop: (id: string) => calls.push(`drop ${id}`), shareInvites: () => [] },
    assignments: { incoming: () => [] }, agreements: { list: () => [] },
    send: () => undefined, audit: () => undefined,
    ...over,
  } as unknown as StewardDeps;
  return { steward: new StewardService(deps), calls, view };
}
const allowedOf = (level: StewardApproval, item: Partial<AttentionItem>, viewOf?: Partial<ChatView>): boolean => {
  const m = make(level, [item]); if (viewOf) m.view.v = viewOf;
  return m.steward.items()[0]!.allowed;
};
const question = (text: string): Partial<ChatView> => ({ question: { requestId: 'q1', questions: [{ question: text, header: '', multiSelect: false, options: [{ label: '1안', description: '' }, { label: '2안', description: '' }] }] } });
const permission = (input: string): Partial<ChatView> => ({ pendingPermission: { tool: 'Bash', summary: input.slice(0, 40), input, canAnswer: true, requestId: 'r1' } });

test('안전한 것만: 경고 없는 DB 조회, 슬랙 읽기, 이 PC 의 주소, 멈춘 에이전트는 정하고, 그 밖은 정하지 않는다', () => {
  expect(allowedOf('safe', { id: 'db:d1', kind: 'db' })).toBe(true);
  expect(allowedOf('safe', { id: 'db:d2', kind: 'db' })).toBe(false); // 계정이 조회 말고도 할 수 있다
  expect(allowedOf('safe', { id: 'slack:s1', kind: 'slack' })).toBe(true);
  expect(allowedOf('safe', { id: 'browser:b1', kind: 'browser' })).toBe(true);
  expect(allowedOf('safe', { id: 'browser:b2', kind: 'browser' })).toBe(false); // localhost 로 보이게 꾸민 바깥 주소
  expect(allowedOf('safe', { id: 'browser:gone', kind: 'browser' })).toBe(false);
  expect(allowedOf('safe', { id: 'stuck:w1:quiet:1', kind: 'stuck' })).toBe(true);
  for (const kind of ['plan', 'held', 'assign', 'brief', 'invite', 'agreement'] as const) expect(allowedOf('safe', { id: `${kind}:x`, kind })).toBe(false);
  // 권한 요청은 무겁고, 선택지 질문은 되돌리기 어려운 말이 없을 때만 가볍다
  expect(allowedOf('safe', { id: 'agent:w1', kind: 'agent' }, permission('npm test'))).toBe(false);
  expect(allowedOf('safe', { id: 'agent:w1', kind: 'agent' }, question('1안으로 갈까요?'))).toBe(true);
  expect(allowedOf('safe', { id: 'agent:w1', kind: 'agent' }, question('데이터를 삭제할까요?'))).toBe(false);
});

test('추천만: 아무것도 정하지 않는다. 전부 스스로: 연결 확인, 나에게 온 질문, 예산·한도는 여전히 정하지 못한다', () => {
  for (const [id, kind] of [['db:d1', 'db'], ['slack:s1', 'slack'], ['browser:b1', 'browser'], ['stuck:w1:quiet:1', 'stuck']] as const) expect(allowedOf('suggest', { id, kind })).toBe(false);
  expect(allowedOf('all', { id: 'db:d2', kind: 'db' })).toBe(true);
  expect(allowedOf('all', { id: 'browser:b2', kind: 'browser' })).toBe(true);
  expect(allowedOf('all', { id: 'held:h1', kind: 'held' })).toBe(true);
  expect(allowedOf('all', { id: 'held:h2', kind: 'held' })).toBe(false); // 나에게 직접 온 질문
  expect(allowedOf('all', { id: 'agent:w1', kind: 'agent' }, permission('rm -rf build'))).toBe(true);
  for (const kind of ['pair', 'budget', 'limit', 'ship'] as const) {
    const m = make('all', [{ id: `${kind}:x`, kind }]);
    expect(m.steward.items()[0]).toMatchObject({ allowed: false });
    expect(m.steward.items()[0]!.why).not.toBe('');
  }
});

test('내용이 길어 다 보이지 않는 요청은 정하지 않는다', () => {
  expect(allowedOf('all', { id: 'agent:w1', kind: 'agent' }, permission(`echo ${'a'.repeat(7000)}`))).toBe(false);
  // 대화 기록에서 이미 잘려 온 명령 (끝에 생략 표시)
  expect(allowedOf('all', { id: 'agent:w1', kind: 'agent' }, permission('npm test && echo ok\n… (5000자 생략)'))).toBe(false);
  expect(make('all', [{ id: 'agent:w1', kind: 'agent' }]).steward.items()[0]!.allowed).toBe(true);
});

test('에이전트의 요청은 본 것과 정하는 것이 같아야 한다: 그 사이에 바뀌면 정하지 않는다', async () => {
  const m = make('all', [{ id: 'agent:w1', kind: 'agent' }]); m.view.v = permission('npm test');
  expect(m.steward.items()[0]!.request).toBe('r1');
  await expect(m.steward.decide('agent:w1', 'approve', { reason: '시험이다' })).rejects.toThrow('request');
  // 본 뒤에 에이전트가 다른 것을 물었다
  m.view.v = { pendingPermission: { tool: 'Bash', summary: 'rm -rf /', input: 'rm -rf /', canAnswer: true, requestId: 'r2' } };
  await expect(m.steward.decide('agent:w1', 'approve', { reason: '시험이다', request: 'r1' })).rejects.toThrow('바뀌었거나');
  expect(m.calls).toEqual([]);
  expect(await m.steward.decide('agent:w1', 'deny', { reason: '근거가 없다', request: 'r2' })).toBe('거부함: rm -rf /');
  expect(m.calls).toEqual(['permission deny r2']);
});

test('선택지 질문: 안전한 것만에서는 추천(첫째)만 대신 고른다. 질문에 없는 답은 받지 않는다', async () => {
  const safe = make('safe', [{ id: 'agent:w1', kind: 'agent' }]); safe.view.v = question('1안으로 갈까요?');
  await expect(safe.steward.decide('agent:w1', 'approve', { reason: 'x', request: 'q1', answers: { '1안으로 갈까요?': '2안' } })).rejects.toThrow('첫째(추천)');
  await expect(safe.steward.decide('agent:w1', 'approve', { reason: 'x', request: 'q1', answers: { '다른 질문': '1안' } })).rejects.toThrow('이 요청의 질문이 아닙니다');
  expect(await safe.steward.decide('agent:w1', 'approve', { reason: '추천안이다', request: 'q1' })).toBe('질문에 답함: 1안');
  expect(safe.calls).toEqual(['question q1 {"1안으로 갈까요?":"1안"}']);
  const all = make('all', [{ id: 'agent:w1', kind: 'agent' }]); all.view.v = question('1안으로 갈까요?');
  expect(await all.steward.decide('agent:w1', 'approve', { reason: '2안이 계획과 맞다', request: 'q1', answers: { '1안으로 갈까요?': '2안' } })).toBe('질문에 답함: 2안');
  await expect(all.steward.decide('agent:w1', 'deny', { reason: 'x', request: 'q1' })).rejects.toThrow('거절할 수 없습니다');
});

test('DB 조회의 결정이 실패하면 허용했다고 적지 않는다', async () => {
  const m = make('safe', [{ id: 'db:d1', kind: 'db' }], { dbs: { pending: () => [{ id: 'd1', connectionName: 'main', sql: 'select 1', warnings: [] }], decide: async () => { throw new Error('연결이 바뀌었습니다'); } } });
  await expect(m.steward.decide('db:d1', 'approve', { reason: '읽기다' })).rejects.toThrow('연결이 바뀌었습니다');
  expect(m.steward.history()[0]!.outcome).toBe('실패: 연결이 바뀌었습니다');
});
