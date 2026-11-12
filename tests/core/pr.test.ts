import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGit } from '@core/git';
import { createCore, type Core } from '@core/index';
import { PrService } from '@core/pr';
import { parseRemote, prUrl } from '@shared/pr';
import type { Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

test('원격 주소에서 서비스와 저장소를 알아낸다', () => {
  expect(parseRemote('git@github.com:donginKim/dure.git')).toEqual({ host: 'github', web: 'https://github.com/donginKim/dure' });
  expect(parseRemote('https://github.com/donginKim/dure')).toEqual({ host: 'github', web: 'https://github.com/donginKim/dure' });
  expect(parseRemote('https://x-token@github.com/a/b.git')?.web).toBe('https://github.com/a/b');
  expect(parseRemote('git@ssh.bitbucket.org:team/repo.git')).toEqual({ host: 'bitbucket', web: 'https://bitbucket.org/team/repo' });
  expect(parseRemote('ssh://git@gitlab.com/group/sub/repo.git')).toEqual({ host: 'gitlab', web: 'https://gitlab.com/group/sub/repo' });
  expect(parseRemote('/Users/me/local/repo')).toBeNull();
  expect(parseRemote('git@example.com:a/b.git')).toBeNull();
  expect(parseRemote(null)).toBeNull();
});

test('PR 을 만드는 웹 화면의 주소', () => {
  const gh = parseRemote('git@github.com:a/b.git')!;
  expect(prUrl(gh, 'main', 'dure/로그인 화면')).toBe('https://github.com/a/b/compare/main...dure%2F%EB%A1%9C%EA%B7%B8%EC%9D%B8%20%ED%99%94%EB%A9%B4?expand=1');
  expect(prUrl(parseRemote('git@bitbucket.org:t/r.git')!, 'develop', 'feat/x')).toBe('https://bitbucket.org/t/r/pull-requests/new?source=feat%2Fx&dest=develop');
  expect(prUrl(parseRemote('git@gitlab.com:g/r.git')!, 'main', 'x')).toContain('/-/merge_requests/new?');
});

describe('PR 만들기', () => {
  let core: Core; let ws: Workspace; let calls: string[][];
  const prs = (o: { gh?: boolean; out?: string } = {}): PrService => new PrService({
    db: core.notes['db'], workspaces: core.workspaces, git: createGit(), env: {},
    run: async (cmd, args) => { calls.push([cmd, ...args]); if (args[0] === '--version') { if (o.gh === false) throw new Error('not found'); return 'gh 2'; } return o.out ?? 'Creating pull request\nhttps://github.com/a/b/pull/7'; },
  });
  const commit = (name: string, msg: string): void => { writeFileSync(join(ws.worktreePath, name), 'x\n'); gitOut(ws.worktreePath, 'add', '-A'); gitOut(ws.worktreePath, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg); };
  beforeEach(async () => {
    calls = [];
    core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
    const projectId = core.projects.create('p').id;
    const path = makeRepo('repo');
    // 원격으로 쓸 빈 저장소
    const remote = join(tempDir(), 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    gitOut(path, 'remote', 'add', 'origin', remote);
    const repo = await core.addRepo(projectId, path);
    ws = await core.service.create({ projectId, repoId: repo.id, name: '로그인', baseBranch: 'main', agentKind: 'claude' });
    core.workspaces.update(ws.id, { summary: '로그인 폼' });
    ws = core.workspaces.get(ws.id)!;
  });
  afterEach(async () => { await core.dispose(); });

  test('초안이 없으면 커밋 제목으로 채운다. 에이전트가 초안을 적으면 그것이 먼저다', async () => {
    commit('a.txt', 'feat: 폼'); commit('b.txt', 'fix: 검증');
    const p = prs();
    const info = await p.info(ws.id);
    // 원격이 로컬 폴더라 어느 서비스인지 모른다
    expect(info).toMatchObject({ host: null, url: null, canCreate: false, pushed: false, base: 'main', head: ws.branch, title: 'feat: 폼' });
    expect(info.body).toBe('로그인 폼\n\n- feat: 폼\n- fix: 검증');
    p.saveDraft(ws.id, { title: '로그인 폼 추가', body: '## 무엇\n폼' });
    expect(await p.info(ws.id)).toMatchObject({ title: '로그인 폼 추가', body: '## 무엇\n폼' });
    expect(() => p.saveDraft(ws.id, { title: ' ', body: '' })).toThrow('제목이나 설명');
  });

  test('GitHub 이고 gh 가 있고 push 한 뒤에만 여기서 만든다. 만들면 주소를 돌려주고 초안을 지운다', async () => {
    commit('a.txt', 'feat: 폼');
    gitOut(ws.worktreePath, 'push', '-q', 'origin', ws.branch);
    // 원격 주소를 GitHub 의 것으로 바꾼다 (push 는 이미 됐다)
    gitOut(ws.worktreePath, 'remote', 'set-url', 'origin', 'git@github.com:a/b.git');
    const p = prs();
    p.saveDraft(ws.id, { title: '초안', body: '설명' });
    const info = await p.info(ws.id);
    expect(info).toMatchObject({ host: 'github', canCreate: true, pushed: true });
    expect(await p.create(ws.id, { title: '로그인 폼', body: '설명' })).toBe('https://github.com/a/b/pull/7');
    expect(calls.at(-1)).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', ws.branch, '--title', '로그인 폼', '--body', '설명']);
    expect((await p.info(ws.id)).title).toBe('feat: 폼');
    // 올리지 않은 커밋이 있으면 만들지 않는다
    commit('b.txt', 'fix: 더');
    await expect(p.create(ws.id, { title: 'x', body: '' })).rejects.toThrow('먼저 push');
    // gh 가 없으면 브라우저로
    await expect(prs({ gh: false }).create(ws.id, { title: 'x', body: '' })).rejects.toThrow('gh (GitHub CLI) 가 없어');
  });
});
