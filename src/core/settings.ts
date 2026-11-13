import { EventEmitter } from 'node:events';
import { validHost } from './browserService';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ModelChoice, Settings } from '@shared/types';

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: 'claude',
  defaultEngine: 'chat',
  defaultPermissionMode: 'ask',
  worktreeRoot: '',
  repoRoot: '',
  oracleClientDir: '',
  agentBrowser: 'ask',
  agentBrowserHosts: '',
  peersEnabled: false,
  peerName: '',
  peerPort: 47800,
  claudePath: '',
  claudeModel: '',
  claudeEffort: '',
  claudeArgs: '',
  codexPath: '',
  codexArgs: '',
  autoTrust: true,
  threadCap: 10,
  projectCap: 50,
  autoStartOnMessage: true,
  notifyAgentOnCommit: true,
  reviewOnDraft: true,
  reviewModel: '',
  notesForAgents: false,
  notesWriteForAgents: false,
  notifications: true,
  workTimeEnabled: false,
  workWifi: '',
  workTimeUnit: 'half',
  workGraceMin: 5,
  workDayHours: 8,
  verifyTimeoutSec: 300,
  openAtLogin: false,
  terminalFontSize: 13,
  chatFontSize: 13.5,
};

/**
 * 한 줄로 쓴 인자를 낱말로 나눈다. 작은따옴표와 큰따옴표로 공백을 묶을 수 있다.
 * 셸에 넘기지 않는다: 변수나 명령 치환은 풀리지 않고 글자 그대로 인자가 된다.
 */
export function parseArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) { out.push(cur); cur = ''; has = false; }
    } else cur += ch;
  }
  if (quote) throw new Error('따옴표가 닫히지 않았습니다.');
  if (has || cur) out.push(cur);
  return out;
}

// 두레가 직접 정하는 인자. 추가 인자로 겹쳐 주면 연결이 끊기거나(MCP, hook, 입출력 방식)
// 화면에 보이는 권한 모드와 실제가 달라진다(승인 생략을 몰래 켜는 길).
const RESERVED: Record<'claude' | 'codex', { flags: string[]; prefixes?: string[] }> = {
  claude: { flags: [
    '--mcp-config', '--strict-mcp-config', '--settings', '--setting-sources', '--append-system-prompt', '--system-prompt', '--allowedTools', '--allowed-tools',
    '--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-prompt-tool',
    '--output-format', '--input-format', '--include-partial-messages', '--verbose', '--print', '-p', '--resume', '-r', '--continue', '-c', '--session-id', '--model', '--effort', '--disallowedTools', '--disallowed-tools', '--tools',
  ] },
  codex: { flags: [
    '--dangerously-bypass-approvals-and-sandbox', '--sandbox', '-s', '--ask-for-approval', '-a', '--full-auto', '--yolo', '-c', '--config', '--profile', '-p',
  ] },
};

/** 추가 인자에 두레가 직접 정하는 것이 들어 있으면 그 이름을 돌려준다. */
export function reservedArg(kind: 'claude' | 'codex', args: string[]): string | undefined {
  const r = RESERVED[kind];
  return args.find((a) => { const name = a.split('=')[0]!; return r.flags.includes(name); });
}

