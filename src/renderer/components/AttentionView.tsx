import { useCallback, useEffect, useState } from 'react';
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
export function AttentionView({ workspaces, onSelect }: { workspaces: Workspace[]; onSelect: (s: Selection) => void }) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const load = useCallback(() => { window.dure.attention.list().then(setItems).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'attention') load(); });
  }, [load]);
  const coordinators = new Set(workspaces.filter((w) => w.role === 'coordinator').map((w) => w.id));
  const groups = groupAttention(items);

  return (
    <div className="page">
      <h1>확인할 것 <span className="count">{items.length}</span></h1>
      <p className="lead">에이전트나 다른 사람이 나를 기다리는 것입니다. 새로 생기면 macOS 알림으로도 알려 줍니다 (설정에서 끌 수 있습니다).</p>
      {items.length === 0 && <div className="rows"><div className="rows-empty">지금 확인할 것이 없습니다.</div></div>}
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
                {rows.map((i) => (
                  <button key={i.id} className="row attention-row" onClick={() => onSelect(attentionTarget(i, coordinators))}>
                    <span className={`tag attention-${i.kind}`}>{KIND_LABEL[i.kind]}</span>
                    <div className="grow"><div>{i.title}</div>{i.detail && <div className="attention-detail">{i.detail}</div>}</div>
                    <span className="muted">열기 ›</span>
                  </button>
                ))}
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
