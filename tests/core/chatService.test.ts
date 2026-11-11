import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatService } from '@core/chat/chatService';
import { openDatabase } from '@core/db';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';
import type { AgentKind } from '@shared/types';
import { tempDir } from '../helpers/repo';

let root: string;
let file: string;
let chat: ChatService;
let workspaces: WorkspaceStore;
let wsId: string;
let n = 0;
const interrupted: string[] = [];
const changes: string[] = [];

const line = (o: object, at = Date.now()): string => `${JSON.stringify({ uuid: `u${n++}`, timestamp: new Date(at).toISOString(), ...o })}\n`;
const userLine = (text: string): string => line({ type: 'user', message: { content: text } });
const textLine = (text: string): string => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolLine = (id: string, command: string): string => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const resultLine = (id: string, output: string): string => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
const kinds = (id = wsId): string[] => chat.snapshot(id).items.map((i) => i.kind);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function addWorkspace(agentKind: AgentKind = 'claude'): string {
  const db = openDatabase(':memory:');
  const p = new ProjectStore(db).create('p');
  const r = new RepoStore(db).add(p.id, '/tmp/r');
  workspaces = new WorkspaceStore(db);
  return workspaces.insert({
    id: crypto.randomUUID(), projectId: p.id, repoId: r.id, name: 'w', nameLocked: true, branch: 'b', baseBranch: 'main',
    worktreePath: '/tmp/w', agentKind, permissionMode: 'ask', token: 't',
  }).id;
}

function setup(agentKind: AgentKind = 'claude', pollMs = 50): void {
  root = join(tempDir(), 'claude home');
  mkdirSync(join(root, 'projects', 'p'), { recursive: true });
  file = join(root, 'projects', 'p', 'session-1.jsonl');
  wsId = addWorkspace(agentKind);
  chat = new ChatService({ workspaces, allowedRoot: root, pollMs, onInterrupted: (id) => interrupted.push(id) });
  chat.on('changed', (id: string) => changes.push(id));
}

beforeEach(() => { interrupted.length = 0; changes.length = 0; setup(); });
afterEach(() => chat.dispose());

