import type { ChatItem, ChatStep, Message } from '@shared/types';
import { elapsed, matchCommands, mergeEntries, recallView, rememberView, stepsLabel, toBlocks, toInline } from '../../src/renderer/chatView';

test('toBlocks: 문단, 제목, 목록, 번호 목록, 코드 블록(언어), 표, 가로줄', () => {
  const md = ['# 제목', '', '첫 문단', '이어지는 줄', '', '- 하나', '- 둘', '  - 둘의 하나', '', '1. 첫째', '2. 둘째', '', '```ts', 'const a = 1;', '', '# 제목 아님', '```', '',
    '| 이름 | 값 |', '|---|---|', '| a | 1 |', '| b | 2 |', '', '---', '끝'].join('\n');
  expect(toBlocks(md)).toEqual([
    { type: 'heading', level: 1, text: '제목' },
    { type: 'p', text: '첫 문단\n이어지는 줄' },
    { type: 'list', ordered: false, items: [{ text: '하나', depth: 0 }, { text: '둘', depth: 0 }, { text: '둘의 하나', depth: 1 }] },
    { type: 'list', ordered: true, items: [{ text: '첫째', depth: 0 }, { text: '둘째', depth: 0 }] },
    { type: 'code', lang: 'ts', text: 'const a = 1;\n\n# 제목 아님' },
    { type: 'table', rows: [['이름', '값'], ['a', '1'], ['b', '2']] },
    { type: 'rule' },
    { type: 'p', text: '끝' },
  ]);
});

test('toBlocks: 닫히지 않은 코드 블록도 코드로 본다', () => {
  expect(toBlocks('설명\n```bash\nnpm test')).toEqual([{ type: 'p', text: '설명' }, { type: 'code', lang: 'bash', text: 'npm test' }]);
});

test('toBlocks: 빈 글과 줄바꿈만 있는 글은 빈 배열', () => {
  expect(toBlocks('')).toEqual([]);
  expect(toBlocks('\n\n  \n')).toEqual([]);
});

test('toBlocks: | 가 들어 있어도 구분 줄이 없으면 표가 아니다', () => {
  expect(toBlocks('a | b\nc | d')).toEqual([{ type: 'p', text: 'a | b\nc | d' }]);
});

test('toInline: `코드`, **굵게**, 섞인 경우', () => {
  expect(toInline('그냥 글')).toEqual([{ text: '그냥 글' }]);
  expect(toInline('`npm test` 를 **꼭** 실행')).toEqual([{ text: 'npm test', code: true }, { text: ' 를 ' }, { text: '꼭', bold: true }, { text: ' 실행' }]);
  expect(toInline('**굵은 `코드`**')).toEqual([{ text: '굵은 ', bold: true }, { text: '코드', code: true, bold: true }]);
});

test('toInline: 짝이 안 맞는 표시는 글자 그대로', () => {
  expect(toInline('a ` b')).toEqual([{ text: 'a ` b' }]);
  expect(toInline('2 ** 3')).toEqual([{ text: '2 ** 3' }]);
  expect(toInline('``')).toEqual([{ text: '``' }]);
  expect(toInline('`**별**`')).toEqual([{ text: '**별**', code: true }]);
});

test('toBlocks/toInline: HTML 은 해석하지 않고 글자 그대로 남는다', () => {
  const evil = '<script>alert(1)</script> <img src=x onerror=alert(1)> [링크](javascript:alert(1))';
  expect(toBlocks(evil)).toEqual([{ type: 'p', text: evil }]);
  expect(toInline(evil)).toEqual([{ text: evil }]);
});

const step = (tool: string, status: ChatStep['status'] = 'done', summary = tool): ChatStep =>
  ({ id: crypto.randomUUID(), tool, summary, input: '', output: null, status, startedAt: 0, endedAt: status === 'running' ? null : 1 });

