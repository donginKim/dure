import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let dataDir: string;
let projectId: string;
let ws: Workspace;
let repoPath: string;

function runHook(event: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(join(dataDir, 'workspaces', ws.id, 'hook.sh'), [event], { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin?.end('{}');
  });
}

beforeEach(async () => {
  dataDir = join(tempDir(), 'dure data');
  const fakeBin = join(tempDir(), 'fake bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\nexec cat\n'); chmodSync(join(fakeBin, 'claude'), 0o755);
  core = await createCore({ dataDir, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir() } });
  projectId = core.projects.create('쇼핑몰').id;
  repoPath = makeRepo('shop');
  const repo = await core.addRepo(projectId, repoPath);
  ws = await core.service.create({ projectId, repoId: repo.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

const edit = (name: string, body: string) => writeFileSync(join(ws.worktreePath, name), body);
const addOrigin = () => {
  const bare = join(tempDir(), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitOut(ws.worktreePath, 'remote', 'add', 'origin', bare);
  return bare;
};
// 에이전트를 "작업 중" 으로 두어 알림이 다음 hook 에 실리게 한다
const agentWorking = async () => { await core.service.startAgent(ws.id, { cols: 80, rows: 24 }); await runHook('PreToolUse'); };

test('state: 브랜치, 바뀐 파일, 초안, 원격 주소, 앞선 커밋 수를 한 번에 준다', async () => {
  edit('a.txt', '1\n');
  core.commitDrafts.save(ws.id, 'feat: a 추가');
  const s = await core.commit.state(ws.id);
  expect(s.branch).toBe('dure/프론트');
  expect(s.files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'untracked' })]);
  expect(s.draft?.message).toBe('feat: a 추가');
  expect(s.remoteUrl).toBeNull();
  expect(s.ahead).toBeNull();
});

test('commit: 성공하면 초안이 지워지고 작업 중인 에이전트에게 알림이 간다', async () => {
  await agentWorking();
  edit('a.txt', '1\n');
  core.commitDrafts.save(ws.id, 'feat: 초안');
  const changed: string[] = [];
  core.commit.on('changed', (id) => changed.push(id));
  const res = await core.commit.commit(ws.id, { files: ['a.txt'], message: 'feat: 사용자가 고친 메시지' });
  expect(res.subject).toBe('feat: 사용자가 고친 메시지');
  expect(gitOut(ws.worktreePath, 'log', '-1', '--format=%s')).toBe('feat: 사용자가 고친 메시지');
  expect(core.commitDrafts.get(ws.id)).toBeUndefined();
  expect(changed).toContain(ws.id);
  const out = JSON.parse(await runHook('PostToolUse'));
  expect(out.hookSpecificOutput.additionalContext).toContain('[두레] 두레가 알린다.');
  expect(out.hookSpecificOutput.additionalContext).toContain(`> 사용자가 커밋했다: ${res.hash} feat: 사용자가 고친 메시지`);
});

test('commit: 실패하면(pre-commit 거절) 초안이 그대로 남고 git 의 오류가 전해진다', async () => {
  const hooksDir = gitOut(ws.worktreePath, 'rev-parse', '--git-common-dir');
  const hook = join(hooksDir.startsWith('/') ? hooksDir : join(ws.worktreePath, hooksDir), 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "린트 실패" >&2\nexit 1\n'); chmodSync(hook, 0o755);
  edit('a.txt', '1\n');
  core.commitDrafts.save(ws.id, 'feat: 초안');
  await expect(core.commit.commit(ws.id, { files: ['a.txt'], message: 'x' })).rejects.toThrow('린트 실패');
  expect(core.commitDrafts.get(ws.id)?.message).toBe('feat: 초안');
});

test('꺼진 에이전트에게는 알림을 보내지 않는다 (커밋했다고 에이전트가 떠오르면 안 된다)', async () => {
  edit('a.txt', '1\n');
  await core.commit.commit(ws.id, { files: ['a.txt'], message: 'x' });
  await new Promise((r) => setTimeout(r, 300));
  expect(core.pty.list(ws.id)).toEqual([]);
  expect(core.messages.threads(projectId)).toEqual([]);
});

test('push: origin 이 없으면 오류', async () => {
  await expect(core.commit.push(ws.id)).rejects.toThrow('원격 저장소(origin)가 없습니다.');
});

test('push: 성공하면 알림이 가고 state 의 ahead 가 0 이 된다', async () => {
  const bare = addOrigin();
  await agentWorking();
  edit('a.txt', '1\n');
  await core.commit.commit(ws.id, { files: ['a.txt'], message: 'c1' });
  await runHook('PostToolUse'); // 커밋 알림을 비운다
  await core.commit.push(ws.id);
  const s = await core.commit.state(ws.id);
  expect(s.remoteUrl).toBe(bare);
  expect(s.ahead).toBe(0);
  expect(execFileSync('git', ['-C', bare, 'rev-parse', 'dure/프론트'], { encoding: 'utf8' }).trim()).toBe(gitOut(ws.worktreePath, 'rev-parse', 'HEAD'));
  const out = JSON.parse(await runHook('PostToolUse'));
  expect(out.hookSpecificOutput.additionalContext).toContain('> 사용자가 push 했다: dure/프론트 → origin');
});

test('알림은 같은 "두레 알림" 스레드에 쌓인다', async () => {
  await agentWorking();
  edit('a.txt', '1\n');
  await core.commit.commit(ws.id, { files: ['a.txt'], message: 'c1' });
  edit('b.txt', '2\n');
  await core.commit.commit(ws.id, { files: ['b.txt'], message: 'c2' });
  const threads = core.messages.threads(projectId);
  expect(threads).toHaveLength(1);
  expect(threads[0].title).toBe('두레 알림');
  expect(core.messages.messages(threads[0].id)).toHaveLength(2);
});

test('commit_draft_save 도구가 초안을 저장하고 changed 가 난다', async () => {
  const changed: string[] = [];
  core.commit.on('changed', (id) => changed.push(id));
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(core.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${core.workspaces.getToken(ws.id)}` } } }));
  const res = await client.callTool({ name: 'commit_draft_save', arguments: { message: 'feat: 로그인 링크 추가\n\n비밀번호 찾기로 연결' } });
  await client.close();
  expect(JSON.parse((res.content as { text: string }[])[0].text)).toEqual({ saved: true });
  expect(core.commitDrafts.get(ws.id)?.message).toBe('feat: 로그인 링크 추가\n\n비밀번호 찾기로 연결');
  expect(changed).toEqual([ws.id]);
});
