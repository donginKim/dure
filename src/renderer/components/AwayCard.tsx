import { useCallback, useEffect, useState } from 'react';
import { throttled } from '../throttle';
import type { AwayChoice } from '@shared/types';
import type { Selection } from '../tree';

const ago = (at: number): string => { const m = Math.round((Date.now() - at) / 60_000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };

/** 자리 비운 동안 두레가 대신 고른 답: 돌아와서 훑어보고, 틀린 것은 그 워크스페이스에 가서 바로잡는다. 없으면 보이지 않는다. */
export function AwayCard({ onSelect }: { onSelect: (s: Selection) => void }) {
  const [list, setList] = useState<AwayChoice[]>([]);
  const load = useCallback(() => { window.dure.away.list().then(setList).catch(() => undefined); }, []);
  useEffect(() => { const soon = throttled(load, 5000); soon(); const off = window.dure.onChanged((topic) => { if (topic === 'workspaces') soon(); }); return () => { off(); soon.cancel(); }; }, [load]);
  if (list.length === 0) return null;
  return (
    <div className="inbox away">
      <div className="inbox-head">
        <b>자리 비운 동안 대신 고른 것 <span className="count">{list.length}</span></b>
        <span className="muted">선택지 질문에 추천(첫째) 답을 골라 진행했습니다. 틀린 것은 그 워크스페이스에서 바로잡으세요.</span>
        <span className="grow" />
        <button className="btn ghost" onClick={() => { window.dure.away.clear().then(load).catch(() => undefined); }}>모두 확인함</button>
      </div>
      {list.slice(0, 10).map((c) => (
        <div key={c.id} className="inbox-row">
          <div className="grow inbox-text" title={`${c.question}\n→ ${c.answer}`}><span className="muted">{c.workspaceName} · </span>{c.question} <b>→ {c.answer}</b></div>
          <span className="muted">{ago(c.at)}</span>
          <button className="btn" onClick={() => onSelect({ type: 'workspace', id: c.workspaceId, projectId: c.projectId })}>열기</button>
          <button className="btn ghost" onClick={() => { window.dure.away.clear(c.id).then(load).catch(() => undefined); }}>확인함</button>
        </div>
      ))}
      {list.length > 10 && <div className="muted">외 {list.length - 10}개</div>}
    </div>
  );
}
