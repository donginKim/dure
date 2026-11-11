import type { ChatItem, ChatStep, Message, SlashCommand } from '@shared/types';

// ---- 마크다운: 글자만으로 그릴 조각으로 나눈다. HTML 로 해석하지 않는다. ----

export type Block =
  | { type: 'p'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: { text: string; depth: number }[] }
  | { type: 'heading'; level: number; text: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'rule' };

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function toBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = (): void => { if (para.length) { out.push({ type: 'p', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      // 닫히지 않은 코드 블록(쓰는 중이거나 잘린 글)은 끝까지 코드로 본다.
      while (i < lines.length && !(FENCE.test(lines[i]!) && lines[i]!.trim().startsWith(fence[1]!) && lines[i]!.trim().length === fence[1]!.length)) body.push(lines[i++]!);
      out.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); out.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() }); continue; }
    if (RULE.test(line)) { flush(); out.push({ type: 'rule' }); continue; }
    // 구분 줄 판정은 긴 줄에서 느리다. 표의 구분 줄은 짧다.
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]!.length < 400 && lines[i + 1]!.includes('-') && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      i--;
      out.push({ type: 'table', rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]!);
      const items: { text: string; depth: number }[] = [];
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]!);
        if (m) items.push({ text: m[3]!, depth: Math.min(4, Math.floor(m[1]!.replace(/\t/g, '  ').length / 2)) });
        else if (lines[i]!.trim() && /^\s+/.test(lines[i]!) && items.length) items[items.length - 1]!.text += `\n${lines[i]!.trim()}`; // 이어지는 줄
        else break;
      }
      i--;
      out.push({ type: 'list', ordered, items });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

export interface Inline { text: string; code?: boolean; bold?: boolean }

/** `코드` 와 **굵게** 만 가린다. 짝이 맞지 않는 표시는 글자 그대로 둔다. */
export function toInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (t: string, extra: Partial<Inline> = {}): void => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && !last.code && !extra.code && Boolean(last.bold) === Boolean(extra.bold)) last.text += t;
    else out.push({ text: t, ...extra });
  };
  let bold = false;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) { out.push({ text: text.slice(i + 1, end), code: true, ...(bold ? { bold: true } : {}) }); i = end + 1; continue; }
    }
    if (text.startsWith('**', i)) {
      if (bold) { bold = false; i += 2; continue; }
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) { bold = true; i += 2; continue; }
    }
    push(text[i]!, bold ? { bold: true } : {});
    i++;
  }
  return out;
}

// ---- 단계 묶음의 문구 ----

type Category = 'cmd' | 'look' | 'edit' | 'dure' | 'other';
function category(tool: string): Category {
  if (tool === 'Bash') return 'cmd';
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return 'look';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'edit';
  if (tool.startsWith('mcp__dure__')) return 'dure';
  return 'other';
}
const WORDS: Record<Category, [noun: string, done: string, doing: string]> = {
  cmd: ['명령', '실행함', '실행 중…'],
  look: ['파일', '살펴봄', '살펴보는 중…'],
  edit: ['파일', '고침', '고치는 중…'],
  dure: ['두레 작업', '함', '하는 중…'],
  other: ['작업', '함', '하는 중…'],
};

export function stepsRunning(steps: ChatStep[]): boolean {
  return steps.some((s) => s.status === 'running');
}

/** "명령 3개 실행함", "파일 2개 살펴보는 중…" 같은 한 줄 */
export function stepsLabel(steps: ChatStep[]): string {
  const running = stepsRunning(steps);
  const cats = new Set(steps.map((s) => category(s.tool)));
  const cat: Category = cats.size === 1 ? [...cats][0]! : 'other';
  // 두레 작업 하나는 무엇을 했는지가 곧 요약이다 ("TODO 추가", "메시지 보냄").
  if (steps.length === 1 && cat === 'dure') return running ? `${steps[0]!.summary} 중…` : steps[0]!.summary;
  const [noun, done, doing] = WORDS[cat];
  return `${noun} ${steps.length}개 ${running ? doing : done}`;
}

export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

// ---- 에이전트 간 메시지를 대화 흐름에 끼우기 ----

export type PeerEntry = {
  kind: 'peer'; id: string; at: number; direction: 'sent' | 'received'; message: Message;
  /** 아직 받는 쪽에 전달되지 않았다 */
  pending: boolean;
};
export type Entry = ChatItem | PeerEntry;

