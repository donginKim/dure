import type { ChatItem, ChatStep } from '@shared/types';
import { CHAT_RELAY_TITLE, DURE_PREFIX, stepInput, stepSummary, type Piece } from './transcript';

const MAX_KEPT = 1500;
const TRIM = 500;
const COMPACTED = '대화가 압축됨. 이 위의 내용은 에이전트가 요약해서 기억합니다.';

/** 조각을 차례로 받아 대화 항목 목록을 유지한다. */
export class Timeline {
  private list: ChatItem[] = [];
  private seen = new Set<string>();
  private steps = new Map<string, ChatStep>();
  /** 도구 호출을 이어 붙일 묶음. 글이나 프롬프트가 나오면 끝난다. */
  private open: Extract<ChatItem, { kind: 'steps' }> | null = null;
  /** 항목이 바뀔 때마다 오른다 */
  version = 0;
  /** 너무 오래되어 버린 항목 수 */
  dropped = 0;

  push(pieces: Piece[]): void {
    for (const p of pieces) {
      const key = `${p.type}:${p.id}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.version++;
      this.apply(p);
    }
  }

  private add(item: ChatItem): void {
    this.list.push(item);
    this.open = item.kind === 'steps' ? item : null;
    // 아주 긴 대화에서 메모리가 끝없이 늘지 않게 오래된 항목은 버린다 (터미널 보기에는 남아 있다).
    if (this.list.length > MAX_KEPT + TRIM) {
      for (const old of this.list.splice(0, TRIM)) {
        if (old.kind === 'steps') for (const st of old.steps) this.steps.delete(st.id);
      }
      this.dropped += TRIM;
    }
  }

  private apply(p: Piece): void {
    switch (p.type) {
      case 'prompt':
        if (p.from === 'dure') this.addDure(p.id, p.at, p.text);
        else this.add({ kind: 'user', id: p.id, at: p.at, text: p.text });
        return;
      case 'text':
        this.add({ kind: 'assistant', id: p.id, at: p.at, text: p.text });
        return;
      case 'tool-start': {
        const step: ChatStep = {
          id: p.id, tool: p.tool, summary: stepSummary(p.tool, p.input), input: stepInput(p.tool, p.input),
          output: null, status: 'running', startedAt: p.at, endedAt: null,
        };
        this.steps.set(p.id, step);
        if (this.open) this.open.steps.push(step);
        else this.add({ kind: 'steps', id: `steps:${p.id}`, at: p.at, steps: [step] });
        return;
      }
      case 'tool-end': {
        const step = this.steps.get(p.id);
        if (!step) return;
        step.output = p.output;
        step.status = p.denied ? 'denied' : p.error ? 'error' : 'done';
        step.endedAt = p.at;
        return;
      }
      case 'hook-context':
        // 다른 도구의 hook 이 넣은 글은 보여주지 않는다.
        if (p.text.startsWith(DURE_PREFIX)) this.addDure(p.id, p.at, p.text);
        return;
      case 'interrupted':
        this.endRunning(p.at);
        this.add({ kind: 'notice', id: p.id, at: p.at, text: '중단됨' });
        return;
      case 'compacted':
        this.add({ kind: 'notice', id: p.id, at: p.at, text: COMPACTED });
        return;
    }
  }

  /** 두레가 한 번에 넣은 글에는 여러 꼭지가 이어져 있을 수 있다 (TODO 변경 + 메시지 여러 건). 꼭지마다 항목 하나로 낸다. */
  private addDure(id: string, at: number, text: string): void {
    text.split(/\n\s*\n(?=\[두레\])/).forEach((part, i) => {
      const [first = '', ...rest] = part.split('\n');
      const itemId = i === 0 ? id : `${id}#${i}`;
      const title = first.slice(DURE_PREFIX.length).trim();
      // 작업 중에 채팅으로 보낸 글은 두레가 대신 전달했을 뿐 사용자의 말이다. 내 말풍선으로 보인다.
      if (title === CHAT_RELAY_TITLE) {
        this.add({ kind: 'user', id: itemId, at, text: rest.filter((l) => l.startsWith('>')).map((l) => l.replace(/^> ?/, '')).join('\n') });
        return;
      }
      this.add({ kind: 'dure', id: itemId, at, title, text: rest.join('\n').trim() });
    });
  }

  /** 결과 없이 끝난 단계(중단되어 결과가 기록되지 않은 것)가 계속 '하는 중' 으로 남지 않게 한다. */
  endRunning(at: number): void {
    for (const s of this.steps.values()) {
      if (s.status === 'running') { s.status = 'denied'; s.endedAt = at; }
    }
  }

  items(): ChatItem[] {
    return this.list;
  }

  step(id: string): ChatStep | undefined {
    return this.steps.get(id);
  }

  reset(): void {
    this.list = [];
    this.seen.clear();
    this.steps.clear();
    this.open = null;
    this.dropped = 0;
    this.version++;
  }
}
