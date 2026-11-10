// 실험 도구: 임시 저장소, PTY 로 에이전트 띄우기, 화면 출력 읽기.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pty from 'node-pty';

const OUT = resolve(import.meta.dirname, '../out');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ' ')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\x1b[=>78]/g, '')
    .replace(/\r/g, '\n');
}

export function makeTempDir(prefix = 'dure-spike-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeTempRepo() {
  const dir = makeTempDir('dure-spike-repo-');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# spike\n');
  git('add', '-A');
  git('-c', 'user.name=dure-spike', '-c', 'user.email=spike@example.invalid', 'commit', '-q', '-m', 'init');
  return dir;
}

export function gitStatus(dir) {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
}

// 중첩 실행 시 바깥 에이전트 세션의 환경이 새지 않게 한다.
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC_|ELECTRON_RUN_AS_NODE|CODEX_|ORCA_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, TERM: 'xterm-256color', ...extra };
}

const DIALOG = /enter(\/esc)?\s+(to\s+)?(confirm|continue)|Try new model|esc\s+(to\s+)?(cancel|quit|skip)|Update now|Update available/i;

export function runAgent({ name, command, args, env = {}, cwd }) {
  mkdirSync(OUT, { recursive: true });
  const logFile = join(OUT, `${name}.log`);
  writeFileSync(logFile, `$ ${command} ${args.join(' ')}\ncwd=${cwd}\n\n`);
  const p = pty.spawn(command, args, { name: 'xterm-256color', cols: 140, rows: 45, cwd, env: cleanEnv(env) });
  let raw = '';
  let exited = null;
  let lastData = Date.now();
  p.onData((d) => { raw += d; lastData = Date.now(); appendFileSync(logFile, d); });
  p.onExit((e) => { exited = e; });
  const api = {
    pid: p.pid,
    logFile,
    write: (s) => p.write(s),
    // 글자를 넣고 잠깐 뒤 Enter 를 따로 보낸다 (TUI 가 붙여넣기로 묶어버리는 것 방지)
    // 안전장치: 화면에 선택 창(확인/계속/건너뛰기)이 떠 있으면 절대 입력하지 않는다.
    // (2026-11-11 사고: Codex 업데이트 창에 Enter 가 들어가 `brew upgrade --cask codex` 가 실행됨)
    async submit(text, enter = '\r') {
      const screen = stripAnsi(raw).slice(-400); // 선택 창 안내문은 화면 맨 아래에 있다
      if (DIALOG.test(screen)) throw new Error('선택 창이 떠 있어 입력을 중단함:\n' + screen.replace(/\n\s*\n+/g, '\n').slice(-600));
      p.write(text); await sleep(400); p.write(enter);
    },
    output: () => stripAnsi(raw),
    raw: () => raw,
    tail: (n = 1500) => stripAnsi(raw).replace(/\n\s*\n+/g, '\n').slice(-n),
    exited: () => exited,
    async waitFor(cond, ms = 60000, label = 'condition') {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const ok = typeof cond === 'function' ? await cond(stripAnsi(raw)) : cond.test(stripAnsi(raw));
        if (ok) return true;
        if (exited) return false;
        await sleep(250);
      }
      console.log(`[timeout] ${label}`);
      return false;
    },
    // 출력이 quietMs 동안 멈출 때까지 기다린다
    async settle(quietMs = 2500, maxMs = 60000) {
      const end = Date.now() + maxMs;
      while (Date.now() < end) {
        if (Date.now() - lastData >= quietMs) return true;
        await sleep(200);
      }
      return false;
    },
    kill: () => { try { p.kill(); } catch {} },
  };
  return api;
}

// 에이전트가 뜰 때 나오는 신뢰 확인 창을 Enter 로 넘긴다.
export async function passStartup(agent, { maxMs = 40000 } = {}) {
  const end = Date.now() + maxMs;
  let pressed = 0;
  while (Date.now() < end) {
    await agent.settle(2000, 15000);
    const t = agent.tail(1200);
    if (/Update available|Update now/i.test(t)) {
      // Codex 업데이트 창: 기본 선택이 "Update now" 다. Esc 로 건너뛴다. Enter 금지.
      agent.write('\x1b'); await sleep(2500); continue;
    }
    if (/Try new model/.test(t) && /Use existing model/.test(t)) {
      // Codex 새 모델 안내: 사용자의 모델 설정을 바꾸지 않도록 "Use existing model" 선택
      agent.write('\x1b[B'); await sleep(300); agent.write('\r'); await sleep(2500); continue;
    }
    if (/Yes, I trust this folder/.test(agent.tail(350)) && pressed < 3) { // 지금 떠 있는 창만 본다 (지난 화면의 잔상 제외)
      // Claude Code: 기본 선택이 "No, exit" 이므로 아래로 한 칸 내린 뒤 Enter
      // 커서가 실제로 "Yes" 로 옮겨간 것을 화면에서 확인한 뒤에만 Enter 를 보낸다.
      let onYes = false;
      for (let i = 0; i < 4 && !onYes; i++) {
        agent.write('\x1b[B'); await sleep(900);
        onYes = /❯\s*(2\.\s*)?Yes, I trust this folder/.test(agent.tail(500));
      }
      if (!onYes) throw new Error('신뢰 창에서 Yes 로 이동하지 못함:\n' + agent.tail(400));
      agent.write('\r'); pressed++; await sleep(3000); continue;
    }
    if (/Trust this folder\?|Do you trust|Do you want to proceed|Press Enter to continue|allow.*directory/i.test(t) && pressed < 3) {
      agent.write('\r'); pressed++; await sleep(2500); continue;
    }
    return pressed;
  }
  return pressed;
}
