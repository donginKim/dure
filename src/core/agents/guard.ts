import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * 권한 단계 "삭제만 묻기" 의 판단.
 * 에이전트가 도구를 쓰기 직전에(PreToolUse hook) 불려, 지우는 일로 보이면 사용자에게 묻게 하고 나머지는 묻지 않고 허용한다.
 *
 * 명령의 글자를 보고 가린다. 빠짐없이 잡지는 못한다: 에이전트가 만든 스크립트 안에서 지우는 것, 처음 보는 도구는 지나간다.
 * 헷갈리면 묻는 쪽으로 기운다. 묻는 것이 한 번 더 뜨는 편이 지워진 것을 되살리는 것보다 싸다.
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

const file = (what: string): string => `파일을 지우는 명령입니다 (${what})`;
const data = (what: string): string => `데이터를 지우는 명령입니다 (${what})`;
const work = (what: string): string => `작업한 것을 되돌릴 수 없게 버리는 명령입니다 (${what})`;

/** 이보다 긴 명령은 가리지 않고 묻는다 (아주 긴 글에 정규식을 돌리다 앱이 멈추지 않게) */
const MAX_COMMAND = 20_000;

/** 명령 낱말의 앞: 조각의 처음, 공백, 괄호, 따옴표 (bash -c "rm …" 안의 것도 본다), 역슬래시(\rm). "--rm" 의 rm 은 걸리지 않는다. */
const BEFORE = '(?:^|[\\s(`\'"=\\\\])(?:[\\w.~/-]*\\/)?';
const AFTER = '(?=$|[\\s)`\'"@\\\\])';
/** 파일을 지우는 명령 낱말 */
const WORD = new RegExp(`${BEFORE}(rm|rmdir|unlink|shred|srm|trash|rimraf|mkfs[\\w.]*)${AFTER}`);
/** 글을 보여 주거나 찾기만 하는 명령: 그 안의 "rm" 은 낱말일 뿐이다 */
const READ_ONLY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'which', 'whereis', 'man', 'type', 'echo', 'printf', 'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat', 'tldr']);
/** 패키지 관리자의 rm/remove 는 의존성을 빼는 것이다 (파일이나 데이터를 지우는 일로 보지 않는다) */
const PACKAGE = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'brew', 'apt', 'apt-get', 'cargo', 'gem', 'go', 'uv', 'poetry', 'conda']);
const WRAPPER = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice', 'xargs', 'then', 'do', 'else', 'builtin', 'npx', 'pnpx', 'bunx']);
/** 한 줄 코드를 돌리는 명령 (python -c, node -e 등). 이 안에서는 remove(…) 처럼 이름만 부른 것도 본다 */
const INLINE = /\b(?:python[\d.]*|node|deno|bun|perl|ruby|php)\b[^\n]*\s-(?:c|e|r|E)\b|\bdeno\s+eval\b/;
const MONGO = /\b(?:mongosh|mongo)\b/;

