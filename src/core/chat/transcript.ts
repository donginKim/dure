// Claude Code 가 쓰는 대화 기록 파일(JSONL)의 한 줄을 채팅 보기가 쓸 조각으로 바꾼다.
// 형식은 Claude Code 내부의 것이다 (실험 14, 2.1.322 에서 확인). 모르는 줄은 조용히 건너뛴다.

export type Piece =
  | { type: 'prompt'; id: string; at: number; text: string; from: 'user' | 'dure' }
  | { type: 'text'; id: string; at: number; text: string }
  | { type: 'tool-start'; id: string; at: number; tool: string; input: unknown }
  | { type: 'tool-end'; id: string; at: number; output: string; error: boolean; denied: boolean }
  /** hook 이 넣은 글 */
  | { type: 'hook-context'; id: string; at: number; text: string }
  /** 슬래시 명령이 낸 출력 */
  | { type: 'command-output'; id: string; at: number; text: string }
  | { type: 'interrupted'; id: string; at: number }
  | { type: 'compacted'; id: string; at: number };

export const DURE_PREFIX = '[두레]';
export const MAX_RAW = 20_000;
/** 작업 중에 채팅으로 보낸 글을 두레가 hook 으로 전달할 때 붙이는 머리줄 */
export const CHAT_RELAY_TITLE = '사용자가 채팅으로 보낸 말이다. 하던 일에 반영하라:';

/** 채팅으로 보낸 글을 에이전트에게 전달할 글로 만든다. 본문은 줄마다 인용해 [두레] 머리줄을 흉내 낼 수 없게 한다. */
export function formatChatRelay(texts: string[]): string {
  return texts.map((t) => [`${DURE_PREFIX} ${CHAT_RELAY_TITLE}`, ...t.split('\n').map((l) => `> ${l}`)].join('\n')).join('\n\n');
}

