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
  /** 끝났으면 종료 코드. 끝난 터미널도 사용자가 닫을 때까지 출력을 보관한다. */
  exitCode?: number;
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
      entry.exitCode = exitCode;
      this.emit('exit', info.id, exitCode);
    });
    return info;
  }

  private live(id: string): Entry | undefined {
    const e = this.entries.get(id);
    return e && e.exitCode === undefined ? e : undefined;
  }

  write(id: string, data: string): void {
    this.live(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.live(id);
    if (e && cols > 0 && rows > 0) e.proc.resize(cols, rows);
  }

  /** 살아 있는 터미널은 끝내고, 이미 끝난 터미널은 보관하던 기록을 지운다. */
  kill(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.exitCode === undefined) terminate(e.proc);
    else this.entries.delete(id);
  }

  /**
   * 모든 터미널을 끝내고, 실제로 끝난 뒤에 돌아온다.
   * SIGHUP 을 보내고 graceMs 동안 기다린 뒤, 남은 것은 프로세스 그룹째 SIGKILL 한다.
   * 앱을 끌 때 이 약속을 기다려야 프로세스가 고아로 남지 않는다.
   */
  async killAll(graceMs = 1500): Promise<void> {
    const alive = (): Entry[] => [...this.entries.values()].filter((e) => e.exitCode === undefined);
    for (const e of alive()) {
      try { e.proc.kill('SIGHUP'); } catch { /* 이미 끝남 */ }
    }
    const waitUntilGone = async (ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (alive().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    };
    await waitUntilGone(graceMs);
    for (const e of alive()) forceKill(e.proc.pid);
    await waitUntilGone(1000);
  }

  /** 살아 있는 터미널만. */
  list(workspaceId: string): TerminalInfo[] {
    return [...this.entries.values()]
      .filter((e) => e.info.workspaceId === workspaceId && e.exitCode === undefined)
      .map((e) => e.info);
  }

  /** 살아 있는 터미널과, 끝났지만 아직 닫지 않은 터미널(exitCode 가 붙는다). */
  listWithExited(workspaceId: string): TerminalInfo[] {
    return [...this.entries.values()]
      .filter((e) => e.info.workspaceId === workspaceId)
      .map((e) => (e.exitCode === undefined ? e.info : { ...e.info, exitCode: e.exitCode }));
  }

  /** 끝난 터미널의 기록을 지운다. kind 를 주면 그 종류만. */
  forgetExited(workspaceId: string, kind?: TerminalInfo['kind']): void {
    for (const [id, e] of this.entries) {
      if (e.info.workspaceId === workspaceId && e.exitCode !== undefined && (!kind || e.info.kind === kind)) this.entries.delete(id);
    }
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
    const e = this.live(id);
    if (!e) throw new Error(`터미널이 없습니다: ${id}`);
    return e.proc.pid;
  }
}

// 터미널의 프로세스는 세션 리더라 pid 가 곧 프로세스 그룹 id 다. 그룹째 끝내야 자식까지 끝난다.
function forceKill(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 그룹이 없음 */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ }
}

// SIGHUP 으로 끝내고, 무시하는 프로세스는 잠시 뒤 SIGKILL 로 끝낸다. (앱이 계속 살아 있을 때 쓰는 경로)
function terminate(proc: nodePty.IPty): void {
  const pid = proc.pid;
  try { proc.kill('SIGHUP'); } catch { /* 이미 끝남 */ }
  const timer = setTimeout(() => {
    try { process.kill(pid, 0); forceKill(pid); } catch { /* 이미 끝남 */ }
  }, 1000);
  timer.unref();
}
