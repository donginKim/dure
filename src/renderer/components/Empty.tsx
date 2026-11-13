import type { ReactNode } from 'react';

/** 빈 화면: 짧은 안내와, 바로 누를 수 있는 다음 동작. 긴 설명은 hint 로 (흐리게, 한 줄 아래). */
export function Empty({ children, hint, actions }: { children: ReactNode; hint?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rows-empty empty">
      <div className="empty-text">{children}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}
