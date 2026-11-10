import { EventEmitter } from 'node:events';
import * as nodePty from 'node-pty';
import type { TerminalInfo } from '@shared/types';

export interface SpawnOptions {
  workspaceId: string;
  kind: 'agent' | 'shell';
  title: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

const BUFFER_LIMIT = 200_000;

interface Entry {
  info: TerminalInfo;
  proc: nodePty.IPty;
  buffer: string;
  /** 지금까지 나온 출력의 총 글자 수 */
  total: number;
}

/**
 * 터미널 프로세스를 띄우고 관리한다.
 * 이벤트: 'data' (id, chunk, end), 'exit' (id, exitCode)
 * end 는 그 조각까지 포함한 총 글자 수다. snapshot 의 end 와 비교해 이미 받은 출력을 가려낸다.
 */
export class PtyManager extends EventEmitter {
  private readonly entries = new Map<string, Entry>();

  spawn(o: SpawnOptions): TerminalInfo {
    const proc = nodePty.spawn(o.command, o.args, {
      name: 'xterm-256color',
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: { TERM: 'xterm-256color', ...o.env },
    });
    const info: TerminalInfo = { id: crypto.randomUUID(), workspaceId: o.workspaceId, kind: o.kind, title: o.title };
    const entry: Entry = { info, proc, buffer: '', total: 0 };
    this.entries.set(info.id, entry);
    proc.onData((chunk) => {
      entry.buffer += chunk;
      if (entry.buffer.length > BUFFER_LIMIT) entry.buffer = entry.buffer.slice(-BUFFER_LIMIT);
      entry.total += chunk.length;
      this.emit('data', info.id, chunk, entry.total);
    });
    proc.onExit(({ exitCode }) => {
      this.entries.delete(info.id);
      this.emit('exit', info.id, exitCode);
    });
    return info;
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (e && cols > 0 && rows > 0) e.proc.resize(cols, rows);
  }

  kill(id: string): void {
    const e = this.entries.get(id);
    if (e) terminate(e.proc);
  }

  killAll(): void {
    for (const e of this.entries.values()) terminate(e.proc);
  }

  list(workspaceId: string): TerminalInfo[] {
    return [...this.entries.values()].filter((e) => e.info.workspaceId === workspaceId).map((e) => e.info);
  }

  get(id: string): TerminalInfo | undefined {
    return this.entries.get(id)?.info;
  }

  buffer(id: string): string {
    return this.entries.get(id)?.buffer ?? '';
  }

  /** 최근 출력과 그 끝 위치. 화면을 다시 붙일 때 쓴다. */
  snapshot(id: string): { data: string; end: number } {
    const e = this.entries.get(id);
    return e ? { data: e.buffer, end: e.total } : { data: '', end: 0 };
  }

  pid(id: string): number {
    const e = this.entries.get(id);
    if (!e) throw new Error(`터미널이 없습니다: ${id}`);
    return e.proc.pid;
  }
}

// SIGHUP 으로 끝내고, 무시하는 프로세스는 잠시 뒤 SIGKILL 로 끝낸다.
function terminate(proc: nodePty.IPty): void {
  const pid = proc.pid;
  try { proc.kill('SIGHUP'); } catch { /* 이미 끝남 */ }
  const timer = setTimeout(() => {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ }
  }, 1000);
  timer.unref();
}
