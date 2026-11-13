import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttentionItem, Workspace } from '@shared/types';
import { attentionTarget, groupAttention, INLINE_KINDS, KIND_LABEL } from '../attentionView';
import type { Selection } from '../tree';
import { BrowserRequests } from './BrowserRequests';
import { DbRequests } from './DbRequests';
import { PeerInbox } from './PeerInbox';
import { SlackRequests } from './SlackRequests';

/**
 * 확인할 것: 에이전트나 다른 사람이 나를 기다리는 것을 프로젝트마다 모아 보여 준다.
 * 읽기·열기 승인과 받은 메시지는 여기서 바로 결정한다. 계획안, 에이전트의 질문, 받은 일, 연결 요청은 그 화면으로 간다.
 */
const HIDE_KEY = 'dure.attention.hidden';

export function AttentionView({ workspaces, onSelect }: { workspaces: Workspace[]; onSelect: (s: Selection) => void }) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const load = useCallback(() => { window.dure.attention.list().then(setItems).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'attention') load(); });
  }, [load]);
  const coordinators = new Set(workspaces.filter((w) => w.role === 'coordinator').map((w) => w.id));
  const wsName = (id: string | null): string => { const w = workspaces.find((x) => x.id === id); return !w ? '' : w.role === 'coordinator' ? '조율' : w.name; };
  // 숨긴 것: 이 PC 에서만, 같은 항목(id)이 다시 오면 계속 숨는다. 사라진 항목의 기록은 지운다.
  const [hidden, setHidden] = useState<Set<string>>(() => { try { return new Set(JSON.parse(window.localStorage.getItem(HIDE_KEY) ?? '[]') as string[]); } catch { return new Set(); } });
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    if (items.length === 0) return;
    const live = new Set(items.map((i) => i.id));
    const kept = [...hidden].filter((id) => live.has(id));
    if (kept.length !== hidden.size) { setHidden(new Set(kept)); try { window.localStorage.setItem(HIDE_KEY, JSON.stringify(kept)); } catch { /* 못 적어도 된다 */ } }
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleHide = (id: string): void => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
    setHidden(next);
    try { window.localStorage.setItem(HIDE_KEY, JSON.stringify([...next])); } catch { /* 못 적어도 된다 */ }
  };
  const visible = items.filter((i) => showHidden || !hidden.has(i.id));
  const groups = groupAttention(visible);
  // 키보드: J/K(↑↓) 로 고르고, Enter 로 열고, H 로 숨기거나 되살린다.
  const rowsInOrder = groups.flatMap((g) => g.items.filter((i) => !INLINE_KINDS.includes(i.kind)));
  const [at, setAt] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(i + 1, rowsInOrder.length - 1)); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' && rowsInOrder[at]) { e.preventDefault(); onSelect(attentionTarget(rowsInOrder[at]!, coordinators)); }
      else if (e.key === 'h' && rowsInOrder[at]) { e.preventDefault(); toggleHide(rowsInOrder[at]!.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => { page.current?.querySelector('.attention-row.on')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const hiddenCount = items.filter((i) => hidden.has(i.id)).length;

  return (
    <div className="page" ref={page}>
      <div className="section-head">
        <h1>확인할 것 <span className="count">{items.length - (showHidden ? 0 : hiddenCount)}</span></h1>
        {hiddenCount > 0 && <button className="btn ghost" onClick={() => setShowHidden((v) => !v)}>{showHidden ? '숨긴 것 감추기' : `숨긴 것 ${hiddenCount}개 보기`}</button>}
      </div>
      <p className="lead">에이전트나 다른 사람이 나를 기다리는 것입니다. <span className="kbd-hint"><kbd>J</kbd><kbd>K</kbd> 고르기 · <kbd>Enter</kbd> 열기 · <kbd>H</kbd> 숨기기</span></p>
      {visible.length === 0 && <div className="rows"><div className="rows-empty">{items.length ? '숨기지 않은 것이 없습니다.' : '지금 확인할 것이 없습니다.'}</div></div>}
      {groups.map((g) => {
        const rows = g.items.filter((i) => !INLINE_KINDS.includes(i.kind));
        const inline = g.projectId !== null && g.items.some((i) => INLINE_KINDS.includes(i.kind));
        const mine = workspaces.filter((w) => w.projectId === g.projectId);
        return (
          <div key={g.projectId ?? 'people'} className="section">
            <div className="section-head">
              <h2>{g.projectId === null ? '사람' : g.projectName} <span className="count">{g.items.length}</span></h2>
              {g.projectId !== null && <button className="btn ghost" onClick={() => onSelect({ type: 'project', id: g.projectId! })}>프로젝트 열기</button>}
            </div>
            {rows.length > 0 && (
              <div className="rows">
                {rows.map((i) => {
                  const n = rowsInOrder.indexOf(i);
                  return (
                    <div key={i.id} className={`row attention-row${n === at ? ' on' : ''}${hidden.has(i.id) ? ' hidden' : ''}`} onMouseEnter={() => setAt(n)} onClick={() => onSelect(attentionTarget(i, coordinators))}>
                      <span className={`tag attention-${i.kind}`}>{KIND_LABEL[i.kind]}</span>
                      <div className="grow"><div>{i.title}{wsName(i.workspaceId) && <span className="attention-ws">{wsName(i.workspaceId)}</span>}</div>{i.detail && <div className="attention-detail">{i.detail}</div>}</div>
                      <button className="btn ghost attention-hide" title={hidden.has(i.id) ? '다시 보이게 합니다' : '이 PC 에서 목록에서 숨깁니다 (같은 것이 다시 와도 숨습니다)'} onClick={(e) => { e.stopPropagation(); toggleHide(i.id); }}>{hidden.has(i.id) ? '되살리기' : '숨기기'}</button>
                      <span className="muted">열기 ›</span>
                    </div>
                  );
                })}
              </div>
            )}
            {inline && (
              <div className="attention-inline">
                <DbRequests projectId={g.projectId!} workspaces={mine} />
                <SlackRequests projectId={g.projectId!} workspaces={mine} />
                <BrowserRequests projectId={g.projectId!} workspaces={mine} />
                <PeerInbox projectId={g.projectId!} workspaces={mine} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