type Check<K extends keyof Settings> = (v: unknown) => Settings[K];
const oneOf = <T extends string>(label: string, ...allowed: T[]) => (v: unknown): T => {
  if (!allowed.includes(v as T)) throw new Error(`${label}: 고를 수 없는 값입니다.`);
  return v as T;
};
const bool = (label: string) => (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new Error(`${label}: 켜기/끄기만 됩니다.`);
  return v;
};
const int = (label: string, min: number, max: number) => (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${label}: ${min}에서 ${max} 사이의 정수여야 합니다.`);
  return v;
};
const size = (label: string, min: number, max: number) => (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${label}: ${min}에서 ${max} 사이여야 합니다.`);
  return Math.round(v * 2) / 2;
};
const path = (label: string) => (v: unknown): string => {
  if (typeof v !== 'string') throw new Error(`${label}: 글자여야 합니다.`);
  const t = v.trim();
  if (t && !isAbsolute(t) && !t.startsWith('~/')) throw new Error(`${label}: 전체 경로로 쓰세요 (/ 또는 ~/ 로 시작).`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(t) || t.length > 1000) throw new Error(`${label}: 쓸 수 없는 글자가 있거나 너무 깁니다.`);
  return t;
};
const args = (label: string, kind: 'claude' | 'codex') => (v: unknown): string => {
  if (typeof v !== 'string') throw new Error(`${label}: 글자여야 합니다.`);
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  if (t.length > 2000 || /[\x00-\x08\x0a-\x1f]/.test(t)) throw new Error(`${label}: 너무 길거나 쓸 수 없는 글자가 있습니다.`);
  let list: string[];
  try { list = parseArgs(t); } catch (e) { throw new Error(`${label}: ${(e as Error).message}`); }
  const bad = reservedArg(kind, list);
  if (bad) throw new Error(`${label}: ${bad} 는 두레가 직접 정하는 인자라 넣을 수 없습니다.`);
  return t;
};
const model = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('모델: 글자여야 합니다.');
  const t = v.trim();
  if (t && !/^[\w.\-:/[\]]{1,100}$/.test(t)) throw new Error('모델: 이름에 쓸 수 없는 글자가 있습니다.');
  return t;
};

