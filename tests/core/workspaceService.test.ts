import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { AgentNotInstalledError, WorktreeMissingError } from '@core/workspaceService';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

const SIZE = { cols: 100, rows: 30 };
let core: Core;
let dataDir: string;
let worktreeRoot: string;
let fakeBin: string;
let repoPath: string;
let projectId: string;
let repoId: string;
let claudeDir: string;

function until(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : setTimeout(tick, 20));
    tick();
  });
}

// 가짜 에이전트: 작업 폴더와 받은 인자를 출력하고 살아 있는다.
function installFakeAgent(name: string): void {
  writeFileSync(join(fakeBin, name), '#!/bin/sh\necho "CWD:$(pwd)"\necho "ARGS:$*"\necho "TOKEN_ENV:${DURE_MCP_TOKEN:-none}"\nexec sleep 1000\n');
  chmodSync(join(fakeBin, name), 0o755);
}

async function boot(path = `${fakeBin}:/usr/bin:/bin`): Promise<void> {
  core = await createCore({ dataDir, worktreeRoot, baseEnv: { PATH: path, SHELL: '/bin/sh', HOME: tempDir() }, claudeDir });
}

beforeEach(async () => {
  dataDir = join(tempDir(), 'dure data');
  worktreeRoot = join(tempDir(), 'work trees');
  fakeBin = join(tempDir(), 'fake bin');
  claudeDir = join(tempDir(), 'claude home');
  mkdirSync(claudeDir);
  mkdirSync(fakeBin);
  installFakeAgent('claude');
  installFakeAgent('codex');
  repoPath = makeRepo('쇼핑 프론트');
  await boot();
  projectId = core.projects.create('쇼핑몰').id;
  repoId = (await core.addRepo(projectId, repoPath)).id;
});

afterEach(async () => { await core.dispose(); });

const create = (over = {}) => core.service.create({ projectId, repoId, baseBranch: 'main', agentKind: 'claude', ...over });

