import { resolve, sep } from 'node:path';

/**
 * 권한 단계 "삭제만 묻기" 의 판단.
 * 에이전트가 도구를 쓰기 직전에(PreToolUse hook) 불려, 지우는 일로 보이면 사용자에게 묻게 하고 나머지는 묻지 않고 허용한다.
 *
 * 명령의 글자를 보고 가린다. 빠짐없이 잡지는 못한다: 에이전트가 만든 스크립트 안에서 지우는 것, 처음 보는 도구는 지나간다.
 * 헷갈리면 묻는 쪽으로 기운다 (예: 글 안에 든 "rm" 도 묻는다). 묻는 것이 한 번 더 뜨는 편이 지워진 것을 되살리는 것보다 싸다.
 */
export type GuardDecision =
  /** 묻지 않고 허용한다 */
  | { decision: 'allow'; reason?: undefined }
  /** 사용자에게 묻는다. reason 은 승인 창에 보일 말 */
  | { decision: 'ask'; reason: string }
  /** 답하지 않는다: Claude Code 의 평소 승인에 맡긴다 */
  | { decision: 'pass'; reason?: undefined };

const ALLOW: GuardDecision = { decision: 'allow' };
const PASS: GuardDecision = { decision: 'pass' };
const ask = (reason: string): GuardDecision => ({ decision: 'ask', reason });

// 한 명령(;, &&, |, 줄바꿈으로 끊기기 전)의 나머지
const SEG = '[^;&|\\n]*';
// 명령 낱말의 앞: 줄의 처음, 공백, 명령을 잇는 기호, 따옴표 (bash -c "rm …" 안의 것도 본다). "--rm" 의 rm 은 걸리지 않는다.
const BEFORE = '(?:^|[\\s;&|(`\'"=])(?:[\\w.~/-]*\\/)?';
const AFTER = '(?=$|[\\s;&|)`\'"])';
// git 과 하위 명령 사이의 옵션 (-C 경로, -c 설정, --no-pager 등)
const GIT = '\\bgit(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--[\\w-]+(?:=\\S+)?))*\\s+';

type Rule = { re: RegExp; why: string | ((m: RegExpExecArray) => string | null) };
const file = (what: string): string => `파일을 지우는 명령입니다 (${what})`;
const data = (what: string): string => `데이터를 지우는 명령입니다 (${what})`;
const work = (what: string): string => `작업한 것을 되돌릴 수 없게 버리는 명령입니다 (${what})`;

