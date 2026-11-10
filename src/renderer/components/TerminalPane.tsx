import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/** 터미널 하나를 그린다. 붙을 때 지난 출력을 되살리고, 그 뒤로는 자기 id 의 출력만 받는다. */
export function TerminalPane({ terminalId }: { terminalId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: '#0f1115', foreground: '#e6e8ee', cursor: '#d9a441', selectionBackground: '#3a4152' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let disposed = false;
    let replayed = false;
    const pending: { chunk: string; end: number }[] = [];
    const fitNow = (): void => {
      if (disposed || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      window.dure.terminals.resize(terminalId, term.cols, term.rows);
    };

    // 지난 출력을 받는 동안 들어온 새 출력은 모아 뒀다가 순서대로 쓴다.
    const offData = window.dure.terminals.onData((id, chunk, end) => {
      if (id !== terminalId) return;
      if (replayed) term.write(chunk); else pending.push({ chunk, end });
    });
    void window.dure.terminals.buffer(terminalId).then((past) => {
      if (disposed) return;
      // 지난 출력에 이미 담긴 조각(end 가 past.end 이하)은 건너뛴다.
      term.write(past.data);
      for (const p of pending) if (p.end > past.end) term.write(p.chunk);
      pending.length = 0;
      replayed = true;
      fitNow();
      term.focus();
    });

    const input = term.onData((data) => window.dure.terminals.write(terminalId, data));
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(el);
    fitNow();

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      offData();
      term.dispose();
    };
  }, [terminalId]);

  return <div className="term-host" ref={host} />;
}
