import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { THREAD_CAP } from '@core/messages';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

const SIZE = { cols: 100, rows: 30 };
let core: Core;
let dataDir: string;
let fakeBin: string;
let projectId: string;
let front: Workspace;
let back: Workspace;

function until(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : setTimeout(tick, 20));
    tick();
  });
}

// 입력을 그대로 출력하는 가짜 에이전트. 받은 인자도 먼저 출력한다.
function installEcho(name: string): void {
  writeFileSync(join(fakeBin, name), '#!/bin/sh\necho "ARGS:$*"\nexec cat\n');
  chmodSync(join(fakeBin, name), 0o755);
}

function runHook(ws: Workspace, event: string, body = '{}'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(join(dataDir, 'workspaces', ws.id, 'hook.sh'), [event], { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin?.end(body);
  });
}

const agentBuffer = (ws: Workspace): string => {
  const t = core.pty.list(ws.id).find((x) => x.kind === 'agent');
  return t ? core.pty.buffer(t.id) : '';
};
const send = (from: Workspace, to: Workspace, body: string, threadId?: string) =>
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: from.id }, toWorkspaceId: to.id, body, threadId });
const settle = () => new Promise((r) => setTimeout(r, 700)); // 자동 kick 과 400ms 지연을 기다린다

beforeEach(async () => {
  dataDir = join(tempDir(), 'dure data');
  fakeBin = join(tempDir(), 'fake bin');
  mkdirSync(fakeBin);
  installEcho('claude');
  installEcho('codex');
  core = await createCore({ dataDir, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir() } });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  const mk = (name: string, agentKind: 'claude' | 'codex' = 'claude') => core.service.create({ projectId, repoId: repo.id, name, baseBranch: 'main', agentKind });
  front = await mk('프론트');
  back = await mk('백엔드');
});
afterEach(async () => { await core.dispose(); });

test('작업 중인 받는 쪽: state 는 next-hook 이고 터미널에 아무것도 쓰지 않는다. 다음 hook 에 실린다', async () => {
  await core.service.startAgent(back.id, SIZE);
  await runHook(back, 'PreToolUse');
  send(front, back, 'API 형식 정해줘');
  await settle();
  expect(core.delivery.state(back.id)).toBe('next-hook');
  expect(agentBuffer(back)).not.toContain('이(가) 보낸 메시지다'); // 실행 지침에도 비슷한 글이 있어 전달문 고유의 문구로 본다
  const out = JSON.parse(await runHook(back, 'PostToolUse'));
  expect(out.hookSpecificOutput.additionalContext).toContain('워크스페이스 "프론트" 이(가) 보낸 메시지다');
  expect(out.hookSpecificOutput.additionalContext).toContain('> API 형식 정해줘');
  expect(core.delivery.state(back.id)).toBe('none');
  expect(await runHook(back, 'PostToolUse')).toBe(''); // 두 번 전달되지 않는다
});

test('쉬는 중이 확인된 받는 쪽: 메시지가 오면 스스로 터미널에 써 넣어 깨운다', async () => {
  await core.service.startAgent(back.id, SIZE);
  await runHook(back, 'Stop');
  const m = send(front, back, 'API 형식 정해줘');
  await until(() => agentBuffer(back).includes('> API 형식 정해줘'));
  expect(agentBuffer(back)).toContain('[두레] 워크스페이스 "프론트" 이(가) 보낸 메시지다');
  expect(core.messages.messages(m.threadId)[0].deliveredAt).not.toBeNull();
  expect(core.workspaces.get(back.id)?.status).toBe('working');
});

test('막 띄운 받는 쪽(쉬는 중 미확인): waiting-unknown 이고 터미널에 아무것도 쓰지 않는다', async () => {
  await core.service.startAgent(back.id, SIZE); // 폴더 신뢰 창이 떠 있을 수 있는 상태
  const m = send(front, back, 'API 형식 정해줘');
  await settle();
  expect(core.delivery.state(back.id)).toBe('waiting-unknown');
  expect(agentBuffer(back)).not.toContain('이(가) 보낸 메시지다'); // 실행 지침에도 비슷한 글이 있어 전달문 고유의 문구로 본다
  expect(core.messages.messages(m.threadId)[0].deliveredAt).toBeNull();
});

test('승인 대기 중인 받는 쪽: waiting-unknown 이고 쓰지 않는다', async () => {
  await core.service.startAgent(back.id, SIZE);
  await runHook(back, 'PreToolUse');
  await runHook(back, 'Notification', JSON.stringify({ notification_type: 'permission_prompt' }));
  send(front, back, 'x');
  await settle();
  expect(core.delivery.state(back.id)).toBe('waiting-unknown');
  expect(agentBuffer(back)).not.toContain('이(가) 보낸 메시지다'); // 실행 지침에도 비슷한 글이 있어 전달문 고유의 문구로 본다
});

