import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  core = await createCore({ dataDir, worktreeRoot, baseEnv: { PATH: path, SHELL: '/bin/sh', HOME: tempDir() } });
}

beforeEach(async () => {
  dataDir = join(tempDir(), 'dure data');
  worktreeRoot = join(tempDir(), 'work trees');
  fakeBin = join(tempDir(), 'fake bin');
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
  expect(core.workspaces.get(ws.id)?.status).toBe('idle');
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
async function runHook(hook: string, event: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = execFile(hook, [event], { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.end('{}');
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