/** 긴 글을 자르고 얼마나 뺐는지 붙인다. */
export function clip(text: string, max = MAX_RAW): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max}자 생략)`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 붙여 넣은 글을 감싸는 표시를 벗긴다 (실험 13, 14: 여러 줄을 붙여 넣으면 감싸여 오기도 한다). */
export function unwrapPasted(text: string): string {
  return text.replace(/<pasted_content[^>]*>\n?/g, '').replace(/\n?<\/pasted_content>/g, '').trim();
}

// 사용자가 친 글이 아니라 Claude Code 가 사용자 자리에 적는 글 (슬래시 명령의 흔적, 백그라운드 작업 알림 등)
const SYSTEM_TEXT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|bash-input|bash-stdout|bash-stderr)\b/;
const INTERRUPTED = /^\[Request interrupted by user/;
const STOP_FEEDBACK = /^Stop hook feedback:\n/;

const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_STDOUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g;

/**
 * 슬래시 명령의 흔적 (실험 16). 명령 줄은 사용자가 친 것이므로 프롬프트로, 출력은 따로 낸다.
 * 명령은 hook 을 하나도 부르지 않아, 이 줄들이 채팅에 보이는 유일한 흔적이다.
 */
function localCommand(id: string, at: number, raw: string): Piece[] | null {
  const name = COMMAND_NAME.exec(raw);
  if (name?.[1]) {
    const args = (COMMAND_ARGS.exec(raw)?.[1] ?? '').trim();
    const command = name[1].startsWith('/') ? name[1] : `/${name[1]}`;
    return [{ type: 'prompt', id, at, text: args ? `${command} ${args}` : command, from: 'user' }];
  }
  const out = COMMAND_STDOUT.exec(raw);
  if (out) {
    const text = out[1]!.replace(ANSI, '').trim();
    return text ? [{ type: 'command-output', id, at, text: clip(text) }] : [];
  }
  return null;
}

function promptPiece(id: string, at: number, raw: string): Piece[] {
  const command = localCommand(id, at, raw);
  if (command) return command;
  if (SYSTEM_TEXT.test(raw)) return [];
  const text = unwrapPasted(raw);
  if (!text) return [];
  if (INTERRUPTED.test(text)) return [{ type: 'interrupted', id, at }];
  return [{ type: 'prompt', id, at, text, from: text.startsWith(DURE_PREFIX) ? 'dure' : 'user' }];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isObj(b) && b.type === 'text' ? str(b.text) : isObj(b) && b.type === 'image' ? '[이미지]' : '')).filter(Boolean).join('\n');
}

function fromUser(row: Obj, id: string, at: number): Piece[] {
  const content = isObj(row.message) ? row.message.content : undefined;
  // 압축 요약 글은 보여주지 않는다. 압축됐다는 사실은 system/compact_boundary 줄로 안다 (실험 14b).
  if (row.isCompactSummary === true) return [];
  if (typeof content === 'string') {
    // hook 이 멈춤을 막으며 준 글은 attachment(hook_blocking_error) 로도 기록된다. 그쪽을 쓴다.
    if (row.isMeta === true || STOP_FEEDBACK.test(content)) return [];
    return promptPiece(id, at, content);
  }
  if (!Array.isArray(content)) return [];
  if (row.isMeta === true) return [];
  const out: Piece[] = [];
  const texts: string[] = [];
  content.forEach((b, i) => {
    if (!isObj(b)) return;
    if (b.type === 'tool_result') {
      const denied = row.toolDenialKind !== undefined || row.toolUseResult === 'User rejected tool use';
      out.push({ type: 'tool-end', id: str(b.tool_use_id), at, output: clip(resultText(b.content)), error: b.is_error === true && !denied, denied });
    } else if (b.type === 'text') {
      const t = str(b.text);
      if (INTERRUPTED.test(t)) out.push({ type: 'interrupted', id: `${id}:${i}`, at });
      else texts.push(t);
    } else if (b.type === 'image') texts.push('[이미지]');
  });
  if (texts.length) out.push(...promptPiece(id, at, texts.join('\n')));
  return out;
}

function fromAssistant(row: Obj, id: string, at: number): Piece[] {
  const content = isObj(row.message) ? row.message.content : undefined;
  if (!Array.isArray(content)) return [];
  const out: Piece[] = [];
  content.forEach((b, i) => {
    if (!isObj(b)) return;
    if (b.type === 'text' && str(b.text).trim()) out.push({ type: 'text', id: `${id}:${i}`, at, text: str(b.text) });
    else if (b.type === 'tool_use' && str(b.id)) out.push({ type: 'tool-start', id: str(b.id), at, tool: str(b.name), input: b.input });
  });
  return out;
}

function fromAttachment(row: Obj, id: string, at: number): Piece[] {
  const a = row.attachment;
  if (!isObj(a)) return [];
  if (a.type === 'hook_additional_context') {
    // 한 줄에 여러 hook 의 글이 함께 담긴다 (예: 다른 도구의 SessionStart 글과 두레의 글). 하나씩 낸다.
    const parts = Array.isArray(a.content) ? a.content.map(str) : [str(a.content)];
    return parts.flatMap((text, i): Piece[] => (text ? [{ type: 'hook-context', id: `${id}:${i}`, at, text }] : []));
  }
  if (a.type === 'hook_blocking_error') {
    const text = isObj(a.blockingError) ? str(a.blockingError.blockingError) : '';
    return text ? [{ type: 'hook-context', id, at, text }] : [];
  }
  // 작업 중에 사용자가 보낸 글: 따로 user 줄이 생기지 않고 이 줄로만 남는다 (실험 14).
  if (a.type === 'queued_command' && (a.commandMode === undefined || a.commandMode === 'prompt')) {
    const typedAt = Date.parse(str(a.timestamp));
    return promptPiece(id, Number.isFinite(typedAt) ? typedAt : at, str(a.prompt));
  }
  return [];
}

/** 기록 파일의 한 줄을 조각들로. 모르는 줄, 깨진 줄, 하위 에이전트의 줄은 빈 배열. 던지지 않는다. */
export function parseLine(line: string): Piece[] {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return []; }
  if (!isObj(row) || row.isSidechain === true) return [];
  const id = str(row.uuid);
  const at = Date.parse(str(row.timestamp));
  if (!id || !Number.isFinite(at)) return [];
  try {
    switch (row.type) {
      case 'user': return fromUser(row, id, at);
      case 'assistant': return fromAssistant(row, id, at);
      case 'attachment': return fromAttachment(row, id, at);
      case 'system':
        if (row.subtype === 'compact_boundary') return [{ type: 'compacted', id, at }];
        if (row.subtype === 'local_command') return localCommand(id, at, str(row.content)) ?? [];
        return [];
      default: return [];
    }
  } catch { return []; }
}

const DURE_TOOLS: Record<string, string> = {
  workspace_whoami: '내 워크스페이스 확인', project_overview: '프로젝트 구성 확인',
  todo_list: 'TODO 확인', todo_add: 'TODO 추가', todo_update: 'TODO 수정', todo_remove: 'TODO 삭제',
  message_send: '메시지 보냄', message_inbox: '받은 메시지 확인', thread_read: '대화 읽음',
  artifact_publish: '자료 올림', artifact_list: '자료 목록 확인', artifact_read: '자료 읽음',
  commit_draft_save: '커밋 메시지 저장',
  cleanup_stash: '정리 대기로 옮김', cleanup_list: '정리 대기 확인',
  db_list: 'DB 연결 확인', db_tables: 'DB 표 목록 확인', db_columns: 'DB 스키마 확인', db_query: 'DB 조회', db_result: 'DB 조회 결과 받음',
  plan_propose: '계획안 올림', todo_assign: 'TODO 배정',
};

const fileName = (p: unknown): string => str(p).split('/').pop() || str(p);
const firstLine = (s: string, max = 80): string => {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** 도구 호출을 한 줄로. */
export function stepSummary(tool: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  switch (tool) {
    case 'Bash': return firstLine(str(i.command)) || 'Bash';
    case 'Read': return `${fileName(i.file_path)} 읽음`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `${fileName(i.file_path ?? i.notebook_path)} 수정`;
    case 'Write': return `${fileName(i.file_path)} 씀`;
    case 'Grep': return `"${firstLine(str(i.pattern), 60)}" 찾음`;
    case 'Glob': return `${firstLine(str(i.pattern), 60)} 파일 찾음`;
    case 'WebFetch': return `${firstLine(str(i.url), 70)} 읽음`;
    case 'WebSearch': return `"${firstLine(str(i.query), 60)}" 검색`;
    case 'Task': case 'Agent': return `하위 에이전트: ${firstLine(str(i.description), 60)}`;
    default: {
      const dure = /^mcp__dure__(.+)$/.exec(tool);
      if (dure) return DURE_TOOLS[dure[1]!] ?? `두레: ${dure[1]}`;
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      return mcp ? `${mcp[1]}: ${mcp[2]}` : tool;
    }
  }
}

/** 도구 입력을 펼쳐 보일 글로. */
export function stepInput(tool: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const lines = (prefix: string, s: unknown): string => str(s).split('\n').map((l) => prefix + l).join('\n');
  switch (tool) {
    case 'Bash': return clip(str(i.command));
    case 'Read': return str(i.file_path);
    case 'Edit': return clip(`${str(i.file_path)}\n${lines('- ', i.old_string)}\n${lines('+ ', i.new_string)}`);
    case 'Write': return clip(`${str(i.file_path)}\n${str(i.content)}`);
    default: {
      try { return clip(JSON.stringify(input ?? {}, null, 2)); } catch { return ''; }
    }
  }
}
