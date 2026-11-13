import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let ws: Workspace;
let other: Workspace;
beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  const projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: 'API', baseBranch: 'main', agentKind: 'claude' });
  other = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('작업 기록: 받은 메시지, 보낸 메시지, 자료, TODO, 커밋과 파일을 새것부터 모은다', async () => {
  core.messages.send({ projectId: ws.projectId, from: { kind: 'workspace', workspaceId: other.id }, toWorkspaceId: ws.id, body: 'POST /login 형식 알려 줘', title: 'API 형식' });
  core.messages.send({ projectId: ws.projectId, from: { kind: 'workspace', workspaceId: ws.id }, toWorkspaceId: other.id, body: '{"email": string}' , title: '답' });
  core.messages.publish({ projectId: ws.projectId, workspaceId: ws.id, kind: 'api-spec', title: '로그인 API', body: 'POST /login' });
  const t = core.todos.add({ projectId: ws.projectId, workspaceId: ws.id, title: 'POST /login 만들기' }, 'agent');
  core.todos.update(t.id, { status: 'done' }, { actor: 'agent', rev: t.rev });
  core.todos.add({ projectId: ws.projectId, workspaceId: ws.id, title: '시험 쓰기' }, 'agent');
  writeFileSync(join(ws.worktreePath, 'api.ts'), 'x\n');
  execFileSync('git', ['-C', ws.worktreePath, 'add', '-A']);
  execFileSync('git', ['-C', ws.worktreePath, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'feat: login api']);
  const items = await core.activity.list(ws.id);
  const kinds = items.map((i) => i.kind);
  expect(kinds).toEqual(expect.arrayContaining(['message-in', 'message-out', 'artifact', 'todo', 'commit']));
  expect(items.find((i) => i.kind === 'message-in')!.title).toBe('화면에게서 "API 형식"');
  expect(items.find((i) => i.kind === 'message-out')!.title).toBe('화면에게 보냄');
  expect(items.find((i) => i.kind === 'commit')).toMatchObject({ title: '커밋: feat: login api' });
  expect(items.find((i) => i.kind === 'commit')!.detail).toContain('A api.ts');
  expect(items.filter((i) => i.kind === 'todo').map((i) => i.title).sort()).toEqual(['TODO 생김: 시험 쓰기', 'TODO 완료: POST /login 만들기']);
  // 새것부터
  expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort((a, b) => b - a));
  // 다른 워크스페이스의 기록에는 이 워크스페이스의 커밋이 없다
  expect((await core.activity.list(other.id)).some((i) => i.kind === 'commit')).toBe(false);
});