test('create 는 worktree 와 브랜치 dure/<slug> 를 만들고 status 는 stopped', async () => {
  const ws = await create({ name: '로그인 화면' });
  expect(ws).toMatchObject({ name: '로그인 화면', branch: 'dure/로그인-화면', baseBranch: 'main', status: 'stopped', permissionMode: 'ask', agentKind: 'claude' });
  expect(ws.worktreePath).toBe(join(worktreeRoot, '쇼핑몰', '로그인-화면'));
  expect(existsSync(join(ws.worktreePath, 'README.md'))).toBe(true);
  expect(gitOut(ws.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dure/로그인-화면');
  expect(core.workspaces.list(projectId).map((w) => w.id)).toEqual([ws.id]);
});

test('이름을 주면 nameLocked true, 안 주면 false 이고 "<저장소>-1"', async () => {
  expect((await create({ name: '내 이름' })).nameLocked).toBe(true);
  const auto = await create();
  expect(auto).toMatchObject({ name: '쇼핑 프론트-2', nameLocked: false });
});

test('첫 워크스페이스의 자동 이름은 "<저장소>-1"', async () => {
  expect((await create()).name).toBe('쇼핑 프론트-1');
});

test('같은 이름으로 두 번 만들면 두 번째 브랜치는 -2 가 붙는다', async () => {
  const a = await create({ name: '같은 이름' });
  const b = await create({ name: '같은 이름' });
  expect(a.branch).toBe('dure/같은-이름');
  expect(b.branch).toBe('dure/같은-이름-2');
  expect(b.worktreePath).not.toBe(a.worktreePath);
});

test('없는 기준 브랜치면 실패하고 워크스페이스 목록이 비어 있다', async () => {
  await expect(create({ name: 'x', baseBranch: 'no-such' })).rejects.toThrow();
  expect(core.workspaces.list(projectId)).toEqual([]);
  expect(existsSync(join(worktreeRoot, '쇼핑몰', 'x'))).toBe(false);
});

test('체크아웃 도중 실패하면 방금 만든 브랜치도 남지 않는다', async () => {
  // 필수 필터가 실패하는 저장소: git 은 브랜치를 만든 뒤 체크아웃에서 실패한다
  const broken = makeRepo('필터 실패 repo');
  writeFileSync(join(broken, '.gitattributes'), '*.dat filter=boom\n');
  writeFileSync(join(broken, 'a.dat'), 'data');
  gitOut(broken, 'add', '-A');
  gitOut(broken, 'commit', '-q', '-m', 'add filtered file');
  gitOut(broken, 'config', 'filter.boom.smudge', 'false');
  gitOut(broken, 'config', 'filter.boom.required', 'true');
  const repo = await core.addRepo(projectId, broken);
  await expect(core.service.create({ projectId, repoId: repo.id, name: 'half', baseBranch: 'main', agentKind: 'claude' })).rejects.toThrow();
  expect(gitOut(broken, 'branch', '--list', 'dure/*')).toBe('');
  expect(core.workspaces.list(projectId)).toEqual([]);
  expect(gitOut(broken, 'worktree', 'list').split('\n')).toHaveLength(1);
});

test('에이전트가 뜨자마자 죽어도 출력과 종료 코드가 남는다', async () => {
  writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\necho "usage: bad flag"\nexit 2\n');
  const ws = await create({ name: 'dies' });
  const t = await core.service.startAgent(ws.id, SIZE);
  await until(() => core.workspaces.get(ws.id)?.status === 'stopped');
  const listed = core.pty.listWithExited(ws.id);
  expect(listed).toEqual([{ ...t, exitCode: 2 }]);
  expect(core.pty.snapshot(t.id).data).toContain('usage: bad flag');
  // 다시 시작하면 지난 에이전트 탭 기록은 치운다
  installFakeAgent('claude');
  const again = await core.service.startAgent(ws.id, SIZE);
  expect(core.pty.listWithExited(ws.id).map((x) => x.id)).toEqual([again.id]);
});

test('create 뒤 저장소 작업 트리에 변경이 없다', async () => {
  const ws = await create({ name: 'clean' });
  expect(gitOut(repoPath, 'status', '--porcelain')).toBe('');
  expect(gitOut(ws.worktreePath, 'status', '--porcelain')).toBe('');
});

test('worktree 폴더가 지워졌으면 startAgent 는 WorktreeMissingError', async () => {
  const ws = await create({ name: 'gone' });
  rmSync(ws.worktreePath, { recursive: true, force: true });
  const err = await core.service.startAgent(ws.id, SIZE).catch((e) => e);
  expect(err).toBeInstanceOf(WorktreeMissingError);
  expect((err as WorktreeMissingError).worktreePath).toBe(ws.worktreePath);
  expect(core.workspaces.get(ws.id)?.status).toBe('stopped');
});

test('PATH 에 에이전트가 없으면 AgentNotInstalledError 이고 kind 가 맞다', async () => {
  await core.dispose();
  await boot('/usr/bin:/bin');
  const ws = await core.service.create({ projectId, repoId, name: 'nocli', baseBranch: 'main', agentKind: 'codex' });
  const err = await core.service.startAgent(ws.id, SIZE).catch((e) => e);
  expect(err).toBeInstanceOf(AgentNotInstalledError);
  expect((err as AgentNotInstalledError).kind).toBe('codex');
  expect(core.pty.list(ws.id)).toEqual([]);
});

test('startAgent 는 두 번 불러도 같은 터미널을 돌려준다', async () => {
  const ws = await create({ name: 'twice' });
  const a = await core.service.startAgent(ws.id, SIZE);
  const b = await core.service.startAgent(ws.id, SIZE);
  expect(b.id).toBe(a.id);
  expect(a.kind).toBe('agent');
  expect(core.pty.list(ws.id)).toHaveLength(1);
});

test('startAgent 뒤 status idle, 에이전트 종료 뒤 stopped 이고 changed 가 난다', async () => {
  const ws = await create({ name: 'life' });
  const changed: string[] = [];
  core.service.on('changed', (id) => changed.push(id));
  const t = await core.service.startAgent(ws.id, SIZE);
  // 막 띄운 Claude Code 는 폴더 신뢰 창을 띄우고 있을 수 있다. 첫 hook 이 올 때까지는 '시작 중' 이다.
  expect(core.workspaces.get(ws.id)?.status).toBe('starting');
  expect(changed).toContain(ws.id);
  changed.length = 0;
  core.pty.kill(t.id);
  await until(() => core.workspaces.get(ws.id)?.status === 'stopped');
  expect(changed).toContain(ws.id);
});

test('가짜 claude 는 worktree 를 cwd 로, 두레 설정 파일이 쓰인 상태로 뜬다', async () => {
  const ws = await create({ name: 'wired' });
  const t = await core.service.startAgent(ws.id, SIZE);
  await until(() => core.pty.buffer(t.id).includes('TOKEN_ENV:'));
  const out = core.pty.buffer(t.id);
  const cfg = join(dataDir, 'workspaces', ws.id, 'mcp.json');
  expect(out).toContain(`CWD:${ws.worktreePath}`);
  expect(out).toContain(`--mcp-config ${cfg}`);
  expect(out).toContain('--permission-mode acceptEdits');
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  expect(parsed.mcpServers.dure.url).toBe(core.mcpUrl);
  expect(parsed.mcpServers.dure.headers.Authorization).toBe(`Bearer ${core.workspaces.getToken(ws.id)}`);
  expect(statSync(cfg).mode & 0o777).toBe(0o600);
  expect(gitOut(ws.worktreePath, 'status', '--porcelain')).toBe('');
});

test('가짜 codex 는 토큰을 환경변수로 받는다', async () => {
  const ws = await create({ name: 'cx', agentKind: 'codex', permissionMode: 'bypass' });
  const t = await core.service.startAgent(ws.id, SIZE);
  await until(() => core.pty.buffer(t.id).includes('TOKEN_ENV:'));
  const out = core.pty.buffer(t.id);
  expect(out).toContain(`TOKEN_ENV:${core.workspaces.getToken(ws.id)}`);
  expect(out).toContain('--dangerously-bypass-approvals-and-sandbox');
  const argsLine = out.split('\n').find((l) => l.startsWith('ARGS:'))!;
  expect(argsLine).not.toContain(core.workspaces.getToken(ws.id));
});

test('openShell 은 worktree 에서 셸을 띄운다', async () => {
  const ws = await create({ name: 'sh' });
  const t = await core.service.openShell(ws.id, SIZE);
  expect(t.kind).toBe('shell');
  core.pty.write(t.id, 'pwd\n');
  await until(() => core.pty.buffer(t.id).includes(ws.worktreePath));
  expect(core.workspaces.get(ws.id)?.status).toBe('stopped'); // 셸은 상태를 바꾸지 않는다
});

test('remove(deleteWorktree:true) 뒤 폴더·행·configDir·터미널이 없다', async () => {
  const ws = await create({ name: 'bye' });
  await core.service.startAgent(ws.id, SIZE);
  const cfgDir = join(dataDir, 'workspaces', ws.id);
  expect(existsSync(cfgDir)).toBe(true);
  await core.service.remove(ws.id, { deleteWorktree: true });
  expect(existsSync(ws.worktreePath)).toBe(false);
  expect(core.workspaces.get(ws.id)).toBeUndefined();
  expect(existsSync(cfgDir)).toBe(false);
  expect(core.pty.list(ws.id)).toEqual([]);
});

test('remove(deleteWorktree:false) 는 폴더를 남긴다', async () => {
  const ws = await create({ name: 'keep' });
  await core.service.remove(ws.id, { deleteWorktree: false });
  expect(existsSync(ws.worktreePath)).toBe(true);
  expect(core.workspaces.get(ws.id)).toBeUndefined();
});

test('createCore: addRepo 는 git 저장소가 아니면 오류', async () => {
  await expect(core.addRepo(projectId, tempDir())).rejects.toThrow('git 저장소가 아닙니다');
  expect(core.repos.list(projectId)).toHaveLength(1);
});

test('createCore: 다시 열면 데이터가 남고, 지난 실행의 상태는 stopped 로 되돌린다', async () => {
  const ws = await create({ name: 'persist' });
  await core.service.startAgent(ws.id, SIZE);
  core.workspaces.update(ws.id, { status: 'working' });
  // dispose 는 터미널을 끄지만, 비정상 종료를 흉내 내려고 상태를 다시 덮어쓴다
  await core.dispose();
  await boot();
  const again = core.workspaces.get(ws.id);
  expect(again?.name).toBe('persist');
  expect(again?.status).toBe('stopped');
});

test('createCore: dispose 뒤 MCP 포트가 닫힌다', async () => {
  const url = core.mcpUrl;
  await core.dispose();
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
  await boot(); // afterEach 의 dispose 용
});

test('repoStatus: 정상 저장소는 ok 와 현재 브랜치, 사라진 폴더와 git 아닌 폴더는 이유를 돌려준다', async () => {
  expect(await core.repoStatus(repoId)).toEqual({ ok: true, branch: 'main' });
  const gone = makeRepo('사라질 repo');
  const goneId = (await core.addRepo(projectId, gone)).id;
  rmSync(gone, { recursive: true, force: true });
  expect(await core.repoStatus(goneId)).toEqual({ ok: false, reason: '폴더를 찾을 수 없습니다.' });
  const plain = makeRepo('git 지울 repo');
  const plainId = (await core.addRepo(projectId, plain)).id;
  rmSync(join(plain, '.git'), { recursive: true, force: true });
  expect(await core.repoStatus(plainId)).toEqual({ ok: false, reason: 'git 저장소가 아닙니다.' });
});

test('워크스페이스를 지우면 서비스가 그 TODO 를 정리한다', async () => {
  const ws = await create({ name: 'todo-clean' });
  core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  expect(core.todos.pendingCount(ws.id)).toBe(1);
  await core.service.remove(ws.id, { deleteWorktree: true });
  expect(core.todos.listProject(projectId)).toEqual([]);
  expect(core.todos.pendingCount(ws.id)).toBe(0);
});

// hook 스크립트는 같은 프로세스의 서버를 부른다. 동기 실행은 서버를 멈추므로 비동기로 실행한다.
async function runHook(hook: string, event: string, body = '{}'): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = execFile(hook, [event], { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.end(body);
  });
}

test('hook.sh 를 직접 실행하면 코어가 상태를 바꾸고, 미전달 변경을 돌려준다', async () => {
  const ws = await create({ name: 'hooked' });
  await core.service.startAgent(ws.id, SIZE);
  const hook = join(dataDir, 'workspaces', ws.id, 'hook.sh');
  expect(statSync(hook).mode & 0o777).toBe(0o700);
  const changed: string[] = [];
  core.service.on('changed', (id) => changed.push(id));
  expect(await runHook(hook, 'PreToolUse')).toBe('');
  expect(core.workspaces.get(ws.id)?.status).toBe('working');
  expect(changed).toEqual([ws.id]); // 화면이 상태 변화를 알 수 있어야 한다
  core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  const out = JSON.parse(await runHook(hook, 'Stop'));
  expect(out.decision).toBe('block');
  expect(out.reason).toContain('추가됨: "A"');
  expect(await runHook(hook, 'Stop')).toBe('');
  expect(core.workspaces.get(ws.id)?.status).toBe('idle');
});

test('두레가 꺼진 뒤 hook.sh 를 실행해도 종료 코드 0 이고 출력이 없다', async () => {
  const ws = await create({ name: 'orphan-hook' });
  await core.service.startAgent(ws.id, SIZE);
  const hook = join(dataDir, 'workspaces', ws.id, 'hook.sh');
  await core.dispose();
  expect(await runHook(hook, 'Stop')).toBe('');
  await boot(); // afterEach 의 dispose 용
});

// 응답을 끝냈다는 hook 까지 받은, 쉬는 중이 확인된 에이전트를 만든다.
async function idleConfirmedAgent(name: string) {
  writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\nexec cat\n');
  chmodSync(join(fakeBin, 'claude'), 0o755);
  const ws = await create({ name });
  const terminal = await core.service.startAgent(ws.id, SIZE);
  await runHook(join(dataDir, 'workspaces', ws.id, 'hook.sh'), 'Stop');
  return { ws, terminal };
}

test('쉬는 중이 확인된 뒤 다른 hook 이 오면 다시 알릴 수 없다', async () => {
  const { ws } = await idleConfirmedAgent('nudge-reset');
  core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  expect(core.service.canNudge(ws.id)).toBe(true);
  await runHook(join(dataDir, 'workspaces', ws.id, 'hook.sh'), 'PreToolUse');
  core.todos.add({ projectId, workspaceId: ws.id, title: 'B' }, 'user');
  expect(core.service.canNudge(ws.id)).toBe(false);
});

test('알리는 도중 에이전트가 종료되면 변경을 되돌려 놓고 오류를 낸다', async () => {
  const { ws, terminal } = await idleConfirmedAgent('nudge-dies');
  core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  const sending = core.service.nudge(ws.id);
  core.pty.kill(terminal.id);
  await expect(sending).rejects.toThrow('에이전트가 종료되어 전달하지 못했습니다.');
  expect(core.todos.takePending(ws.id)).toEqual(['추가됨: "A"']);
});

test('토큰이 틀려 401 을 받아도 hook.sh 는 출력이 없다', async () => {
  const ws = await create({ name: 'hook-401' });
  await core.service.startAgent(ws.id, SIZE);
  const dir = join(dataDir, 'workspaces', ws.id);
  // 인증이 통과하면 block 응답이 나올 상황을 만든 뒤, 토큰을 틀리게 바꾼다
  core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  writeFileSync(join(dir, 'auth.hdr'), 'Authorization: Bearer wrong-token');
  expect(await runHook(join(dir, 'hook.sh'), 'Stop')).toBe('');
  expect(core.todos.pendingCount(ws.id)).toBe(1);
});

test('토큰은 hook.sh 본문에 없고 0600 헤더 파일에만 있다', async () => {
  const ws = await create({ name: 'hook-token' });
  await core.service.startAgent(ws.id, SIZE);
  const dir = join(dataDir, 'workspaces', ws.id);
  const token = core.workspaces.getToken(ws.id);
  expect(readFileSync(join(dir, 'hook.sh'), 'utf8')).not.toContain(token);
  expect(readFileSync(join(dir, 'auth.hdr'), 'utf8')).toBe(`Authorization: Bearer ${token}`);
  expect(statSync(join(dir, 'auth.hdr')).mode & 0o777).toBe(0o600);
});

describe('nudge (에이전트에게 알리기)', () => {
  // 입력을 그대로 출력하는 가짜 에이전트
  const echoAgent = (name: string): void => {
    writeFileSync(join(fakeBin, name), '#!/bin/sh\nexec cat\n');
    chmodSync(join(fakeBin, name), 0o755);
  };

  test('쉬는 중인 claude 에 미전달 변경이 있으면 터미널에 [두레] 글이 들어가고 미전달 변경이 비워진다', async () => {
    echoAgent('claude');
    const ws = await create({ name: 'nudge-ok' });
    const t = await core.service.startAgent(ws.id, SIZE);
    core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
    // 시작만 한 상태는 쉬는 중인지 알 수 없다 (폴더 신뢰 창이 떠 있을 수 있다)
    expect(core.service.canNudge(ws.id)).toBe(false);
    await expect(core.service.nudge(ws.id)).rejects.toThrow('에이전트가 쉬는 중일 때만 알릴 수 있습니다.');
    expect(core.pty.buffer(t.id)).not.toContain('[두레]');
    // 한 번 일하고 응답을 끝낸 것이 hook 으로 확인되면 알릴 수 있다
    const hook = join(dataDir, 'workspaces', ws.id, 'hook.sh');
    await runHook(hook, 'UserPromptSubmit'); // 이때 미전달 변경이 전달된다
    await runHook(hook, 'Stop');
    core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
    expect(core.service.canNudge(ws.id)).toBe(true);
    await core.service.nudge(ws.id);
    await until(() => core.pty.buffer(t.id).includes('추가됨: "A"'));
    const out = core.pty.buffer(t.id);
    expect(out).toContain('[두레] 사용자가 TODO를 바꿨다');
    expect(core.todos.pendingCount(ws.id)).toBe(0);
    expect(core.workspaces.get(ws.id)?.status).toBe('working'); // 같은 내용을 두 번 누르지 못하게
    expect(core.service.canNudge(ws.id)).toBe(false);
  });

  test('상태가 working 이면 오류이고 미전달 변경이 남는다', async () => {
    echoAgent('claude');
    const ws = await create({ name: 'nudge-busy' });
    await core.service.startAgent(ws.id, SIZE);
    core.workspaces.update(ws.id, { status: 'working' });
    core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
    await expect(core.service.nudge(ws.id)).rejects.toThrow('에이전트가 쉬는 중일 때만 알릴 수 있습니다.');
    expect(core.todos.pendingCount(ws.id)).toBe(1);
  });

  test('에이전트가 꺼져 있으면 오류', async () => {
    const ws = await create({ name: 'nudge-off' });
    core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
    expect(core.service.canNudge(ws.id)).toBe(false);
    await expect(core.service.nudge(ws.id)).rejects.toThrow();
    expect(core.todos.pendingCount(ws.id)).toBe(1);
  });

  test('codex 워크스페이스는 오류 (상태를 확인할 수 없다)', async () => {
    echoAgent('codex');
    const ws = await create({ name: 'nudge-codex', agentKind: 'codex' });
    await core.service.startAgent(ws.id, SIZE);
    core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
    expect(core.service.canNudge(ws.id)).toBe(false);
    await expect(core.service.nudge(ws.id)).rejects.toThrow();
    expect(core.todos.pendingCount(ws.id)).toBe(1);
  });

  test('미전달 변경이 없으면 오류', async () => {
    echoAgent('claude');
    const ws = await create({ name: 'nudge-none' });
    await core.service.startAgent(ws.id, SIZE);
    await runHook(join(dataDir, 'workspaces', ws.id, 'hook.sh'), 'Stop');
    await expect(core.service.nudge(ws.id)).rejects.toThrow();
  });
});

test('에이전트를 새로 시작하면 꺼져 있던 동안 쌓인 미전달 변경은 버린다', async () => {
  // 새 대화는 이전 목록을 본 적이 없다. 지난 변경 기록을 전달하면 소음일 뿐이고, 목록은 todo_list 로 읽는다.
  const ws = await create({ name: 'fresh-start' });
  const t = core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  core.todos.remove(t.id, { actor: 'user' });
  expect(core.todos.pendingCount(ws.id)).toBe(2);
  await core.service.startAgent(ws.id, SIZE);
  expect(core.todos.pendingCount(ws.id)).toBe(0);
  // 이미 떠 있는 에이전트에 대한 startAgent 는 미전달 변경을 건드리지 않는다
  core.todos.add({ projectId, workspaceId: ws.id, title: 'B' }, 'user');
  await core.service.startAgent(ws.id, SIZE);
  expect(core.todos.pendingCount(ws.id)).toBe(1);
});

test('startAgent 에 첫 프롬프트를 주면 에이전트의 마지막 인자로 전달된다', async () => {
  const ws = await create({ name: 'boot-prompt' });
  const t = await core.service.startAgent(ws.id, SIZE, '[두레] 첫 지시');
  await until(() => core.pty.buffer(t.id).includes('ARGS:'));
  // 인자에는 여러 줄짜리 실행 지침이 들어 있다. 첫 프롬프트는 그 뒤, 맨 끝에 온다.
  await until(() => core.pty.buffer(t.id).includes('TOKEN_ENV:'));
  const out = core.pty.buffer(t.id);
  const at = out.lastIndexOf('[두레] 첫 지시');
  expect(at).toBeGreaterThan(out.indexOf('--permission-mode acceptEdits'));
  // 가짜 에이전트는 인자를 다 찍은 뒤 TOKEN_ENV 줄을 찍는다: 그 바로 앞이 마지막 인자다
  expect(out.slice(at, out.indexOf('TOKEN_ENV:')).trim()).toBe('[두레] 첫 지시');
});

test('interrupt 는 작업 중인 claude 터미널에 ESC 를 쓰고 상태를 idle 로 한다 (쉬는 중 확인은 아니다)', async () => {
  const { ws, terminal } = await idleConfirmedAgent('interrupt-me');
  await runHook(join(dataDir, 'workspaces', ws.id, 'hook.sh'), 'PreToolUse');
  expect(core.workspaces.get(ws.id)?.status).toBe('working');
  core.service.interrupt(ws.id);
  await until(() => core.pty.buffer(terminal.id).includes('\x1b') || core.pty.buffer(terminal.id).includes('^['));
  expect(core.workspaces.get(ws.id)?.status).toBe('idle');
  core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  expect(core.service.canNudge(ws.id)).toBe(false);
});

test('interrupt 는 쉬는 중이거나 꺼진 워크스페이스에는 아무것도 쓰지 않는다', async () => {
  const { ws, terminal } = await idleConfirmedAgent('interrupt-idle');
  const before = core.pty.buffer(terminal.id);
  core.service.interrupt(ws.id);
  await new Promise((r) => setTimeout(r, 200));
  expect(core.pty.buffer(terminal.id)).toBe(before);
  const off = await create({ name: 'interrupt-off' });
  expect(() => core.service.interrupt(off.id)).not.toThrow();
});

test('시작 중인 Claude Code 는 SessionStart hook 이 오면 쉬는 중이 된다 (신뢰 창을 지났다는 뜻)', async () => {
  const ws = await create({ name: 'starting-then-idle' });
  await core.service.startAgent(ws.id, SIZE);
  expect(core.workspaces.get(ws.id)?.status).toBe('starting');
  await runHook(join(dataDir, 'workspaces', ws.id, 'hook.sh'), 'SessionStart');
  expect(core.workspaces.get(ws.id)?.status).toBe('idle');
});

test('Codex 는 hook 이 없으므로 시작하면 바로 쉬는 중으로 둔다', async () => {
  const ws = await create({ name: 'codex-idle', agentKind: 'codex' });
  await core.service.startAgent(ws.id, SIZE);
  expect(core.workspaces.get(ws.id)?.status).toBe('idle');
});

test('승인 요청이 아닌 알림(입력 대기 등)은 쉬는 중 확인을 지우지 않는다', async () => {
  const { ws } = await idleConfirmedAgent('idle-notification');
  const hook = join(dataDir, 'workspaces', ws.id, 'hook.sh');
  await runHook(hook, 'Notification', JSON.stringify({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }));
  core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'user');
  expect(core.service.canNudge(ws.id)).toBe(true);
  // 승인 요청은 쉬는 중이 아니다
  await runHook(hook, 'Notification', JSON.stringify({ notification_type: 'permission_prompt' }));
  expect(core.service.canNudge(ws.id)).toBe(false);
});

