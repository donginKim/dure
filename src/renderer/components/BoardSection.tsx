import { useCallback, useEffect, useState } from 'react';
import { Help } from './Help';
import type { Board, BoardWork } from '@shared/types';
import { boardAge, boardTotals, workStateLabel } from '../boardView';
import { TODO_STATUS_LABEL } from '../todoView';
import { Markdown } from './Markdown';

function WorkLine({ w }: { w: BoardWork }) {
  const note = workStateLabel(w);
  return (
    <div className="board-work">
      <span className="board-work-name">{w.name}</span>
      {w.role && <span className="board-work-role" title={w.role}>{w.role}</span>}
      <span className="grow" />
      {note ? <span className="muted">{note}</span> : <span className="board-num">{w.done}/{w.total}</span>}
    </div>
  );
}

/**
 * 함께하는 프로젝트의 현황판: 큰 일과 누가 무엇을 맡았는지. 프로젝트를 연 사람(리더)의 두레가 만들어 모두에게 보낸다.
 * 리더에게는 지금의 것, 나머지에게는 마지막으로 받은 것이 보인다. 보기만 한다.
 */
export function BoardSection({ projectId, title = '전체 현황' }: { projectId: string; title?: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [, setNow] = useState(0);
  const load = useCallback(() => { window.dure.assignments.board(projectId).then(setBoard).catch(() => setBoard(null)); }, [projectId]);
  useEffect(() => {
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'peers' || topic === 'todos' || topic === 'workspaces' || topic === 'coordinator') load(); });
    // "몇 분 전" 이 흐르게 한다.
    const t = setInterval(() => setNow((n) => n + 1), 60_000);
    return () => { off(); clearInterval(t); };
  }, [load]);
  if (!board) return null;
  const totals = boardTotals(board);
  return (
    <div className="section">
      <div className="section-head">
        <h2>{title}</h2>
        <span className="muted">{board.mine ? '내가 연 프로젝트입니다. 이 현황이 함께하는 사람 모두에게 보입니다 (비공개 워크스페이스도 이름과 끝낸 수는 실립니다. 맡은 일의 설명은 공개한 사람에게만)' : `${board.leaderName} 의 두레가 보내 준 것 · ${boardAge(board.updatedAt, Date.now())}`}</span>
      </div>
      <div className="board">
        <div className="board-col">
          <div className="board-label">큰 일 <span className="count">{totals.goalsDone}/{totals.goals}</span></div>
          {board.goals.length === 0 && <div className="muted">아직 프로젝트 TODO 가 없습니다.</div>}
          {board.goals.map((g, i) => (
            <div key={i} className={`board-goal ${g.status}`}>
              <span className={`tick ${g.status}`} />
              <span className="board-goal-title">{g.title}</span>
              {g.assignee === 'user' && <span className="tag" title="에이전트가 아니라 사람이 할 일입니다">사람</span>}
              <span className="grow" />
              {g.total > 0 ? <span className="board-num" title={`딸린 일 ${g.total}개 중 ${g.done}개 완료`}>{g.done}/{g.total}</span> : <span className="muted">{TODO_STATUS_LABEL[g.status]}</span>}
            </div>
          ))}
        </div>
        <div className="board-col">
          <div className="board-label">담당 <span className="count">{board.people.length}</span></div>
          {board.people.map((p) => (
            <div key={p.peerId} className="board-person">
              <div className="board-person-head">
                <b>{p.name}</b>{p.me && <span className="tag">나</span>}{p.leader && <span className="tag" title="프로젝트를 연 사람입니다. 일을 나누고 바꾸는 것은 이 사람이 합니다">리더</span>}
              </div>
              {p.works.length === 0 ? <div className="muted board-none">맡은 워크스페이스가 없습니다.</div> : p.works.map((w, i) => <WorkLine key={i} w={w} />)}
              {p.report && (
                <div className="board-report" title="이 사람이 보낸 작업 보고를 모은 것입니다 (코드는 오지 않습니다)">
                  커밋 {p.report.commits} · 파일 {p.report.files}
                  {p.report.verifyFailed > 0 && <span className="warn"> · 확인 실패 {p.report.verifyFailed}</span>}
                  {p.report.reviewHigh > 0 && <span className="warn"> · 리뷰 높음 {p.report.reviewHigh}</span>}
                  {p.report.last && <div className="muted board-last">최근: {p.report.last.subject} · {boardAge(p.report.last.at, Date.now())}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {board.summary && (
        <details className="board-summary">
          <summary>기획서 정리</summary>
          <div className="plan-summary"><Markdown text={board.summary} /></div>
        </details>
      )}
      {!board.mine && <Help>워크스페이스의 이름과 진행(끝낸 수/전체)만 보입니다. 일을 나누거나 바꾸는 것은 {board.leaderName} 이(가) 합니다.</Help>}
    </div>
  );
}
