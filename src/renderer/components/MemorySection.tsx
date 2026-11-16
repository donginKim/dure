import { useCallback, useEffect, useState } from 'react';
import type { MemoryItem, MemoryKind } from '@shared/types';
import { Empty } from './Empty';

const LABEL: Record<MemoryKind, string> = { decision: '정한 것', lesson: '배운 것', command: '명령' };

/**
 * 프로젝트 기억: 대화가 끊겨도 남는 짧은 사실 (정한 것, 배운 것, 자주 쓰는 명령). 에이전트가 일하며 남기고, 사용자도 적는다.
 * 새 대화를 시작하는 에이전트에게 두레가 간추려 건넨다.
 */
export function MemorySection({ projectId, readOnly }: { projectId: string; readOnly?: boolean }) {
  const [list, setList] = useState<MemoryItem[]>([]);
  const [kind, setKind] = useState<MemoryKind>('decision');
  const [text, setText] = useState('');
  const [all, setAll] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.memory.list(projectId).then(setList).catch(() => undefined); }, [projectId]);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'memory') load(); }); }, [load]);
  const add = (): void => {
    if (!text.trim()) return;
    setError('');
    window.dure.memory.add(projectId, kind, text).then(() => setText('')).catch((e: Error) => setError(e.message));
  };
  const shown = all ? list : list.slice(0, 8);
  return (
    <div className="section">
      <div className="section-head"><h2>기억 <span className="count">{list.length}</span> <span className="plan-hint">대화가 새로 시작돼도 에이전트가 이어받는 것</span></h2></div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      <div className="rows">
        {list.length === 0 && <Empty hint="정한 것과 그 까닭, 실패해서 다시 하지 말 접근, 시험·빌드 명령처럼 다음 대화가 알아야 할 것을 한 줄씩 남깁니다. 에이전트도 일하면서 스스로 남깁니다.">아직 기억이 없습니다.</Empty>}
        {shown.map((m) => (
          <div key={m.id} className="row mem-row">
            <span className={`tag mem-${m.kind}`}>{LABEL[m.kind]}</span>
            <div className="grow"><div className="mem-text">{m.text}</div><div className="muted mem-by">{m.author}</div></div>
            {!readOnly && <button className="btn ghost" onClick={() => { window.dure.memory.remove(m.id).catch(() => undefined); }}>지우기</button>}
          </div>
        ))}
        {list.length > 8 && <button className="btn ghost" onClick={() => setAll((v) => !v)}>{all ? '접기' : `외 ${list.length - 8}개 보기`}</button>}
      </div>
      {!readOnly && (
        <div className="mem-add">
          <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}><option value="decision">정한 것</option><option value="lesson">배운 것</option><option value="command">명령</option></select>
          <input type="text" value={text} maxLength={300} placeholder="한 줄로 (예: 결제는 토스만 붙인다. 카카오페이는 다음 분기)" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add(); }} />
          <button className="btn" disabled={!text.trim()} onClick={add}>남기기</button>
        </div>
      )}
    </div>
  );
}
