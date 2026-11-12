import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateStatus } from '@shared/types';
import type { Git } from './git';

/** scripts/install.sh 가 설치할 때 적어 두는 것: 어느 소스 폴더에서 만들어 어디에 넣었는지 */
interface InstallInfo { sourceDir: string; app: string; commit: string; installedAt: number }

const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 30_000;
const FETCH_MS = 30_000;
const MAX_CHANGES = 20;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
/** 셸 스크립트에 값으로 넣을 글 (작은따옴표로 감싼다). */
const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * 소스에서 설치한 두레의 업데이트. 받아 둔 저장소 폴더에서 원격의 새 커밋을 확인하고,
 * 사용자가 누르면 받아서 다시 만들어 앱을 바꾼 뒤 다시 켠다 (scripts/install.sh 가 하는 일 그대로).
 * - 설치 파일(.dmg)로 넣은 앱이나 개발 모드에서는 쓰지 않는다 (supported: false).
 * - 확인은 주기적으로 한다. 받아서 바꾸는 것은 사용자가 눌렀을 때만 한다.
 * 이벤트: 'changed'
 */
export class UpdateService extends EventEmitter {
  private timer: NodeJS.Timeout | undefined;
  private state: Pick<UpdateStatus, 'behind' | 'changes' | 'checkedAt' | 'error' | 'checking'> = { behind: 0, changes: [], checkedAt: null, checking: false };
  private applying = false;

  constructor(private readonly d: {
    git: Git;
    /** 두레의 데이터 폴더. 업데이트 스크립트와 기록을 둔다 */
    dataDir: string;
    /** scripts/install.sh 가 적어 둔 설치 정보의 자리 */
    infoPath: string;
    /** 지금 돌고 있는 앱 묶음의 경로 (…/Dure.app). 묶인 앱이 아니면 null */
    runningApp: string | null;
    /** 업데이트 스크립트가 물려받을 환경 (node, git 을 찾을 수 있어야 한다) */
    env: Record<string, string>;
    /** false 면 끝난 뒤 앱을 다시 켜지 않는다 (검증용) */
    reopen?: boolean;
    /** 시험에서 스크립트를 실제로 띄우지 않게 한다 */
    launch?: (script: string) => void;
  }) {
    super();
  }

  private info(): InstallInfo | null {
    try {
      const o = JSON.parse(readFileSync(this.d.infoPath, 'utf8')) as Partial<InstallInfo>;
      if (typeof o.sourceDir !== 'string' || typeof o.app !== 'string' || typeof o.commit !== 'string') return null;
      // 지금 돌고 있는 앱이 그 설치로 넣은 앱일 때만: 다른 방법으로 넣은 앱을 소스 빌드로 바꿔치지 않는다.
      if (!this.d.runningApp || o.app !== this.d.runningApp) return null;
      if (!existsSync(join(o.sourceDir, '.git')) || !existsSync(join(o.sourceDir, 'scripts', 'install.sh'))) return null;
      return { sourceDir: o.sourceDir, app: o.app, commit: o.commit, installedAt: Number(o.installedAt) || 0 };
    } catch {
      return null;
    }
  }

  private get resultPath(): string { return join(this.d.dataDir, 'update-result.json'); }
  get logPath(): string { return join(this.d.dataDir, 'update.log'); }

  /** 지난 업데이트가 어떻게 끝났는지 (스크립트가 적어 둔다). */
  private lastResult(): UpdateStatus['last'] {
    try {
      const o = JSON.parse(readFileSync(this.resultPath, 'utf8')) as { ok?: unknown; at?: unknown };
      return { ok: o.ok === true, at: Number(o.at) * 1000 || 0 };
    } catch {
      return null;
    }
  }

  status(): UpdateStatus {
    const info = this.info();
    if (!info) return { supported: false, sourceDir: '', installed: '', available: false, behind: 0, changes: [], checkedAt: null, checking: false, last: null, logPath: this.logPath };
    return {
      supported: true, sourceDir: info.sourceDir, installed: info.commit.slice(0, 7), available: this.state.behind > 0,
      ...this.state, last: this.lastResult(), logPath: this.logPath,
    };
  }