test('멈춘 대화의 메시지는 직접 시작해도 넣지 않고, 멈춤이 풀리면 꺼진 받는 쪽이 그 메시지로 뜬다', async () => {
  const receiver = await create({ name: 'gets-mail' });
  const sender = await create({ name: 'sends-mail' });
  // 프로젝트를 멈춘 채 보내 자동으로 뜨지 않게 한 뒤, 멈춤을 풀지 않고... 대신 받는 쪽을 직접 시작한다
  core.messages.pauseProject(projectId, true);
  const m = core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: sender.id }, toWorkspaceId: receiver.id, body: '시작하면 읽어라' });
  const held = await core.service.startAgent(receiver.id, SIZE);
  await until(() => core.pty.buffer(held.id).includes('TOKEN_ENV:'));
  expect(core.pty.buffer(held.id)).not.toContain('> 시작하면 읽어라'); // 멈춘 대화의 메시지는 넣지 않는다
  core.pty.kill(held.id);
  await until(() => core.pty.list(receiver.id).length === 0);
  core.messages.pauseThread(m.threadId, true); // 재개 때 자동으로 뜨지 않게 스레드만 멈춰 두고
  core.messages.pauseProject(projectId, false);
  core.messages.pauseThread(m.threadId, false); // 풀리는 순간 꺼진 받는 쪽은 메시지를 첫 프롬프트로 뜬다
  await until(() => core.pty.list(receiver.id).length === 1);
  const t = core.pty.list(receiver.id)[0];
  await until(() => core.pty.buffer(t.id).includes('TOKEN_ENV:'));
  expect(core.pty.buffer(t.id)).toContain('> 시작하면 읽어라');
});