const THREAD_IN_TITLE = /\(스레드 ([0-9a-f-]{8,})\)\s*$/;
const quoted = (text: string): string => text.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^> ?/, '')).join('\n');

/**
 * 대화 항목과 이 워크스페이스가 주고받은 메시지를 한 흐름으로 합친다.
 * - 받은 메시지: 두레가 그 메시지를 전달한 자리(dure 항목)에 카드로 놓는다. 그 자리를 못 찾으면 전달된 시각으로 끼운다.
 * - 보낸 메시지: 보낸 시각으로 끼운다.
 * - 지금 대화가 시작되기 전에 오간 메시지는 넣지 않는다 (지금 대화만 보여준다).
 */
export function mergeEntries(items: ChatItem[], messages: Message[], workspaceId: string): Entry[] {
  const received = messages.filter((m) => m.toWorkspaceId === workspaceId && !m.failed).sort((a, b) => a.createdAt - b.createdAt);
  const sent = messages.filter((m) => m.from.kind === 'workspace' && m.from.workspaceId === workspaceId).sort((a, b) => a.createdAt - b.createdAt);
  const placed = new Set<string>();
  const peer = (m: Message, direction: 'sent' | 'received', at: number): PeerEntry =>
    ({ kind: 'peer', id: `peer:${m.id}`, at, direction, message: m, pending: m.deliveredAt === null && !m.failed });

  const base: Entry[] = items.map((item) => {
    if (item.kind !== 'dure') return item;
    const thread = THREAD_IN_TITLE.exec(item.title)?.[1];
    if (!thread) return item;
    const candidates = received.filter((m) => m.threadId === thread && !placed.has(m.id));
    const body = quoted(item.text);
    const hit = candidates.find((m) => m.body.trim() === body.trim()) ?? candidates.find((m) => m.deliveredAt !== null);
    if (!hit) return item;
    placed.add(hit.id);
    return peer(hit, 'received', item.at);
  });

  const start = items[0]?.at ?? Infinity;
  const extras: PeerEntry[] = [
    ...received.filter((m) => !placed.has(m.id) && m.deliveredAt !== null && m.deliveredAt >= start).map((m) => peer(m, 'received', m.deliveredAt!)),
    ...sent.filter((m) => m.createdAt >= start).map((m) => peer(m, 'sent', m.createdAt)),
  ].sort((a, b) => a.at - b.at);
  for (const extra of extras) {
    let index = -1;
    base.forEach((e, i) => { if (e.at <= extra.at) index = i; });
    base.splice(index + 1, 0, extra);
  }
  // 아직 전달되지 않은 받은 메시지는 맨 끝에 "전달 대기" 로 보인다.
  for (const m of received) if (!placed.has(m.id) && m.deliveredAt === null) base.push(peer(m, 'received', m.createdAt));
  return base;
}

// ---- 보기 전환 기억 ----

export type ViewMode = 'terminal' | 'chat';
const viewKey = (workspaceId: string): string => `dure.view.${workspaceId}`;

/** 기억해 둔 보기. 고른 적이 없으면 fallback (채팅 방식의 워크스페이스는 채팅, 터미널 방식은 터미널). */
export function recallView(workspaceId: string, storage: Pick<Storage, 'getItem'> | undefined, fallback: ViewMode = 'terminal'): ViewMode {
  try {
    const v = storage?.getItem(viewKey(workspaceId));
    return v === 'chat' || v === 'terminal' ? v : fallback;
  } catch { return fallback; }
}

export function rememberView(workspaceId: string, mode: ViewMode, storage: Pick<Storage, 'setItem'> | undefined): void {
  try { storage?.setItem(viewKey(workspaceId), mode); } catch { /* 저장소를 못 쓰면 기억하지 않는다 */ }
}

// ---- 슬래시 명령 고르기 ----

/**
 * 입력창에 "/" 로 시작하는 한 낱말을 치는 중이면 맞는 명령을 돌려준다. 그 밖에는 빈 배열.
 * 이름이 그 글자로 시작하는 것이 먼저, 이름 안에 든 것이 그 뒤다.
 */
export function matchCommands(draft: string, commands: SlashCommand[], limit = 8): SlashCommand[] {
  const m = /^\/(\S*)$/.exec(draft);
  if (!m) return [];
  const q = m[1]!.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}