  /** 주기적으로 확인하기 시작한다. */
  start(): void {
    if (!this.info()) return;
    const first = setTimeout(() => { void this.check(); }, FIRST_CHECK_MS);
    first.unref?.();
    this.timer = setInterval(() => { void this.check(); }, CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  dispose(): void { clearInterval(this.timer); }

  /** 원격에 새 커밋이 있는지 본다. 내려받기만 하고 (fetch) 소스 폴더의 파일은 바꾸지 않는다. */
  async check(): Promise<UpdateStatus> {
    const info = this.info();
    if (!info || this.state.checking) return this.status();
    this.state = { ...this.state, checking: true };
    this.emit('changed');
    const git = (args: string[]): Promise<string> => this.d.git.raw(['-C', info.sourceDir, ...args]);
    try {
      await Promise.race([
        git(['fetch', '--quiet', '--no-tags']),
        new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), FETCH_MS); t.unref?.(); }),
      ]);
      // 설치한 커밋에서 원격 브랜치까지 새로 들어온 것. 받아만 두고 설치하지 않은 것도 여기에 잡힌다.
      const upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
      const behind = Number((await git(['rev-list', '--count', `${info.commit}..${upstream}`])).trim()) || 0;
      const changes = behind === 0 ? [] : (await git(['log', '--no-merges', `--max-count=${MAX_CHANGES}`, '--format=%s', `${info.commit}..${upstream}`])).split('\n').map((l) => oneLine(l, 120)).filter(Boolean);
      this.state = { behind, changes, checkedAt: Date.now(), checking: false };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const error = /timeout|Could not resolve|unable to access|Connection|Permission denied|Could not read from remote/i.test(m)
        ? '저장소에 닿지 않습니다 (네트워크나 저장소 권한을 확인하세요).'
        : /no upstream|@\{u\}/i.test(m) ? '소스 폴더의 브랜치가 원격 브랜치를 따라가고 있지 않습니다.' : '새 버전을 확인하지 못했습니다.';
      this.state = { ...this.state, checkedAt: Date.now(), checking: false, error };
    }
    this.emit('changed');
    return this.status();
  }

  /**
   * 업데이트한다: 스크립트를 따로 띄우고 돌아온다. 부른 쪽(앱)이 곧바로 꺼져야 한다.
   * 스크립트는 앱이 꺼지기를 기다렸다가 새 소스를 받고, 다시 만들어 넣고, 앱을 다시 켠다.
   * 만들다 실패하면 앞의 앱이 그대로 남고, 그 앱을 다시 켠다.
   */
  apply(): void {
    const info = this.info();
    if (!info) throw new Error('이 두레는 여기서 업데이트할 수 없습니다 (소스에서 설치한 앱이 아닙니다).');
    if (this.applying) throw new Error('이미 업데이트하는 중입니다.');
    this.applying = true;
    mkdirSync(this.d.dataDir, { recursive: true });
    rmSync(this.resultPath, { force: true });
    const script = join(this.d.dataDir, 'update.sh');
    writeFileSync(script, [
      '#!/bin/bash',
      '# 두레가 만든 업데이트 스크립트. 앱이 꺼진 뒤에 새 소스를 받아 다시 만들고, 앱을 다시 켠다.',
      `APP=${sh(info.app)}`,
      `SRC=${sh(info.sourceDir)}`,
      `RESULT=${sh(this.resultPath)}`,
      'echo "== $(date) 업데이트 시작"',
      '# 앱이 꺼지기를 기다린다 (최대 60초)',
      'for _ in $(seq 1 120); do pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.5; done',
      'ok=false',
      '# 같은 자리에 다시 넣고, 설치 정보도 같은 자리에 적는다.',
      `export DURE_INSTALL_DIR=${sh(dirname(info.app))} DURE_INSTALL_INFO=${sh(this.d.infoPath)}`,
      'if cd "$SRC" && git pull --ff-only && DURE_NO_OPEN=1 bash scripts/install.sh; then ok=true; fi',
      'printf \'{"ok":%s,"at":%s}\\n\' "$ok" "$(date +%s)" > "$RESULT"',
      'echo "== $(date) 끝 (성공: $ok)"',
      ...(this.d.reopen === false ? [] : ['open "$APP"']),
      '',
    ].join('\n'), { mode: 0o700 });
    if (this.d.launch) { this.d.launch(script); return; }
    const log = openSync(this.logPath, 'a');
    // 앱과 떼어서 띄운다: 앱이 꺼져도 계속 돈다.
    const child = spawn('/bin/bash', [script], { detached: true, stdio: ['ignore', log, log], env: this.d.env, cwd: info.sourceDir });
    child.unref();
  }

  /** 지난 업데이트의 결과 알림을 지운다 (사용자가 봤다). */
  dismissLast(): void {
    rmSync(this.resultPath, { force: true });
    this.emit('changed');
  }
}