test('꺼진 받는 쪽: 메시지를 첫 프롬프트로 에이전트를 띄운다', async () => {
  const m = send(front, back, 'API 형식 정해줘');
  await until(() => agentBuffer(back).includes('ARGS:'));
  const args = agentBuffer(back);
  expect(args).toContain('[두레] 워크스페이스 "프론트" 이(가) 보낸 메시지다');
  expect(args).toContain('> API 형식 정해줘');
  expect(core.messages.messages(m.threadId)[0].deliveredAt).not.toBeNull();
  expect(core.workspaces.get(back.id)?.status).toBe('starting');
  // 막 띄운 것은 쉬는 중으로 확인된 것이 아니다: 다음 메시지는 써 넣지 않고 기다린다
  send(front, back, '둘째', m.threadId);
  await settle();
  expect(core.delivery.state(back.id)).toBe('waiting-unknown');
});

test('Codex 가 실행 중이면 waiting-codex 이고 쓰지 않는다', async () => {
  const repo = core.repos.list(projectId)[0];
  const cx = await core.service.create({ projectId, repoId: repo.id, name: '코덱스', baseBranch: 'main', agentKind: 'codex' });
  await core.service.startAgent(cx.id, SIZE);
  send(front, cx, 'x');
  await settle();
  expect(core.delivery.state(cx.id)).toBe('waiting-codex');
  expect(agentBuffer(cx)).not.toContain('이(가) 보낸 메시지다'); // 실행 지침에도 비슷한 글이 있어 전달문 고유의 문구로 본다
});

test('멈춘 스레드의 메시지만 있으면 held 이고, 재개하면 전달된다', async () => {
  await core.service.startAgent(back.id, SIZE);
  await runHook(back, 'Stop');
  const first = send(front, back, '첫째');
  await until(() => agentBuffer(back).includes('> 첫째'));
  await runHook(back, 'Stop'); // 다시 쉬는 중으로 확인
  core.messages.pauseThread(first.threadId, true);
  send(front, back, '둘째', first.threadId);
  await settle();
  expect(core.delivery.state(back.id)).toBe('held');
  expect(agentBuffer(back)).not.toContain('> 둘째');
  core.messages.pauseThread(first.threadId, false);
  await until(() => agentBuffer(back).includes('> 둘째'));
});

test('collect 는 TODO 변경과 메시지를 한 글로 묶고 두 번째 호출은 undefined', async () => {
  await core.service.startAgent(back.id, SIZE);
  await runHook(back, 'PreToolUse');
  core.todos.add({ projectId, workspaceId: back.id, title: '배포' }, 'user');
  send(front, back, '안녕');
  const text = core.delivery.collect(back.id)!;
  expect(text).toContain('[두레] 사용자가 TODO를 바꿨다');
  expect(text).toContain('추가됨: "배포"');
  expect(text).toContain('> 안녕');
  expect(text.indexOf('사용자가 TODO를 바꿨다')).toBeLessThan(text.indexOf('보낸 메시지다'));
  expect(core.delivery.collect(back.id)).toBeUndefined();
  expect(core.todos.pendingCount(back.id)).toBe(0);
});

test('깨우는 도중 에이전트가 종료되면 메시지가 다시 미전달이 된다', async () => {
  const t = await core.service.startAgent(back.id, SIZE);
  await runHook(back, 'Stop');
  const m = send(front, back, '사라지면 안 되는 말');
  core.pty.kill(t.id);
  await until(() => core.pty.list(back.id).length === 0);
  await settle();
  expect(core.messages.messages(m.threadId)[0].deliveredAt).toBeNull();
});

test('상한에 걸린 뒤 사용자가 개입하면 붙잡힌 메시지가 전달된다', async () => {
  await core.service.startAgent(back.id, SIZE);
  await runHook(back, 'PreToolUse'); // 작업 중으로 두어 hook 으로만 전달되게 한다
  const first = send(front, back, '1');
  for (let i = 2; i <= THREAD_CAP + 1; i++) send(front, back, String(i), first.threadId);
  expect(core.delivery.state(back.id)).toBe('held');
  expect(await runHook(back, 'PostToolUse')).toBe('');
  core.messages.userIntervened(projectId);
  const out = JSON.parse(await runHook(back, 'PostToolUse'));
  expect(out.hookSpecificOutput.additionalContext).toContain(`> ${THREAD_CAP + 1}`);
});

test('사용자가 터미널에 직접 입력하면 개입으로 치고, 두레가 넣은 글은 개입이 아니다', async () => {
  await core.service.startAgent(front.id, SIZE);
  send(back, front, 'x');
  expect(core.messages.flow(projectId).agentStreak).toBe(1);
  await runHook(front, 'UserPromptSubmit', JSON.stringify({ prompt: '[두레] 워크스페이스 "백엔드" 이(가) 보낸 메시지다.' }));
  expect(core.messages.flow(projectId).agentStreak).toBe(1);
  await runHook(front, 'UserPromptSubmit', JSON.stringify({ prompt: '로그인 화면 고쳐줘' }));
  expect(core.messages.flow(projectId).agentStreak).toBe(0);
});

test('받는 워크스페이스를 지우면 미전달 메시지가 정리되고 보낸 쪽 기록은 남는다', async () => {
  await core.service.startAgent(back.id, SIZE); // waiting-unknown 으로 붙잡히게
  const m = send(front, back, '곧 지워질 곳으로');
  await core.service.remove(back.id, { deleteWorktree: true });
  expect(core.messages.messages(m.threadId)).toEqual([]);
  expect(core.delivery.state(back.id)).toBe('none');
});