test('받은 메시지가 대기 중인 꺼진 워크스페이스를 사용자가 시작하면 그 메시지가 첫 프롬프트로 들어간다', async () => {
  const receiver = await create({ name: 'manual-start' });
  const sender = await create({ name: 'manual-sender' });
  // 자동 시작을 실패시키려고 에이전트 실행 파일을 잠시 없앤다
  const real = join(fakeBin, 'claude');
  const hidden = join(fakeBin, 'claude.off');
  renameSync(real, hidden);
  const m = core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: sender.id }, toWorkspaceId: receiver.id, body: '수동 시작 때 읽어라' });
  await new Promise((r) => setTimeout(r, 300));
  expect(core.messages.messages(m.threadId)[0].deliveredAt).toBeNull(); // 시작 실패 → 미전달로 남는다
  renameSync(hidden, real);
  const t = await core.service.startAgent(receiver.id, SIZE);
  await until(() => core.pty.buffer(t.id).includes('TOKEN_ENV:'));
  expect(core.pty.buffer(t.id)).toContain('> 수동 시작 때 읽어라');
  expect(core.messages.messages(m.threadId)[0].deliveredAt).not.toBeNull();
});

describe('에이전트 터미널의 git', () => {
  // git 명령을 받은 대로 실행해 결과를 찍는 가짜 에이전트
  const gitRunner = (): void => {
    writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\necho "PATH_HEAD:${PATH%%:*}"\nwhile read -r line; do sh -c "$line"; echo "EXIT:$?"; done\n');
    chmodSync(join(fakeBin, 'claude'), 0o755);
  };

  test('git commit 과 git push 는 거절되고 git status 는 된다', async () => {
    gitRunner();
    const ws = await create({ name: 'guarded' });
    writeFileSync(join(ws.worktreePath, 'new.txt'), 'x\n');
    const t = await core.service.startAgent(ws.id, SIZE);
    await until(() => core.pty.buffer(t.id).includes('PATH_HEAD:'));
    expect(core.pty.buffer(t.id)).toContain(`PATH_HEAD:${join(dataDir, 'workspaces', ws.id, 'bin')}`);
    core.pty.write(t.id, 'git add -A && git commit -m agent-commit\n');
    await until(() => core.pty.buffer(t.id).includes('EXIT:1'));
    expect(core.pty.buffer(t.id)).toContain('[두레] git commit 은 사용자가 두레 화면에서 직접 한다');
    expect(gitOut(ws.worktreePath, 'rev-list', '--count', 'HEAD')).toBe('1'); // 커밋이 생기지 않았다
    core.pty.write(t.id, 'git status --short\n');
    await until(() => core.pty.buffer(t.id).includes('EXIT:0'));
    expect(core.pty.buffer(t.id)).toContain('new.txt');
    core.pty.write(t.id, 'git push origin HEAD\n');
    await until(() => core.pty.buffer(t.id).includes('[두레] git push 는 사용자가'));
  });

  test('사용자 셸 탭의 PATH 에는 대리 실행 파일 폴더가 없다', async () => {
    const ws = await create({ name: 'user-shell' });
    const t = await core.service.openShell(ws.id, SIZE);
    core.pty.write(t.id, 'echo "P=$PATH"\n');
    await until(() => core.pty.buffer(t.id).includes('P=/'));
    expect(core.pty.buffer(t.id)).not.toContain(join('workspaces', ws.id, 'bin'));
  });
});

