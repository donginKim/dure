import type { Message, Pin, Workspace } from '@shared/types';
import type { Entry } from '../../src/renderer/chatView';
import { findEntry, pinInput, pinKey, pinSourceLabel } from '../../src/renderer/pinsView';

const workspaces = [{ id: 'w1', name: '화면' }, { id: 'w2', name: '서버' }] as Workspace[];
const message = (over: Partial<Message>): Message => ({ id: 'm1', threadId: 't', projectId: 'p', from: { kind: 'workspace', workspaceId: 'w2' } as Message['from'], toWorkspaceId: 'w1', body: 'API 형식이다', artifactIds: [], createdAt: 1, deliveredAt: 2, failed: false, ...over });

test('글의 종류마다 담을 내용과 누가 쓴 글인지를 정한다', () => {
  expect(pinInput({ kind: 'user', id: 'u', at: 1, text: '이렇게 해줘' }, 'w1', workspaces)).toEqual({ workspaceId: 'w1', itemId: 'u', kind: 'user', source: '나', body: '이렇게 해줘' });
  expect(pinInput({ kind: 'assistant', id: 'a', at: 1, text: '## 결과\n끝' }, 'w1', workspaces)).toMatchObject({ itemId: 'a', kind: 'assistant', source: '에이전트', body: '## 결과\n끝' });
  expect(pinInput({ kind: 'dure', id: 'd', at: 1, title: '두레 알림', text: '승인됨' }, 'w1', workspaces)).toMatchObject({ kind: 'dure', body: '두레 알림\n\n승인됨' });
  expect(pinInput({ kind: 'dure', id: 'd', at: 1, title: '제목만', text: '' }, 'w1', workspaces)).toMatchObject({ body: '제목만' });
  expect(pinInput({ kind: 'output', id: 'o', at: 1, text: 'tokens: 10' }, 'w1', workspaces)).toMatchObject({ kind: 'output', body: 'tokens: 10' });
});

test('주고받은 메시지는 누가 보냈는지를 함께 담는다', () => {
  const received: Entry = { kind: 'peer', id: 'p1', at: 1, direction: 'received', pending: false, message: message({}) };
  expect(pinInput(received, 'w1', workspaces)).toEqual({ workspaceId: 'w1', itemId: 'p1', kind: 'peer', source: '서버가 보냄', body: 'API 형식이다' });
  const sent: Entry = { kind: 'peer', id: 'p2', at: 1, direction: 'sent', pending: false, message: message({ toWorkspaceId: 'w2' }) };
  expect(pinInput(sent, 'w1', workspaces)?.source).toBe('서버에게 보냄');
});

test('두레가 전달한 글이 메시지 카드로 바뀌어도 같은 글을 가리킨다', () => {
  const item: Entry = { kind: 'dure', id: 'uuid-1', at: 1, title: '서버가 보냄 (스레드 abcd1234)', text: '> API 형식이다' };
  const card: Entry = { kind: 'peer', id: 'peer:m1', at: 1, direction: 'received', pending: false, message: message({}), anchorId: 'uuid-1' };
  expect(pinKey(item)).toBe('uuid-1');
  expect(pinKey(card)).toBe('uuid-1');
  expect(pinInput(card, 'w1', workspaces)?.itemId).toBe('uuid-1');
  const pin = { id: 'x', workspaceId: 'w1', itemId: 'uuid-1', kind: 'dure', source: '', title: '', body: '', createdAt: 1 } as Pin;
  expect(findEntry([card], pin)).toBe(card);
  expect(findEntry([item], pin)).toBe(item);
});

test('접힌 작업 줄, 안내 줄, 빈 글에는 꽂을 수 없다', () => {
  expect(pinInput({ kind: 'steps', id: 's', at: 1, steps: [] }, 'w1', workspaces)).toBeNull();
  expect(pinInput({ kind: 'notice', id: 'n', at: 1, text: '중단됨' }, 'w1', workspaces)).toBeNull();
  expect(pinInput({ kind: 'assistant', id: 'a', at: 1, text: '  \n ' }, 'w1', workspaces)).toBeNull();
});

test('핀의 글이 지금 화면에 있는지 찾는다. 지난 대화의 글이면 없다', () => {
  const entries: Entry[] = [{ kind: 'user', id: 'u', at: 1, text: '가' }, { kind: 'assistant', id: 'a', at: 2, text: '나' }];
  const pin = (itemId: string): Pin => ({ id: 'x', workspaceId: 'w1', itemId, kind: 'assistant', source: '에이전트', title: '나', body: '나', createdAt: 3 });
  expect(findEntry(entries, pin('a'))).toBe(entries[1]);
  expect(findEntry(entries, pin('gone'))).toBeNull();
  expect(findEntry([], pin('a'))).toBeNull();
});

test('누가 쓴 글인지: 담아 둔 말이 없으면 종류로 보인다', () => {
  const pin = { id: 'x', workspaceId: 'w1', itemId: 'a', kind: 'peer', source: '', title: '', body: '', createdAt: 1 } as Pin;
  expect(pinSourceLabel(pin)).toBe('메시지');
  expect(pinSourceLabel({ ...pin, source: '서버가 보냄' })).toBe('서버가 보냄');
});