const RULES: Rule[] = [
  // ---- 데이터 ----
  { re: /\bdelete\s+from\b/i, why: data('DELETE FROM') },
  { re: /\bdrop\s+(table|database|schema|index|view|column|collection|user|role)\b/i, why: (m) => data(`DROP ${m[1]!.toUpperCase()}`) },
  { re: /\balter\s+table\b[^;]*\bdrop\b/i, why: data('ALTER TABLE … DROP') },
  { re: /\btruncate\s+(?:table\s+)?\w/i, why: data('TRUNCATE') },
  { re: /\.(deleteOne|deleteMany|drop|dropDatabase|findOneAndDelete|remove)\s*\(/, why: (m) => data(`${m[1]}()`) },
  { re: /\b(FLUSHALL|FLUSHDB)\b/i, why: (m) => data(m[1]!.toUpperCase()) },
  { re: new RegExp(`\\bredis-cli\\b${SEG}\\s(del|unlink)\\b`, 'i'), why: data('redis-cli del') },
  { re: new RegExp(`${BEFORE}(dropdb)${AFTER}`), why: data('dropdb') },
  { re: new RegExp(`\\b(docker|podman)\\b${SEG}\\s(rmi|prune)\\b`), why: (m) => data(`${m[1]} ${m[2]}`) },
  { re: new RegExp(`\\b(?:docker|podman)(?:\\s+|-)compose\\b${SEG}\\sdown\\b${SEG}\\s(?:-v|--volumes)\\b`), why: data('compose down -v') },
  { re: new RegExp(`\\b(kubectl|oc)\\b${SEG}\\sdelete\\b`), why: (m) => data(`${m[1]} delete`) },
  { re: new RegExp(`\\bhelm\\b${SEG}\\s(uninstall|delete)\\b`), why: data('helm uninstall') },
  { re: new RegExp(`\\b(terraform|tofu)\\b${SEG}\\s-?destroy\\b`), why: (m) => data(`${m[1]} destroy`) },
  { re: new RegExp(`\\baws\\b${SEG}\\s((?:delete|remove|terminate)-[\\w-]+)`), why: (m) => data(`aws ${m[1]}`) },
  { re: new RegExp(`\\b(gcloud|az|gh|heroku|vercel|supabase|firebase)\\b${SEG}\\s(delete|destroy|remove)\\b`), why: (m) => data(`${m[1]} ${m[2]}`) },
  // ---- 작업한 것을 버리는 git ----
  { re: new RegExp(`${GIT}reset\\b${SEG}--hard\\b`), why: work('git reset --hard') },
  { re: new RegExp(`${GIT}checkout\\b${SEG}(?:\\s--(?:\\s|$)|\\s\\.(?:\\s|$)|\\s(?:-f|--force)\\b)`), why: work('git checkout 으로 고친 것 버리기') },
  // 스테이징만 푸는 것(--staged 만 있고 --worktree 가 없다)은 파일을 건드리지 않는다
  { re: new RegExp(`${GIT}restore\\b(${SEG})`), why: (m) => (/\s(?:--staged|-S)\b/.test(m[1]!) && !/\s(?:--worktree|-W)\b/.test(m[1]!) ? null : work('git restore')) },
  { re: new RegExp(`${GIT}branch\\b${SEG}\\s(?:-[a-zA-Z]*[dD][a-zA-Z]*|--delete)(?=\\s|$)`), why: work('git branch 지우기') },
  { re: new RegExp(`${GIT}stash\\s+(drop|clear)\\b`), why: (m) => work(`git stash ${m[1]}`) },
  { re: new RegExp(`${GIT}worktree\\s+(remove|prune)\\b`), why: (m) => work(`git worktree ${m[1]}`) },
  { re: new RegExp(`${GIT}tag\\b${SEG}\\s(?:-d|--delete)(?=\\s|$)`), why: work('git tag 지우기') },
  { re: new RegExp(`${GIT}push\\b${SEG}(?:\\s(?:-f|--force(?:-with-lease)?|--delete|-d)(?=\\s|$|=)|\\s:\\S+)`), why: work('git push 로 덮어쓰거나 지우기') },
  // ---- 파일 ----
  { re: new RegExp(`${GIT}clean\\b`), why: file('git clean') },
  { re: new RegExp(`\\bfind\\b${SEG}\\s-delete\\b`), why: file('find -delete') },
  { re: new RegExp(`\\brsync\\b${SEG}\\s--delete`), why: file('rsync --delete') },
  { re: new RegExp(`\\bdd\\b${SEG}\\bof=`), why: file('dd of=') },
  { re: /\b(os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|(?:rm|unlink|rmdir)Sync|fs\.(?:rm|unlink|rmdir)|FileUtils\.rm\w*|File\.delete|Remove-Item)\b/, why: (m) => file(m[1]!) },
  { re: /\.unlink\(/, why: file('unlink()') },
  { re: new RegExp(`${BEFORE}(rm|rmdir|unlink|shred|srm|trash|rimraf|mkfs[\\w.]*)${AFTER}`), why: (m) => file(m[1]!) },
];

function bashDecision(command: string): GuardDecision {
  for (const rule of RULES) {
    const m = rule.re.exec(command);
    if (!m) continue;
    const why = typeof rule.why === 'function' ? rule.why(m) : rule.why;
    if (why) return ask(why);
  }
  return ALLOW;
}

/** 그 경로가 작업 폴더 안인가 (상대 경로는 작업 폴더에서 본다). */
function inside(path: string, worktreePath: string): boolean {
  const root = resolve(worktreePath);
  const full = resolve(root, path);
  return full === root || full.startsWith(root + sep);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** 사용자에게 묻는 도구: 저절로 허용하면 질문이 건너뛰어진다 */
const INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** 도구 이름이 지우는 일로 보이는가 (플러그인이 붙인 MCP 도구 등) */
const DELETE_NAME = /(?:^|[_\-.]|[a-z](?=[A-Z]))(delete|remove|drop|destroy|purge|trash|truncate|erase|wipe|unlink)/i;

/**
 * 승인 창에 보일 "왜 묻는지". 삭제만 묻기에서 지우는 일로 보여 물은 것이면 그 이유, 아니면 undefined.
 * 승인 창이 아는 것(도구 이름과 화면에 보이는 입력: Bash 는 명령 그대로)만으로 다시 가린다.
 */
export function guardPromptReason(tool: string, shownInput: string): string | undefined {
  const d = tool === 'Bash' ? (shownInput.trim() ? bashDecision(shownInput) : PASS) : DELETE_NAME.test(tool) ? guardDecision(tool, {}, '/') : PASS;
  return d.decision === 'ask' ? `삭제만 묻기: ${d.reason}` : undefined;
}

export function guardDecision(tool: string, input: unknown, worktreePath: string): GuardDecision {
  const name = String(tool ?? '');
  // 두레의 도구는 이미 허용돼 있고, 두레가 스스로 묻는 것(DB 조회 등)은 두레 화면에서 따로 묻는다.
  if (name.startsWith('mcp__dure__') || INTERACTIVE.has(name)) return PASS;
  if (name === 'Bash') {
    const command = isObj(input) ? input.command : undefined;
    return typeof command === 'string' && command.trim() ? bashDecision(command) : PASS;
  }
  if (FILE_TOOLS.has(name)) {
    const path = isObj(input) ? (input.file_path ?? input.notebook_path) : undefined;
    if (typeof path !== 'string' || !path) return PASS;
    if (name === 'NotebookEdit' && isObj(input) && input.edit_mode === 'delete') return ask('노트북의 칸을 지웁니다');
    // 작업 폴더 밖의 파일은 평소 승인에 맡긴다: 사용자의 다른 폴더가 묻지 않고 바뀌지 않게 한다.
    return inside(path, worktreePath) ? ALLOW : PASS;
  }
  const hit = DELETE_NAME.exec(name);
  if (hit) return ask(`이름이 지우는 일로 보이는 도구입니다 (${name})`);
  return ALLOW;
}