describe('채팅에서 보내기와 승인 응답', () => {
  const catAgent = (): void => {
    writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\nexec cat -v\n');
    chmodSync(join(fakeBin, 'claude'), 0o755);
  };
  const hookOf = (id: string): string => join(dataDir, 'workspaces', id, 'hook.sh');
  const PERMISSION = JSON.stringify({ notification_type: 'permission_prompt' });
  async function agent(name: string, kind: 'claude' | 'codex' = 'claude') {
    catAgent();
    const ws = await create({ name, agentKind: kind });
    const terminal = await core.service.startAgent(ws.id, SIZE);
    return { ws, terminal };
  }
  const quiet = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms));

  test('sendUserInput: 쉬는 중이면 글이 터미널에 들어가고 Enter 가 따라온다', async () => {
    const { ws, terminal } = await agent('chat-send');
    await runHook(hookOf(ws.id), 'SessionStart');
    expect(core.service.canSendInput(ws.id)).toBe(true);
    await core.service.sendUserInput(ws.id, 'make login page');
    // 터미널의 메아리 한 번, Enter 로 줄이 넘어가 가짜 에이전트가 되뱉은 것 한 번
    await until(() => core.pty.buffer(terminal.id).split('make login page').length === 3);
  });

  test('sendUserInput: 작업 중에도 보낼 수 있다', async () => {
    const { ws, terminal } = await agent('chat-send-working');
    await runHook(hookOf(ws.id), 'PreToolUse');
    expect(core.workspaces.get(ws.id)?.status).toBe('working');
    await core.service.sendUserInput(ws.id, '이것도');
    await until(() => core.pty.buffer(terminal.id).includes('이것도'));
  });

  test('sendUserInput: 여러 줄은 붙여넣기 묶음으로 들어간다', async () => {
    const { ws, terminal } = await agent('chat-send-multi');
    await runHook(hookOf(ws.id), 'SessionStart');
    await core.service.sendUserInput(ws.id, '첫째\r\n둘째');
    await until(() => core.pty.buffer(terminal.id).includes('^[[200~첫째'));
    expect(core.pty.buffer(terminal.id)).toMatch(/둘째\^\[\[201~/);
  });

  test('sendUserInput: 시작 중, 승인 대기, 꺼짐, Codex 면 오류이고 터미널에 아무것도 쓰지 않는다', async () => {
    const { ws, terminal } = await agent('chat-send-blocked');
    const refused = '지금은 채팅으로 보낼 수 없습니다. 터미널을 확인하세요.';
    // 시작 중: 폴더 신뢰 창이 떠 있을 수 있다
    expect(core.workspaces.get(ws.id)?.status).toBe('starting');
    expect(core.service.canSendInput(ws.id)).toBe(false);
    await expect(core.service.sendUserInput(ws.id, '몰래')).rejects.toThrow(refused);
    // 승인 대기
    await runHook(hookOf(ws.id), 'PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }));
    await runHook(hookOf(ws.id), 'Notification', PERMISSION);
    expect(core.workspaces.get(ws.id)?.status).toBe('waiting_user');
    await expect(core.service.sendUserInput(ws.id, '몰래')).rejects.toThrow(refused);
    await quiet();
    expect(core.pty.buffer(terminal.id)).not.toContain('몰래');
    // 꺼짐
    const off = await create({ name: 'chat-send-off' });
    await expect(core.service.sendUserInput(off.id, '몰래')).rejects.toThrow(refused);
    // Codex
    writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\nexec cat -v\n');
    const cx = await create({ name: 'chat-send-codex', agentKind: 'codex' });
    const ct = await core.service.startAgent(cx.id, SIZE);
    expect(core.service.canSendInput(cx.id)).toBe(false);
    await expect(core.service.sendUserInput(cx.id, '몰래')).rejects.toThrow(refused);
    await quiet(200);
    expect(core.pty.buffer(ct.id)).not.toContain('몰래');
  });

  test('sendUserInput: 빈 글은 오류, 제어 문자는 지워진다', async () => {
    const { ws, terminal } = await agent('chat-send-clean');
    await runHook(hookOf(ws.id), 'SessionStart');
    await expect(core.service.sendUserInput(ws.id, '  \n ')).rejects.toThrow('보낼 글을 입력하세요.');
    await core.service.sendUserInput(ws.id, '가\x1b[201~나\x03다');
    await until(() => core.pty.buffer(terminal.id).includes('가[201~나다'));
    expect(core.pty.buffer(terminal.id)).not.toContain('^C');
  });

  test('sendUserInput 으로 보낸 글의 UserPromptSubmit 은 사용자 개입으로 친다', async () => {
    const { ws } = await agent('chat-send-human');
    await runHook(hookOf(ws.id), 'Stop');
    let intervened = 0;
    const original = core.messages.userIntervened.bind(core.messages);
    core.messages.userIntervened = (id: string) => { intervened++; return original(id); };
    await core.service.sendUserInput(ws.id, '직접 시킴');
    await runHook(hookOf(ws.id), 'UserPromptSubmit', JSON.stringify({ prompt: '직접 시킴' }));
    expect(intervened).toBe(1);
    // 사용자가 입력했으니 쉬는 중 확인은 지워진다
    expect(core.service.isConfirmedIdle(ws.id)).toBe(false);
  });

  test('answerPermission: 승인 대기 중이면 allow 는 CR 을 쓰고 작업 중으로, 같은 창에 두 번 답하지 못한다', async () => {
    const { ws, terminal } = await agent('chat-allow');
    await runHook(hookOf(ws.id), 'PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl example.com' } }));
    await runHook(hookOf(ws.id), 'Notification', PERMISSION);
    expect(core.chat.snapshot(ws.id).pendingPermission).toMatchObject({ tool: 'Bash', summary: 'curl example.com', input: 'curl example.com', canAnswer: true });
    const before = core.pty.buffer(terminal.id);
    core.service.answerPermission(ws.id, 'allow');
    await until(() => core.pty.buffer(terminal.id).length > before.length);
    expect(core.pty.buffer(terminal.id).slice(before.length)).not.toContain('^[');
    expect(core.workspaces.get(ws.id)?.status).toBe('working');
    expect(core.chat.snapshot(ws.id).pendingPermission).toBeNull();
    expect(() => core.service.answerPermission(ws.id, 'allow')).toThrow('승인을 기다리는 중이 아닙니다.');
  });

  test('answerPermission: deny 는 ESC 를 쓰고 쉬는 중으로 (확인된 쉬는 중은 아니다)', async () => {
    const { ws, terminal } = await agent('chat-deny');
    await runHook(hookOf(ws.id), 'PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl example.com' } }));
    await runHook(hookOf(ws.id), 'Notification', PERMISSION);
    core.service.answerPermission(ws.id, 'deny');
    await until(() => core.pty.buffer(terminal.id).includes('^['));
    expect(core.workspaces.get(ws.id)?.status).toBe('idle');
    expect(core.service.isConfirmedIdle(ws.id)).toBe(false);
  });

  test('answerPermission: 승인 대기 중이 아니면 오류이고 아무것도 쓰지 않는다', async () => {
    const { ws, terminal } = await agent('chat-no-permission');
    await runHook(hookOf(ws.id), 'Stop');
    const before = core.pty.buffer(terminal.id);
    expect(() => core.service.answerPermission(ws.id, 'allow')).toThrow('승인을 기다리는 중이 아닙니다.');
    expect(() => core.service.answerPermission(ws.id, 'deny')).toThrow('승인을 기다리는 중이 아닙니다.');
    await quiet(200);
    expect(core.pty.buffer(terminal.id)).toBe(before);
  });

  test('answerPermission: 사용자가 터미널에서 승인 창을 건드렸거나 예/아니오 창이 아니면 채팅에서 답하지 못한다', async () => {
    const { ws, terminal } = await agent('chat-touched');
    await runHook(hookOf(ws.id), 'PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    await runHook(hookOf(ws.id), 'Notification', PERMISSION);
    core.service.noteTerminalInput(terminal.id); // 화살표로 커서를 옮겼을 수 있다
    expect(core.chat.snapshot(ws.id).pendingPermission).toMatchObject({ canAnswer: false });
    expect(() => core.service.answerPermission(ws.id, 'allow')).toThrow('승인을 기다리는 중이 아닙니다.');
    await runHook(hookOf(ws.id), 'PreToolUse', JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: {} }));
    await runHook(hookOf(ws.id), 'Notification', PERMISSION);
    expect(core.chat.snapshot(ws.id).pendingPermission).toMatchObject({ canAnswer: false });
    expect(() => core.service.answerPermission(ws.id, 'allow')).toThrow('승인을 기다리는 중이 아닙니다.');
  });

  test('기록에서 중단을 읽으면 승인 대기에 머물던 상태가 쉬는 중으로 돌아온다 (터미널에서 직접 거부한 경우)', async () => {
    const { ws } = await agent('chat-rejected-in-terminal');
    const file = join(claudeDir, 'projects', 'p', 's1.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
    const line = (o: object): string => `${JSON.stringify({ uuid: crypto.randomUUID(), timestamp: new Date(Date.now() + 5000).toISOString(), ...o })}\n`;
    writeFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl x' } }] } }));
    await runHook(hookOf(ws.id), 'PreToolUse', JSON.stringify({ transcript_path: file, tool_name: 'Bash', tool_input: { command: 'curl x' } }));
    await runHook(hookOf(ws.id), 'Notification', JSON.stringify({ transcript_path: file, notification_type: 'permission_prompt' }));
    expect(core.workspaces.get(ws.id)?.status).toBe('waiting_user');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, line({ type: 'user', toolDenialKind: 'user-rejected', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'rejected', is_error: true }] } })
      + line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
    await until(() => core.workspaces.get(ws.id)?.status === 'idle', 4000);
    expect(core.chat.snapshot(ws.id).pendingPermission).toBeNull();
    expect(core.service.isConfirmedIdle(ws.id)).toBe(false);
  });
});
