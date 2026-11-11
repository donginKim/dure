import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** 에이전트가 표준 출력으로 내는 이벤트 한 줄 (JSON). 모양은 Claude Code 의 stream-json 이다 (실험 17, 18). */
export type AgentEvent = Record<string, unknown> & { type: string };

export interface SessionSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

const MAX_LINE = 64 << 20; // 줄바꿈 없이 이보다 길어지면 버린다
const STDERR_KEEP = 4000;

/**
 * 터미널 화면 없이 도는 에이전트 프로세스 하나.
 * 표준 입력으로 JSON 줄을 보내고, 표준 출력의 JSON 줄을 이벤트로 낸다. 화면 글자를 읽거나 키 입력을 흉내 내지 않는다.
 * 이벤트: 'event' (AgentEvent), 'exit' (code, stderr 끝부분)
 */
export class AgentSession extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderr = '';
  private exited = false;
  private readonly waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(spec: SessionSpawn) {
    super();
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP); });
    // 끝난 프로세스에 쓰다 난 오류로 앱이 죽지 않게 한다.
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (e) => this.onExit(null, String(e.message)));
    this.child.on('exit', (code) => this.onExit(code, this.stderr));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.exited;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim()) this.onLine(line);
    }
    if (this.buffer.length > MAX_LINE) this.buffer = '';
  }

  private onLine(line: string): void {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; } // JSON 이 아닌 줄(경고 등)은 버린다
    if (typeof event !== 'object' || event === null || typeof (event as AgentEvent).type !== 'string') return;
    const e = event as AgentEvent;
    if (e.type === 'control_response') {
      // 우리가 보낸 요청의 답
      const response = e.response as { request_id?: string; subtype?: string; response?: unknown; error?: string } | undefined;
      const pending = response?.request_id ? this.waiting.get(response.request_id) : undefined;
      if (pending && response?.request_id) {
        this.waiting.delete(response.request_id);
        clearTimeout(pending.timer);
        if (response.subtype === 'success') pending.resolve(response.response);
        else pending.reject(new Error(response.error ?? '에이전트가 요청을 거절했습니다.'));
      }
      return;
    }
    this.emit('event', e);
  }

  private onExit(code: number | null, stderr: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error('에이전트가 종료되었습니다.')); }
    this.waiting.clear();
    this.emit('exit', code, stderr.slice(-STDERR_KEEP));
  }

  private write(o: unknown): void {
    if (this.exited) throw new Error('에이전트가 종료되었습니다.');
    this.child.stdin.write(`${JSON.stringify(o)}\n`);
  }

  /** 사용자의 말(또는 두레가 전하는 글)을 보낸다. 작업 중에 보내면 에이전트가 같은 차례 안에 읽는다 (실험 18). */
  say(text: string): void {
    this.write({ type: 'user', message: { role: 'user', content: text } });
  }

  /** 에이전트에게 요청을 보내고 답을 기다린다 (초기화, 멈춤 등). */
  control<T = unknown>(request: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const id = `dure_${crypto.randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('에이전트가 응답하지 않습니다.')); }, timeoutMs);
      timer.unref();
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.write({ type: 'control_request', request_id: id, request }); } catch (e) {
        this.waiting.delete(id); clearTimeout(timer); reject(e as Error);
      }
    });
  }

  /** 에이전트가 물어 온 것(승인, 질문)에 답한다. */
  respond(requestId: string, response: Record<string, unknown>): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  /** 에이전트가 물어 온 것에 "처리하지 못한다" 고 답한다. */
  respondError(requestId: string, error: string): void {
    try { this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }); } catch { /* 이미 끝남 */ }
  }

  /** 하던 일을 멈춘다. 프로세스는 살아 있다 (실험 18: 0.2초 안에 멈춘다). */
  interrupt(): Promise<unknown> {
    return this.control({ subtype: 'interrupt' }, 10_000);
  }

  /** 프로세스를 끝낸다. 입력을 닫아 스스로 끝나게 하고, 안 끝나면 강제로 끝낸다. */
  kill(): void {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch { /* 이미 닫힘 */ }
    const t = setTimeout(() => { if (!this.exited) this.child.kill('SIGKILL'); }, 2000);
    t.unref();
    this.child.kill('SIGTERM');
  }
}
