import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGit } from '@core/git';
import { UpdateService } from '@core/updateService';
import { tempDir } from '../helpers/repo';

const git = (dir: string, ...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', encoding: 'utf8' }).trim();
const commit = (dir: string, msg: string): string => {
  writeFileSync(join(dir, 'file.txt'), `${msg}\n`);
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

/** 원격 저장소(origin)와 그것을 받은 소스 폴더를 만든다. 소스 폴더에는 설치 스크립트가 있다. */
function setup(): { origin: string; src: string; data: string; app: string; installed: string; svc: (o?: { app?: string | null; launched?: string[] }) => UpdateService } {
  const root = tempDir();
  const origin = join(root, 'origin'); const src = join(root, '소스 폴더'); const data = join(root, 'data'); const app = join(root, 'Apps', 'Dure.app');
  mkdirSync(origin); mkdirSync(data);
  git(origin, 'init', '-q', '-b', 'main');
  mkdirSync(join(origin, 'scripts'));
  writeFileSync(join(origin, 'scripts', 'install.sh'), '#!/bin/bash\n');
  commit(origin, '처음');
  execFileSync('git', ['clone', '-q', origin, src], { stdio: 'pipe' });
  const installed = git(src, 'rev-parse', 'HEAD');
  writeFileSync(join(data, 'install.json'), JSON.stringify({ sourceDir: src, app, commit: installed, installedAt: 1 }));
  const svc = (o: { app?: string | null; launched?: string[] } = {}): UpdateService => new UpdateService({
    git: createGit(), dataDir: data, infoPath: join(data, 'install.json'), runningApp: o.app === undefined ? app : o.app, env: {}, launch: (s) => { o.launched?.push(s); },
  });
  return { origin, src, data, app, installed, svc };
}

test('소스에서 설치한 앱이 아니면 업데이트를 지원하지 않는다', () => {
  const t = setup();
  expect(t.svc().status()).toMatchObject({ supported: true, installed: t.installed.slice(0, 7), available: false });
  // 개발 모드 (묶인 앱이 아니다)
  expect(t.svc({ app: null }).status().supported).toBe(false);
  // 다른 방법으로 넣은 앱 (설치 정보의 앱과 다르다)
  expect(t.svc({ app: '/Applications/Other/Dure.app' }).status().supported).toBe(false);
  expect(() => t.svc({ app: null }).apply()).toThrow('소스에서 설치한 앱이 아닙니다');
  // 소스 폴더가 없어졌다
  writeFileSync(join(t.data, 'install.json'), JSON.stringify({ sourceDir: join(t.src, 'nope'), app: t.app, commit: t.installed }));
  expect(t.svc().status().supported).toBe(false);
});

test('원격에 새 커밋이 있으면 알려 준다. 확인은 소스 폴더의 파일을 바꾸지 않는다', async () => {
  const t = setup();
  const s = t.svc();
  expect(await s.check()).toMatchObject({ available: false, behind: 0, changes: [] });
  commit(t.origin, 'feat: 사진 붙여넣기');
  commit(t.origin, 'fix: 켜짐 표시');
  const st = await s.check();
  expect(st).toMatchObject({ available: true, behind: 2, changes: ['fix: 켜짐 표시', 'feat: 사진 붙여넣기'] });
  expect(st.error).toBeUndefined();
  // 받아 두기만 했다: 소스 폴더는 그대로다
  expect(git(t.src, 'rev-parse', 'HEAD')).toBe(t.installed);
  expect(readFileSync(join(t.src, 'file.txt'), 'utf8')).toBe('처음\n');
});

test('받아만 두고 설치하지 않은 것도 새 버전으로 본다. 원격에 닿지 않으면 이유를 알려 준다', async () => {
  const t = setup();
  commit(t.origin, '새 것');
  git(t.src, 'pull', '-q');
  expect(await t.svc().check()).toMatchObject({ available: true, behind: 1 });
  git(t.src, 'remote', 'set-url', 'origin', join(t.origin, 'gone'));
  const st = await t.svc().check();
  expect(st.available).toBe(false);
  expect(st.error).toBeTruthy();
});

test('업데이트는 스크립트를 따로 띄운다: 앱이 꺼지기를 기다리고, 받고, 다시 만들고, 앱을 다시 켠다', () => {
  const t = setup();
  const launched: string[] = [];
  const s = t.svc({ launched });
  s.apply();
  expect(launched.length).toBe(1);
  const script = readFileSync(launched[0]!, 'utf8');
  expect(script).toContain(`APP='${t.app}'`);
  expect(script).toContain(`SRC='${t.src}'`);
  expect(script).toContain('git pull --ff-only && DURE_NO_OPEN=1 bash scripts/install.sh');
  // 같은 자리에 다시 넣는다
  expect(script).toContain(`DURE_INSTALL_DIR='${join(t.app, '..')}'`);
  expect(script).toContain(`DURE_INSTALL_INFO='${join(t.data, 'install.json')}'`);
  expect(script.indexOf('pgrep')).toBeLessThan(script.indexOf('git pull'));
  expect(script.trimEnd().endsWith('open "$APP"')).toBe(true);
  expect(() => s.apply()).toThrow('이미 업데이트하는 중');
  // 스크립트가 남긴 결과를 다음에 켰을 때 알려 준다
  writeFileSync(join(t.data, 'update-result.json'), '{"ok":false,"at":1700000000}\n');
  expect(t.svc().status().last).toEqual({ ok: false, at: 1700000000000 });
  t.svc().dismissLast();
  expect(existsSync(join(t.data, 'update-result.json'))).toBe(false);
});

test('업데이트 스크립트를 실제로 돌리면 새 소스를 받고 설치 스크립트를 실행한 뒤 결과를 적는다', () => {
  const t = setup();
  // 가짜 설치 스크립트: 실행됐다는 표시만 남긴다
  writeFileSync(join(t.origin, 'scripts', 'install.sh'), '#!/bin/bash\necho "installed $(git rev-parse --short HEAD) open=$DURE_NO_OPEN" > "$(dirname "$0")/../ran.txt"\n');
  const next = commit(t.origin, '새 버전');
  const launched: string[] = [];
  t.svc({ launched }).apply();
  // open 은 가짜로 바꾼다 (앱을 띄우지 않는다)
  const bin = join(tempDir(), 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'open'), '#!/bin/bash\necho "$@" > "$OPENED"\n', { mode: 0o755 });
  const opened = join(tempDir(), 'opened.txt');
  execFileSync('/bin/bash', [launched[0]!], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENED: opened }, stdio: 'pipe' });
  expect(git(t.src, 'rev-parse', 'HEAD')).toBe(next);
  expect(readFileSync(join(t.src, 'ran.txt'), 'utf8')).toBe(`installed ${next.slice(0, 7)} open=1\n`);
  expect(JSON.parse(readFileSync(join(t.data, 'update-result.json'), 'utf8'))).toMatchObject({ ok: true });
  expect(readFileSync(opened, 'utf8').trim()).toBe(t.app);
});