const CHECKS: { [K in keyof Settings]: Check<K> } = {
  defaultAgent: oneOf('기본 에이전트', 'claude', 'codex'),
  defaultEngine: oneOf('기본 방식', 'chat', 'terminal'),
  defaultPermissionMode: oneOf('기본 권한 모드', 'ask', 'bypass'),
  worktreeRoot: path('작업 폴더 위치'),
  repoRoot: path('새 저장소 위치'),
  oracleClientDir: path('Oracle Instant Client 폴더'),
  agentBrowser: oneOf('에이전트의 브라우저 사용', 'ask', 'local', 'off'),
  agentBrowserHosts: (v) => {
    const t = String(v ?? '').trim();
    if (t.length > 2000) throw new Error('허용할 주소: 너무 깁니다.');
    for (const h of t.split(/[\s,]+/).filter(Boolean)) {
      if (!validHost(h)) throw new Error(`허용할 주소: 호스트 이름만 적으세요 (예: staging.example.com). 잘못된 것: ${h}`);
    }
    return t;
  },
  peersEnabled: bool('다른 사람과 연결'),
  peerName: (v) => {
    // eslint-disable-next-line no-control-regex
    const t = String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (t.length > 40 || /[@"]/.test(t)) throw new Error('내 이름: 40자까지이고 @ 와 " 는 쓸 수 없습니다.');
    return t;
  },
  peerPort: int('연결 포트', 1024, 65535),
  claudePath: path('Claude Code 실행 파일'),
  claudeModel: model,
  claudeEffort: oneOf('effort', '', 'low', 'medium', 'high', 'xhigh', 'max'),
  claudeArgs: args('Claude Code 추가 인자', 'claude'),
  codexPath: path('Codex 실행 파일'),
  codexArgs: args('Codex 추가 인자', 'codex'),
  autoTrust: bool('폴더 신뢰 창에 대신 답하기'),
  threadCap: int('대화 하나의 상한', 1, 1000),
  projectCap: int('프로젝트 전체의 상한', 1, 10000),
  autoStartOnMessage: bool('메시지로 에이전트 띄우기'),
  notifyAgentOnCommit: bool('커밋 뒤 에이전트에게 알리기'),
  reviewOnDraft: bool('커밋 초안 리뷰'),
  reviewModel: model,
  notesForAgents: bool('에이전트가 메모 읽기'),
  notesWriteForAgents: bool('에이전트가 메모 쓰기'),
  notifications: bool('알림'),
  workTimeEnabled: bool('근무시간 재기'),
  workGraceMin: int('출근 여유', 0, 29),
  workDayHours: int('하루 근무시간', 0, 24),
  verifyTimeoutSec: int('확인 명령의 시간 제한', 10, 3600),
  openAtLogin: bool('로그인할 때 켜기'),
  workTimeUnit: (v) => { if (v !== 'minute' && v !== 'half') throw new Error('근무시간을 세는 단위가 올바르지 않습니다.'); return v; },
  workWifi: (v) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64),
  terminalFontSize: size('터미널 글자 크기', 9, 28),
  chatFontSize: size('채팅 글자 크기', 10, 28),
};

/** 받아 둔 모델 목록을 두는 자리. 설정 항목이 아니다 */
const MODELS_KEY = '_models';

/** ~/ 로 시작하는 경로를 풀어 준다. */
export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * 두레의 설정. 바꾼 것만 저장하고, 저장되지 않은 것은 기본값이다.
 * 이벤트: 'changed'
 */
export class SettingsService extends EventEmitter {
  private cache: Settings;

  constructor(private readonly db: Database.Database) {
    super();
    this.cache = this.load();
  }

  private load(): Settings {
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const r of rows) {
      if (!(r.key in CHECKS)) continue; // 지금은 없는 옛 설정
      // 저장된 값이 지금의 규칙에 맞지 않으면(손으로 고쳤거나 규칙이 바뀜) 기본값을 쓴다.
      try { out[r.key] = (CHECKS[r.key as keyof Settings] as Check<keyof Settings>)(JSON.parse(r.value)); } catch { /* 기본값 */ }
    }
    return out as unknown as Settings;
  }

  get(): Settings {
    return { ...this.cache };
  }

  /** 주어진 것만 바꾼다. 하나라도 규칙에 맞지 않으면 아무것도 바꾸지 않고 이유를 던진다. */
  update(patch: Partial<Settings>): Settings {
    if (typeof patch !== 'object' || patch === null) throw new Error('바꿀 설정이 없습니다.');
    const clean: Partial<Record<keyof Settings, unknown>> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in CHECKS)) throw new Error(`모르는 설정입니다: ${key}`);
      clean[key as keyof Settings] = (CHECKS[key as keyof Settings] as Check<keyof Settings>)(value);
    }
    const write = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?');
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(clean)) {
        // 기본값과 같으면 저장하지 않는다: 나중에 기본값이 바뀌면 따라간다.
        if (value === DEFAULT_SETTINGS[key as keyof Settings]) remove.run(key);
        else write.run(key, JSON.stringify(value));
      }
    })();
    this.cache = this.load();
    this.emit('changed');
    return this.get();
  }

  /** 마지막으로 받아 둔 모델 목록. 다음에 켰을 때 곧바로 보이게 저장해 둔다 (설정 값이 아니라 받아 온 정보다). */
  savedModels(): ModelChoice[] {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(MODELS_KEY) as { value: string } | undefined;
    if (!r) return [];
    try {
      const list = JSON.parse(r.value) as unknown;
      return Array.isArray(list) ? list.filter((m): m is ModelChoice => typeof m === 'object' && m !== null && typeof (m as ModelChoice).value === 'string' && typeof (m as ModelChoice).name === 'string')
        .map((m) => ({ value: m.value, name: m.name, description: typeof m.description === 'string' ? m.description : '', efforts: Array.isArray(m.efforts) ? m.efforts.filter((e) => typeof e === 'string') : [] })) : [];
    } catch { return []; }
  }

  saveModels(models: ModelChoice[]): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MODELS_KEY, JSON.stringify(models.slice(0, 200)));
  }

  /** 설정 하나를 기본값으로 되돌린다. */
  reset(key: keyof Settings): Settings {
    if (!(key in CHECKS)) throw new Error(`모르는 설정입니다: ${String(key)}`);
    return this.update({ [key]: DEFAULT_SETTINGS[key] } as Partial<Settings>);
  }
}