type Rule = { re: RegExp; why: string | ((m: RegExpExecArray) => string) };
/** 조각(명령 하나)마다 보는 규칙. 데이터를 지우는 것, 파일을 지우는 것의 순서 */
const RULES: Rule[] = [
  // ---- 한 줄 코드로 파일 지우기 (이름이 분명한 것) ----
  { re: /\b(os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|(?:rm|unlink|rmdir)Sync|fs\.(?:rm|unlink|rmdir)|FileUtils\.rm\w*|File\.delete|Remove-Item)\b/, why: (m) => file(m[1]!) },
  { re: /\.(rm|unlink|rmtree|rmdir)\s*\(/, why: (m) => file(`${m[1]}()`) },
  // ---- 데이터 ----
  { re: /\bdelete\s+from\b/i, why: data('DELETE FROM') },
  { re: /\bdrop\s+(materialized\s+view|table|database|schema|index|view|column|collection|user|role|function|procedure|trigger|sequence|type|policy|extension|constraint|owned)\b/i, why: (m) => data(`DROP ${m[1]!.toUpperCase().replace(/\s+/g, ' ')}`) },
  { re: /\balter\s+table\b.*\bdrop\b/i, why: data('ALTER TABLE … DROP') },
  { re: /\btruncate\s+(?:table\s+)?[a-z_"`[]/i, why: data('TRUNCATE') },
  { re: /\.(deleteOne|deleteMany|dropDatabase|findOneAndDelete)\s*\(/, why: (m) => data(`${m[1]}()`) },
  { re: /\b(FLUSHALL|FLUSHDB)\b/i, why: (m) => data(m[1]!.toUpperCase()) },
  { re: /\bredis-cli\b.*\s(?:del|unlink)\b/i, why: data('redis-cli del') },
  { re: new RegExp(`${BEFORE}(dropdb)${AFTER}`), why: data('dropdb') },
  { re: /\bmysqladmin\b.*\sdrop\b/, why: data('mysqladmin drop') },
  { re: /\b(?:db|database)[:\s](drop|reset|wipe)\b/, why: (m) => data(`db ${m[1]}`) },
  { re: /\bmigrate[:\s]+(reset|fresh|refresh)\b/, why: (m) => data(`migrate ${m[1]}`) },
  { re: /\s--force-reset\b/, why: data('--force-reset') },
  { re: /\bmanage\.py\s+flush\b/, why: data('manage.py flush') },
  { re: /\b(docker|podman)\b.*\s(rm|rmi|prune)\b/, why: (m) => data(`${m[1]} ${m[2]}`) },
  { re: /\b(?:docker|podman)(?:\s+|-)compose\b.*\sdown\b.*\s(?:-v|--volumes)\b/, why: data('compose down -v') },
  { re: /\b(kubectl|oc)\b.*\sdelete\b/, why: (m) => data(`${m[1]} delete`) },
  { re: /\bhelm\b.*\s(?:uninstall|delete)\b/, why: data('helm uninstall') },
  { re: /\b(terraform|tofu)\b.*\s-?destroy\b/, why: (m) => data(`${m[1]} destroy`) },
  { re: /\baws\b.*\s(rb|rm|(?:batch-)?(?:delete|remove|terminate)-[\w-]+|--delete)(?=\s|$)/, why: (m) => data(`aws ${m[1]}`) },
  { re: /\b(gcloud|az|gh|heroku|vercel|supabase|firebase|fly|flyctl|netlify)\b.*[\s:](delete|destroy|remove)\b/, why: (m) => data(`${m[1]} ${m[2]}`) },
  { re: /\s(?:-X\s*|--request[=\s]+|--method[=\s]+)DELETE\b/i, why: data('HTTP DELETE') },
  // ---- 파일 ----
  { re: /\bfind\b.*\s-delete\b/, why: file('find -delete') },
  { re: /\brsync\b.*\s--delete/, why: file('rsync --delete') },
  { re: /\bdd\b.*\bof=/, why: file('dd of=') },
  { re: /\btruncate\b.*\s(?:-s\s*0|--size[=\s]0)\b/, why: file('truncate -s 0') },
  { re: /^(?::|true)?\s*>(?!>)\s*\S/, why: file('> 로 내용 비우기') },
  { re: /\b(?:cp|mv)\b.*\s\/dev\/null\b/, why: file('/dev/null') },
];

const GIT = /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+([a-z][\w-]*)\b(.*)$/s;
const has = (rest: string, re: RegExp): boolean => re.test(` ${rest} `);

/** git 명령 하나: 작업한 것을 날리거나 지우는 것이면 이유를, 아니면 null. */
function gitWhy(sub: string, rest: string): string | null {
  switch (sub) {
    case 'clean': return has(rest, /\s(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)\s/) ? null : file('git clean');
    case 'rm': return has(rest, /\s--cached\s/) ? null : file('git rm');
    case 'reset': { const m = /\s--(hard|merge|keep)\s/.exec(` ${rest} `); return m ? work(`git reset --${m[1]}`) : null; }
    case 'checkout': {
      if (has(rest, /\s(?:--|\.|-f|--force|-B|--ours|--theirs|-p|--patch)\s/)) return work('git checkout 으로 고친 것 버리기');
      // 새 브랜치를 만들거나 따라가는 것은 파일을 버리지 않는다.
      if (has(rest, /\s(?:-b|--orphan|-t|--track|--detach|-d)\s/)) return null;
      // git checkout <가지> <경로…>: 그 경로의 고친 것이 덮인다.
      return rest.trim().split(/\s+/).filter((w) => w && !w.startsWith('-')).length >= 2 ? work('git checkout 으로 고친 것 버리기') : null;
    }
    case 'switch': return has(rest, /\s(?:-f|--force|--discard-changes|-C|--force-create)\s/) ? work('git switch 로 고친 것 버리기') : null;
    // 스테이징만 푸는 것(--staged 만 있고 --worktree 가 없다)은 파일을 건드리지 않는다
    case 'restore': return has(rest, /\s(?:--staged|-S)\s/) && !has(rest, /\s(?:--worktree|-W)\s/) ? null : work('git restore');
    case 'branch': return has(rest, /\s(?:-[a-zA-Z]*[dD][a-zA-Z]*|--delete)\s/) ? work('git branch 지우기') : null;
    case 'stash': { const m = /^\s*(drop|clear)\b/.exec(rest); return m ? work(`git stash ${m[1]}`) : null; }
    case 'worktree': { const m = /^\s*(remove|prune)\b/.exec(rest); return m ? work(`git worktree ${m[1]}`) : null; }
    case 'tag': return has(rest, /\s(?:-d|--delete)\s/) ? work('git tag 지우기') : null;
    case 'push': return has(rest, /\s(?:-f|--force(?:-with-lease)?(?:=\S+)?|--delete|-d|--mirror|--prune)\s|\s[:+]\S+\s/) ? work('git push 로 덮어쓰거나 지우기') : null;
    case 'reflog': return /^\s*(?:expire|delete)\b/.test(rest) ? work('git reflog 지우기') : null;
    case 'update-ref': return has(rest, /\s-d\s/) ? work('git update-ref -d') : null;
    case 'filter-branch': case 'filter-repo': return work(`git ${sub}`);
    default: return null;
  }
}

/** 조각의 첫 명령 낱말 (환경 변수, sudo 같은 앞머리, 그 옵션은 건너뛴다). */
function firstWord(segment: string): string {
  let afterWrapper = false;
  for (const raw of segment.trim().replace(/^[({!\s]+/, '').split(/\s+/)) {
    const w = raw.replace(/^\\/, '');
    if (/^\w+=/.test(w)) continue;
    if (afterWrapper && w.startsWith('-')) continue;
    if (WRAPPER.has(basename(w))) { afterWrapper = true; continue; }
    return basename(w);
  }
  return '';
}

function segmentWhy(segment: string, whole: { inline: boolean; mongo: boolean }): string | null {
  for (const rule of RULES) {
    const m = rule.re.exec(segment);
    if (m) return typeof rule.why === 'function' ? rule.why(m) : rule.why;
  }
  if (whole.mongo) { const m = /\.(drop|remove)\s*\(/.exec(segment); if (m) return data(`${m[1]}()`); }
  if (whole.inline) { const m = /(?:^|[^.\w])(remove|unlink|rmtree|rmdir|removedirs)\s*\(/.exec(segment); if (m) return file(`${m[1]}()`); }
  const git = GIT.exec(segment);
  if (git) {
    const why = gitWhy(git[1]!, git[2] ?? '');
    if (why) return why;
  }
  // 파일을 지우는 낱말. 글을 보여 주기만 하는 명령, 패키지 관리자, git 의 것은 보지 않는다 (안에서 다른 명령을 부르지 않을 때).
  const calls = /\$\(|`/.test(segment);
  const first = firstWord(segment);
  if (!calls && (git || READ_ONLY.has(first) || PACKAGE.has(first))) return null;
  const w = WORD.exec(segment);
  return w ? file(w[1]!) : null;
}

function bashDecision(command: string): GuardDecision {
  if (command.length > MAX_COMMAND) return ask('명령이 너무 길어 지우는 일인지 가리지 못했습니다');
  const text = command.replace(/\\\r?\n/g, ' ');
  const whole = { inline: INLINE.test(text), mongo: MONGO.test(text) };
  // 명령을 잇는 기호에서 끊어 하나씩 본다 (따옴표 안에서도 끊긴다: 그 안의 것도 명령으로 본다).
  for (const segment of text.split(/\|\||&&|[;|\n&]/)) {
    const s = segment.trim();
    if (!s) continue;
    const why = segmentWhy(s, whole);
    if (why) return ask(why);
  }
  return ALLOW;
}

/** 있는 데까지 실제 경로로 푼다 (심볼릭 링크를 따라간다). 아직 없는 끝부분은 그대로 붙인다. */
function real(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  try { head = realpathSync(head); } catch { /* 읽을 수 없으면 글자 그대로 */ }
  return tail.length ? join(head, ...tail) : head;
}

const home = (path: string): string => path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');

/** 그 경로가 작업 폴더 안인가 (상대 경로는 작업 폴더에서 본다. 밖을 가리키는 링크는 밖이다). */
function inside(path: string, worktreePath: string): boolean {
  const root = real(worktreePath);
  const full = real(resolve(worktreePath, home(path)));
  return full === root || full.startsWith(root + sep);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** 사용자에게 묻는 도구: 저절로 허용하면 질문이 건너뛰어진다 */
const INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** 읽거나 찾거나 두레·Claude Code 안에서만 도는 도구: 입력을 볼 것 없이 허용한다 */
const HARMLESS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'Agent', 'BashOutput', 'KillShell', 'KillBash',
  'NotebookRead', 'Skill', 'SlashCommand', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const DELETE_WORDS = new Set(['delete', 'remove', 'drop', 'destroy', 'purge', 'trash', 'truncate', 'erase', 'wipe', 'unlink', 'reset', 'flush']);
const WRITE_WORDS = new Set(['write', 'edit', 'create', 'save', 'update', 'move', 'rename', 'append', 'put', 'patch', 'copy', 'upload']);
/** 도구 이름을 낱말로 나눈다 (delete_file, removeItem, drop-collection). "dropdown", "untrash" 는 그 낱말이 아니다. */
const nameWords = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** 명령이나 질의가 든 입력 칸 */
const COMMAND_KEY = /command|cmd|script|shell|code|sql|query|statement|expression/i;

type Found = { commands: string[]; paths: string[] };
/** 모르는 도구(플러그인의 MCP 도구 등)의 입력에서 명령·질의로 보이는 글자와 경로를 모은다. */
function scan(input: unknown, depth = 0, key = '', out: Found = { commands: [], paths: [] }): Found {
  if (depth > 3 || out.commands.length + out.paths.length > 50) return out;
  if (typeof input === 'string') {
    if (COMMAND_KEY.test(key)) out.commands.push(input);
    else if (/^(?:\/|~\/)/.test(input) && input.length < 1000) out.paths.push(input);
  } else if (Array.isArray(input)) { for (const v of input.slice(0, 50)) scan(v, depth + 1, key, out); }
  else if (isObj(input)) { for (const [k, v] of Object.entries(input).slice(0, 50)) scan(v, depth + 1, k, out); }
  return out;
}

/**
 * 승인 창에 보일 "왜 묻는지". 삭제만 묻기에서 지우는 일로 보여 물은 것이면 그 이유, 아니면 undefined.
 * 승인 창이 아는 것(도구 이름과 화면에 보이는 입력: Bash 는 명령 그대로)만으로 다시 가린다.
 */
export function guardPromptReason(tool: string, shownInput: string): string | undefined {
  const d = tool === 'Bash' ? (shownInput.trim() ? bashDecision(shownInput) : PASS) : FILE_TOOLS.has(tool) ? PASS : guardDecision(tool, {}, '/');
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
  if (HARMLESS.has(name)) return ALLOW;
  // 모르는 도구 (플러그인이 붙인 MCP 도구 등): 이름과, 입력에 든 명령·질의를 본다.
  const words = nameWords(name.replace(/^mcp__.*?__/, ''));
  if (words.some((w) => DELETE_WORDS.has(w))) return ask(`이름이 지우는 일로 보이는 도구입니다 (${name})`);
  const found = scan(input);
  for (const command of found.commands) {
    const d = bashDecision(command);
    if (d.decision === 'ask') return d;
  }
  // 쓰는 도구가 작업 폴더 밖의 경로를 가리키면 평소 승인에 맡긴다.
  if (words.some((w) => WRITE_WORDS.has(w)) && found.paths.some((p) => !inside(p, worktreePath))) return PASS;
  return ALLOW;
}