test('hook 의 transcript_path 로 파일을 읽어 항목을 만든다', () => {
  writeFileSync(file, userLine('해줘') + toolLine('t1', 'ls') + resultLine('t1', 'a.txt') + textLine('했습니다'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  const snap = chat.snapshot(wsId);
  expect(snap).toMatchObject({ available: true, reason: null, hidden: 0 });
  expect(kinds()).toEqual(['user', 'steps', 'assistant']);
  expect(changes).toEqual([wsId]);
});

test('snapshot 의 단계에는 원문이 없고 step 으로 따로 가져온다', () => {
  writeFileSync(file, toolLine('t1', 'ls -la') + resultLine('t1', 'a.txt'));
  chat.noteHook(wsId, 'PostToolUse', { transcript_path: file });
  const item = chat.snapshot(wsId).items[0]!;
  expect(item.kind === 'steps' && item.steps[0]).toMatchObject({ id: 't1', summary: 'ls -la', status: 'done', input: '', output: null });
  expect(chat.step(wsId, 't1')).toEqual({ input: 'ls -la', output: 'a.txt' });
  expect(chat.step(wsId, 'nope')).toBeNull();
});

test('파일에 줄이 더해지면 다음 hook 에서 새 줄만 읽는다', () => {
  writeFileSync(file, userLine('하나'));
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  appendFileSync(file, textLine('둘'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  expect(kinds()).toEqual(['user', 'assistant']);
});

test('줄바꿈으로 끝나지 않은 마지막 줄은 다음에 읽는다', () => {
  const second = textLine('둘째 답');
  writeFileSync(file, userLine('하나') + second.slice(0, 30));
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  expect(kinds()).toEqual(['user']);
  appendFileSync(file, second.slice(30));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  expect(kinds()).toEqual(['user', 'assistant']);
  expect(chat.snapshot(wsId).items[1]).toMatchObject({ text: '둘째 답' });
});

test('여러 바이트 글자가 읽는 덩어리의 경계에 걸려도 깨지지 않는다', () => {
  const big = '가'.repeat(600_000); // 1.8MB: 읽는 덩어리(1MB)를 넘는다
  writeFileSync(file, textLine(big) + textLine('끝'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  const items = chat.snapshot(wsId).items;
  expect(items.length).toBe(2);
  expect(items[0]!.kind === 'assistant' && items[0]!.text === big).toBe(true);
});

test('모르는 줄과 깨진 줄이 섞여 있어도 나머지를 읽는다', () => {
  writeFileSync(file, `not json\n${line({ type: 'brand-new' })}{"type":"user","mess\n${userLine('살아남음')}`);
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  expect(kinds()).toEqual(['user']);
  expect(chat.snapshot(wsId).available).toBe(true);
});

test('허용 뿌리 밖의 경로와 .jsonl 이 아닌 경로는 읽지 않는다', () => {
  const outside = join(tempDir(), 'secret.jsonl');
  writeFileSync(outside, userLine('비밀'));
  chat.noteHook(wsId, 'Stop', { transcript_path: outside });
  expect(kinds()).toEqual([]);
  const notJsonl = join(root, 'projects', 'p', 'notes.txt');
  writeFileSync(notJsonl, userLine('비밀'));
  chat.noteHook(wsId, 'Stop', { transcript_path: notJsonl });
  expect(kinds()).toEqual([]);
  chat.noteHook(wsId, 'Stop', { transcript_path: join(root, 'projects', '..', '..', 'x.jsonl') });
  chat.noteHook(wsId, 'Stop', { transcript_path: 42 });
  chat.noteHook(wsId, 'Stop', null);
  expect(kinds()).toEqual([]);
});

test('허용 뿌리 안의 링크가 밖을 가리키면 읽지 않는다', () => {
  const outside = join(tempDir(), 'secret.jsonl');
  writeFileSync(outside, userLine('비밀'));
  const link = join(root, 'projects', 'p', 'link.jsonl');
  symlinkSync(outside, link);
  chat.noteHook(wsId, 'Stop', { transcript_path: link });
  expect(chat.snapshot(wsId)).toMatchObject({ available: false, items: [] });
});

test('기록 경로가 바뀌면 지난 항목이 사라진다', () => {
  writeFileSync(file, userLine('지난 대화'));
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  const next = join(root, 'projects', 'p', 'session-2.jsonl');
  writeFileSync(next, userLine('새 대화'));
  chat.noteHook(wsId, 'SessionStart', { transcript_path: next, source: 'clear' });
  expect(chat.snapshot(wsId).items).toEqual([expect.objectContaining({ kind: 'user', text: '새 대화' })]);
});

test('새 대화의 파일이 아직 없어도 오류가 아니고 지난 항목은 사라진다', () => {
  writeFileSync(file, userLine('지난 대화'));
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  chat.noteHook(wsId, 'SessionStart', { transcript_path: join(root, 'projects', 'p', 'not-yet.jsonl'), source: 'startup' });
  expect(chat.snapshot(wsId)).toMatchObject({ available: true, items: [] });
});

test('파일이 줄어들면 처음부터 다시 읽는다', () => {
  writeFileSync(file, userLine('하나') + textLine('둘'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  writeFileSync(file, userLine('새로 씀'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  expect(chat.snapshot(wsId).items).toEqual([expect.objectContaining({ text: '새로 씀' })]);
});

test('작업 중에는 hook 없이도 주기적으로 새 줄을 읽고, 쉬는 중에는 읽지 않는다', async () => {
  writeFileSync(file, userLine('해줘'));
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  appendFileSync(file, textLine('하는 중입니다'));
  await wait(200);
  expect(kinds()).toEqual(['user', 'assistant']);
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  await wait(1700); // Stop 뒤에 뒤따라 읽는 것(0.4초, 1.5초)이 끝나길 기다린다
  appendFileSync(file, textLine('뒤늦은 줄'));
  await wait(200);
  expect(kinds()).toEqual(['user', 'assistant']);
});

test('hook 직후에 늦게 쓰인 줄도 뒤따라 읽는다', async () => {
  writeFileSync(file, userLine('해줘'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  appendFileSync(file, textLine('Stop 직후에 기록된 답'));
  await wait(600);
  expect(kinds()).toEqual(['user', 'assistant']);
});

test('workingSince: UserPromptSubmit 에 시작, Stop 에 끝, 막힌 Stop 은 계속', () => {
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  const since = chat.snapshot(wsId).workingSince;
  expect(since).toBeGreaterThan(Date.now() - 1000);
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file }); // 작업 중에 한마디 더
  expect(chat.snapshot(wsId).workingSince).toBe(since);
  chat.noteHook(wsId, 'Stop', { transcript_path: file }, true);
  expect(chat.snapshot(wsId).workingSince).toBe(since);
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  expect(chat.snapshot(wsId).workingSince).toBeNull();
});

test('pendingPermission: PreToolUse 뒤 승인 알림이 오면 채워지고 PostToolUse 에 비워진다', () => {
  chat.noteHook(wsId, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } });
  expect(chat.snapshot(wsId).pendingPermission).toBeNull();
  chat.noteHook(wsId, 'Notification', { notification_type: 'idle_prompt' });
  expect(chat.snapshot(wsId).pendingPermission).toBeNull();
  chat.noteHook(wsId, 'Notification', { notification_type: 'permission_prompt' });
  expect(chat.snapshot(wsId).pendingPermission).toEqual({ tool: 'Bash', summary: 'curl https://example.com', input: 'curl https://example.com', canAnswer: true });
  expect(chat.hasPendingPermission(wsId)).toBe(true);
  chat.noteHook(wsId, 'PostToolUse', {});
  expect(chat.snapshot(wsId).pendingPermission).toBeNull();
});

test('pendingPermission: 무엇을 묻는지 모르거나 예/아니오 창이 아니면 답할 수 없다', () => {
  chat.noteHook(wsId, 'Notification', { notification_type: 'permission_prompt' });
  expect(chat.snapshot(wsId).pendingPermission).toMatchObject({ canAnswer: false });
  chat.noteHook(wsId, 'PreToolUse', { tool_name: 'ExitPlanMode', tool_input: {} });
  chat.noteHook(wsId, 'Notification', { notification_type: 'permission_prompt' });
  expect(chat.snapshot(wsId).pendingPermission).toMatchObject({ tool: 'ExitPlanMode', canAnswer: false });
  expect(chat.hasPendingPermission(wsId)).toBe(false);
});

test('pendingPermission: 터미널 입력이 있으면 답할 수 없게 되고, 답한 뒤에는 비워진다', () => {
  chat.noteHook(wsId, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  chat.noteHook(wsId, 'Notification', { notification_type: 'permission_prompt' });
  chat.noteTerminalInput(wsId);
  expect(chat.hasPendingPermission(wsId)).toBe(false);
  expect(chat.snapshot(wsId).pendingPermission).toMatchObject({ canAnswer: false });
  chat.permissionAnswered(wsId);
  expect(chat.snapshot(wsId).pendingPermission).toBeNull();
});

test('기록의 끝이 중단이면 알리고 작업 시간과 승인 대기를 지운다', () => {
  writeFileSync(file, toolLine('t1', 'curl x'));
  chat.noteHook(wsId, 'PreToolUse', { transcript_path: file, tool_name: 'Bash', tool_input: { command: 'curl x' } });
  chat.noteHook(wsId, 'Notification', { transcript_path: file, notification_type: 'permission_prompt' });
  appendFileSync(file, line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }, Date.now() + 10));
  chat.noteHook(wsId, 'Notification', { transcript_path: file, notification_type: 'idle_prompt' });
  expect(interrupted).toEqual([wsId]);
  expect(chat.snapshot(wsId)).toMatchObject({ workingSince: null, pendingPermission: null });
});

test('지난 중단 기록 뒤에 일한다는 신호가 있었으면 알리지 않는다', () => {
  writeFileSync(file, line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, Date.now() - 60_000));
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  expect(interrupted).toEqual([]);
  expect(chat.snapshot(wsId).workingSince).not.toBeNull();
});

test('에이전트가 끝나면 작업 시간이 지워지고 하는 중이던 단계가 끝난다. 지난 대화는 남는다', () => {
  writeFileSync(file, userLine('해줘') + toolLine('t1', 'sleep 100'));
  chat.noteHook(wsId, 'PreToolUse', { transcript_path: file, tool_name: 'Bash', tool_input: {} });
  chat.agentExited(wsId);
  const snap = chat.snapshot(wsId);
  expect(snap.workingSince).toBeNull();
  expect(kinds()).toEqual(['user', 'steps']);
  expect(snap.items[1]!.kind === 'steps' && snap.items[1]!.steps[0]!.status).toBe('denied');
});

test('Codex 워크스페이스는 available false 와 이유이고 hook 을 무시한다', () => {
  chat.dispose();
  setup('codex');
  writeFileSync(file, userLine('해줘'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  expect(chat.snapshot(wsId)).toMatchObject({ available: false, reason: 'Codex 는 아직 채팅 보기를 지원하지 않습니다. 터미널 보기를 쓰세요.', items: [] });
});

test('hook 을 받은 적 없는 워크스페이스는 비어 있고 쓸 수 있다', () => {
  expect(chat.snapshot(wsId)).toEqual({ available: true, reason: null, items: [], hidden: 0, workingSince: null, pendingPermission: null });
  expect(chat.snapshot('없는-id')).toMatchObject({ available: false });
});

test('읽던 파일이 사라지면 던지지 않고 available false', () => {
  writeFileSync(file, userLine('해줘'));
  chat.noteHook(wsId, 'UserPromptSubmit', { transcript_path: file });
  rmSync(file);
  expect(() => chat.noteHook(wsId, 'Stop', { transcript_path: file })).not.toThrow();
  expect(chat.snapshot(wsId)).toMatchObject({ available: false, reason: '대화 기록을 읽을 수 없습니다. 터미널 보기를 쓰세요.' });
});

test('항목이 400개를 넘으면 뒤쪽 400개만 보내고 숨긴 수를 알린다', () => {
  writeFileSync(file, Array.from({ length: 450 }, (_, i) => userLine(`m${i}`)).join(''));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  const snap = chat.snapshot(wsId);
  expect(snap.items.length).toBe(400);
  expect(snap.hidden).toBe(50);
  expect(snap.items.at(-1)).toMatchObject({ text: 'm449' });
});

test('changed 이벤트는 무언가 바뀔 때만 난다', () => {
  writeFileSync(file, userLine('해줘'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  expect(changes.length).toBe(1);
});

test('forget 뒤에는 비어 있고, dispose 뒤의 hook 은 무시된다', () => {
  writeFileSync(file, userLine('해줘'));
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  chat.forget(wsId);
  expect(kinds()).toEqual([]);
  chat.dispose();
  chat.noteHook(wsId, 'Stop', { transcript_path: file });
  expect(kinds()).toEqual([]);
});
