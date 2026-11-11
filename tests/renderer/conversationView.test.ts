import { deliveryLabel, senderName, threadNotice, threadsFor } from '../../src/renderer/conversationView';
import type { Message, ProjectFlow, Thread, Workspace } from '@shared/types';

const ws = (id: string, name: string): Workspace => ({
  id, projectId: 'p', repoId: 'r', name, nameLocked: false, summary: '', branch: 'b', baseBranch: 'main',
  worktreePath: '/w', agentKind: 'claude', permissionMode: 'ask', status: 'stopped', createdAt: 0,
});
const msg = (id: string, threadId: string, from: Message['from'], to: string): Message => ({
  id, threadId, projectId: 'p', from, toWorkspaceId: to, body: id, artifactIds: [], createdAt: 0, deliveredAt: null,
});
const thread = (id: string, updatedAt: number, over: Partial<Thread> = {}): Thread => ({
  id, projectId: 'p', title: id, paused: false, capped: false, agentStreak: 0, createdAt: 0, updatedAt, ...over,
});
const flow = (over: Partial<ProjectFlow> = {}): ProjectFlow => ({ paused: false, capped: false, agentStreak: 0, ...over });

test('senderName: 워크스페이스, 사용자, 지워진 워크스페이스', () => {
  const all = [ws('A', '프론트')];
  expect(senderName(msg('m', 't', { kind: 'workspace', workspaceId: 'A' }, 'B'), all)).toBe('프론트');
  expect(senderName(msg('m', 't', { kind: 'user' }, 'B'), all)).toBe('사용자');
  expect(senderName(msg('m', 't', { kind: 'workspace', workspaceId: 'gone' }, 'B'), all)).toBe('지워진 워크스페이스');
});

test('threadsFor: 그 워크스페이스가 보내거나 받은 스레드만, 최근 순', () => {
  const threads = [thread('t1', 10), thread('t2', 30), thread('t3', 20)];
  const messages = {
    t1: [msg('a', 't1', { kind: 'workspace', workspaceId: 'A' }, 'B')],
    t2: [msg('b', 't2', { kind: 'workspace', workspaceId: 'B' }, 'C')],
    t3: [msg('c', 't3', { kind: 'user' }, 'A')],
  };
  expect(threadsFor(threads, messages, 'A').map((t) => t.id)).toEqual(['t3', 't1']);
  expect(threadsFor(threads, messages, 'C').map((t) => t.id)).toEqual(['t2']);
  expect(threadsFor(threads, {}, 'A')).toEqual([]);
});

test('deliveryLabel: 여섯 상태의 문구', () => {
  expect(deliveryLabel('next-hook')).toBe('다음 단계에 전달');
  expect(deliveryLabel('waking')).toBe('깨우는 중');
  expect(deliveryLabel('starting')).toBe('에이전트를 띄우는 중');
  expect(deliveryLabel('waiting-unknown')).toBe('터미널 확인 필요: 에이전트가 무언가를 묻고 있을 수 있습니다');
  expect(deliveryLabel('waiting-codex')).toBe('Codex 가 읽을 때까지 대기');
  expect(deliveryLabel('held')).toBe('멈춰 있음');
  expect(deliveryLabel('none')).toBe('');
});

test('threadNotice: 프로젝트 상한, 스레드 상한, 프로젝트 멈춤, 스레드 멈춤, 해당 없음 순으로 고른다', () => {
  expect(threadNotice(thread('t', 0, { capped: true }), flow({ capped: true })))
    .toBe('이 프로젝트에서 에이전트끼리 50번 주고받아 멈췄습니다. 내용을 확인하고 계속할지 정하세요.');
  expect(threadNotice(thread('t', 0, { capped: true }), flow()))
    .toBe('에이전트끼리 10번 주고받아 멈췄습니다. 내용을 확인하고 계속할지 정하세요.');
  expect(threadNotice(thread('t', 0, { paused: true }), flow({ paused: true }))).toBe('프로젝트 전체가 멈춰 있습니다.');
  expect(threadNotice(thread('t', 0, { paused: true }), flow())).toBe('이 대화는 멈춰 있습니다. 새 메시지는 재개할 때까지 전달되지 않습니다.');
  expect(threadNotice(thread('t', 0), flow())).toBeNull();
});
