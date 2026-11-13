import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 설명 글: 처음에는 한 줄만 보이고, 넘치면 "자세히" 로 편다. 짧으면 그대로.
 * 화면마다 두세 줄짜리 회색 설명이 쌓여 무거워지는 것을 막는다.
 */
export function Help({ children, className = 'help' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = (): void => setLong(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children, open]);
  return (
    <div className={`${className} help-fold${open ? ' open' : ''}`}>
      <div ref={ref} className="help-body">{children}</div>
      {(long || open) && <button className="help-more" onClick={() => setOpen((v) => !v)}>{open ? '접기' : '자세히'}</button>}
    </div>
  );
}