test('stepsLabel: 종류별 문구와 하는 중', () => {
  expect(stepsLabel([step('Bash'), step('Bash'), step('Bash')])).toBe('명령 3개 실행함');
  expect(stepsLabel([step('Bash'), step('Bash', 'running')])).toBe('명령 2개 실행 중…');
  expect(stepsLabel([step('Read'), step('Grep')])).toBe('파일 2개 살펴봄');
  expect(stepsLabel([step('Edit'), step('Write', 'running')])).toBe('파일 2개 고치는 중…');
  expect(stepsLabel([step('Bash'), step('Edit')])).toBe('작업 2개 함');
  expect(stepsLabel([step('mcp__github__x', 'running')])).toBe('작업 1개 하는 중…');
  expect(stepsLabel([step('mcp__dure__todo_add', 'done', 'TODO 추가')])).toBe('TODO 추가');
  expect(stepsLabel([step('mcp__dure__message_send', 'running', '메시지 보냄')])).toBe('메시지 보냄 중…');
  expect(stepsLabel([step('mcp__dure__todo_add'), step('mcp__dure__todo_update')])).toBe('두레 작업 2개 함');
});

test('elapsed: 45초, 3분 12초, 1시간 5분', () => {
  expect(elapsed(45_000)).toBe('45초');
  expect(elapsed(192_000)).toBe('3분 12초');
  expect(elapsed(3_900_000)).toBe('1시간 5분');
  expect(elapsed(-5)).toBe('0초');
});

const ME = 'front';
const THREAD = '11111111-2222-3333-4444-555555555555';
const msg = (o: Partial<Message>): Message => ({
  id: crypto.randomUUID(), threadId: THREAD, projectId: 'p', from: { kind: 'workspace', workspaceId: 'back' }, toWorkspaceId: ME,
  body: '본문', artifactIds: [], createdAt: 100, deliveredAt: 110, failed: false, ...o,
});
const user = (at: number, text = '해줘'): ChatItem => ({ kind: 'user', id: `u${at}`, at, text });
const say = (at: number, text = '답'): ChatItem => ({ kind: 'assistant', id: `a${at}`, at, text });
const shape = (items: ChatItem[], messages: Message[]): string[] =>
  mergeEntries(items, messages, ME).map((e) => (e.kind === 'peer' ? `${e.direction}:${e.message.body}${e.pending ? ':대기' : ''}` : e.kind));

test('mergeEntries: 보낸 것과 받은 것을 시각 순서로 끼운다', () => {
  const items = [user(10), say(50), say(200)];
  const sentMsg = msg({ from: { kind: 'workspace', workspaceId: ME }, toWorkspaceId: 'back', body: '질문', createdAt: 60, deliveredAt: 61 });
  const got = msg({ body: '대답', createdAt: 100, deliveredAt: 120 });
  expect(shape(items, [got, sentMsg])).toEqual(['user', 'assistant', 'sent:질문', 'received:대답', 'assistant']);
});

test('mergeEntries: 메시지 전달을 알리는 dure 항목은 그 자리의 메시지 카드로 대신한다', () => {
  const dure: ChatItem = { kind: 'dure', id: 'd', at: 300, title: `워크스페이스 "백엔드" 이(가) 보낸 메시지다. (스레드 ${THREAD})`, text: '> 형식을 정했다.\n> 둘째 줄\n답하려면 message_send 에 …' };
  const other = msg({ body: '다른 메시지', createdAt: 90, deliveredAt: 95 });
  const hit = msg({ body: '형식을 정했다.\n둘째 줄', createdAt: 100, deliveredAt: 110 });
  const todo: ChatItem = { kind: 'dure', id: 't', at: 310, title: '사용자가 TODO를 바꿨다:', text: '- 추가됨' };
  const out = mergeEntries([user(10), say(250), dure, todo], [other, hit], ME);
  expect(out.map((e) => e.kind)).toEqual(['user', 'peer', 'assistant', 'peer', 'dure']);
  expect(out[3]).toMatchObject({ kind: 'peer', direction: 'received', at: 300, message: { body: '형식을 정했다.\n둘째 줄' } });
  expect(out[1]).toMatchObject({ kind: 'peer', message: { body: '다른 메시지' } });
});

