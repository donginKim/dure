import type { ChatItem, ChatStep } from '@shared/types';
import { DURE_PREFIX, stepInput, stepSummary, type Piece } from './transcript';

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
      this.add({ kind: 'dure', id: i === 0 ? id : `${id}#${i}`, at, title: first.slice(DURE_PREFIX.length).trim(), text: rest.join('\n').trim() });
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
    this.version++;
  }
}
