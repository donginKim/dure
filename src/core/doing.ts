import { EventEmitter } from 'node:events';

const short = (s: unknown, n = 60): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const base = (p: unknown): string => short(String(p ?? '').split('/').pop(), 50);

/** 도구 사용 하나를 사람이 읽는 짧은 말로 (사이드바에 한 줄로 보인다). 입력의 값은 앞부분만 쓴다. */
export function describeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'Read': return `읽는 중: ${base(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `고치는 중: ${base(i.file_path)}`;
    case 'Write': return `쓰는 중: ${base(i.file_path)}`;
    case 'NotebookEdit': return `고치는 중: ${base(i.notebook_path)}`;
    case 'Bash': return `명령: ${short(i.description || i.command, 50)}`;
    case 'Grep': return `찾는 중: ${short(i.pattern, 40)}`;
    case 'Glob': return `파일 찾는 중: ${short(i.pattern, 40)}`;
    case 'WebFetch': case 'WebSearch': return `웹 보는 중: ${short(i.url ?? i.query, 40)}`;
    case 'Task': case 'Agent': return `하위 에이전트: ${short(i.description, 40)}`;
    case 'TodoWrite': return 'TODO 정리';
    default:
      if (name.startsWith('mcp__dure__')) return `두레: ${name.slice('mcp__dure__'.length)}`;
      return short(name, 40);
  }
}

/**
 * 워크스페이스마다 지금 하는 일 (마지막 도구 사용). 기록하지 않는다: 메모리에만 두고, 쉬거나 멈추면 지운다.
 * 이벤트: 'changed' (너무 자주 나지 않게 0.8초에 한 번까지)
 */
export class DoingService extends EventEmitter {
  private readonly now = new Map<string, { text: string; at: number }>();
  private timer: NodeJS.Timeout | undefined;

  note(workspaceId: string, event: string, payload: unknown): void {
    if (event === 'PreToolUse') {
      const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
      const text = describeTool(String(p.tool_name ?? ''), p.tool_input);
      if (!text) return;
      this.now.set(workspaceId, { text, at: Date.now() });
      this.soon();
    } else if (event === 'Stop' || event === 'SessionStart' || event === 'SessionEnd') {
      if (this.now.delete(workspaceId)) this.soon();
    }
  }

  clear(workspaceId: string): void { if (this.now.delete(workspaceId)) this.soon(); }

  all(): Record<string, { text: string; at: number }> { return Object.fromEntries(this.now); }

  private soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.emit('changed'); }, 800);
    this.timer.unref?.();
  }

  dispose(): void { clearTimeout(this.timer); }
}