test('mergeEntries: 같은 메시지를 두 번 넣지 않는다', () => {
  const dure: ChatItem = { kind: 'dure', id: 'd', at: 300, title: `두레가 알린다. (스레드 ${THREAD})`, text: '> 커밋됨' };
  const m = msg({ from: { kind: 'system' }, body: '커밋됨', createdAt: 290, deliveredAt: 299 });
  expect(shape([user(10), dure], [m])).toEqual(['user', 'received:커밋됨']);
});

test('mergeEntries: 다른 워크스페이스끼리의 메시지와 전달 실패한 것은 넣지 않는다', () => {
  const others = msg({ from: { kind: 'workspace', workspaceId: 'back' }, toWorkspaceId: 'infra', body: '남의 것' });
  const failed = msg({ body: '실패', failed: true, deliveredAt: null });
  expect(shape([user(10)], [others, failed])).toEqual(['user']);
});

test('mergeEntries: 지금 대화가 시작되기 전에 오간 메시지는 넣지 않는다', () => {
  const old = msg({ body: '지난 대화', createdAt: 1, deliveredAt: 2 });
  const oldSent = msg({ from: { kind: 'workspace', workspaceId: ME }, toWorkspaceId: 'back', body: '지난 질문', createdAt: 3 });
  expect(shape([user(10)], [old, oldSent])).toEqual(['user']);
  expect(shape([], [old, oldSent])).toEqual([]);
});

test('mergeEntries: 아직 전달되지 않은 받은 메시지는 맨 끝에 대기로 보인다', () => {
  const waiting = msg({ body: '기다리는 중', createdAt: 5, deliveredAt: null });
  expect(shape([user(10), say(20)], [waiting])).toEqual(['user', 'assistant', 'received:기다리는 중:대기']);
  expect(shape([], [waiting])).toEqual(['received:기다리는 중:대기']);
});

test('보기 전환 기억: 처음은 터미널, 고른 값은 워크스페이스별로 남는다', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  expect(recallView('w1', storage)).toBe('terminal');
  rememberView('w1', 'chat', storage);
  expect(recallView('w1', storage)).toBe('chat');
  expect(recallView('w2', storage)).toBe('terminal');
  expect(recallView('w1', undefined)).toBe('terminal');
  expect(recallView('w1', { getItem: () => { throw new Error('막힘'); } })).toBe('terminal');
});

test('보기 전환 기억: 고른 적이 없으면 주어진 기본값 (채팅 방식의 워크스페이스는 채팅)', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  expect(recallView('w1', storage, 'chat')).toBe('chat');
  rememberView('w1', 'terminal', storage);
  expect(recallView('w1', storage, 'chat')).toBe('terminal');
});

test('matchCommands: "/" 로 시작하는 한 낱말일 때만, 앞글자가 맞는 것이 먼저', () => {
  const cmds = ['compact', 'context', 'clear', 'model', 'superpowers:brainstorming', 'cost'].map((name) => ({ name, description: '', argumentHint: '' }));
  expect(matchCommands('/', cmds).map((c) => c.name)).toEqual(['compact', 'context', 'clear', 'model', 'superpowers:brainstorming', 'cost']);
  expect(matchCommands('/co', cmds).map((c) => c.name)).toEqual(['compact', 'context', 'cost']);
  expect(matchCommands('/CO', cmds).map((c) => c.name)).toEqual(['compact', 'context', 'cost']);
  expect(matchCommands('/brain', cmds).map((c) => c.name)).toEqual(['superpowers:brainstorming']);
  expect(matchCommands('/', cmds, 2).length).toBe(2);
  expect(matchCommands('/model opus', cmds)).toEqual([]);
  expect(matchCommands('안녕 /co', cmds)).toEqual([]);
  expect(matchCommands('', cmds)).toEqual([]);
  expect(matchCommands('/zzz', cmds)).toEqual([]);
});
