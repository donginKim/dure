import { useEffect, useState } from 'react';
import type { ProjectDashboard, Repo } from '@shared/types';
import { Onboarding } from './Onboarding';
import { STATUS_LABEL, type Selection, type TreeNode } from '../tree';

/** 아무것도 고르지 않았을 때 보이는 화면: 운영 중인 프로젝트 전체. */
export function ProjectsHome({ tree, repos, onSelect, onCreate }: { tree: TreeNode[]; repos: Repo[]; onSelect: (s: Selection) => void; onCreate: (name: string) => Promise<void> }) {
  const [guide, setGuide] = useState(false);
  // 프로젝트마다 한눈 요약 (TODO 진행, 답을 기다리는 에이전트, 확인할 것, 오늘 토큰, 자동 반영, 함께하기). 10초마다 새로 읽는다.
  const [dash, setDash] = useState<Record<string, ProjectDashboard>>({});
  useEffect(() => {
    let alive = true;
    const load = (): void => { window.dure.projects.dashboard().then((list) => { if (alive) setDash(Object.fromEntries(list.map((d) => [d.projectId, d]))); }).catch(() => undefined); };
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [tree]);
  const total = Object.values(dash).reduce((a, d) => ({ attention: a.attention + d.attention, waiting: a.waiting + d.agents.waiting, working: a.working + d.agents.working, tokens: a.tokens + d.budget.today }), { attention: 0, waiting: 0, working: 0, tokens: 0 });
  return (
    <div className="page">
      <div className="section-head"><h1>프로젝트</h1>{tree.length > 0 && !guide && <button className="btn ghost" onClick={() => setGuide(true)}>시작 안내</button>}</div>
      <Onboarding tree={tree} repos={repos} onCreate={onCreate} onOpenProject={(id) => onSelect({ type: 'project', id })} force={guide} onClose={() => setGuide(false)} />
      <div className="sub">
        프로젝트는 함께 움직이는 저장소와 워크스페이스의 묶음입니다. 보통 프론트와 백엔드 한 세트가 한 프로젝트입니다.
      </div>

      {tree.length > 1 && (
        <div className="dash-total">
          <span>일하는 에이전트 <b>{total.working}</b></span>
          <span className={total.waiting ? 'warn' : ''}>내 답을 기다림 <b>{total.waiting}</b></span>
          <span className={total.attention ? 'warn' : ''}>확인할 것 <b>{total.attention}</b></span>
          <span>오늘 토큰 <b>{tokens(total.tokens)}</b></span>
        </div>
      )}
      <div className="cards-grid">
        {tree.map(({ project, workspaces }) => {
          const projectRepos = repos.filter((r) => r.projectId === project.id);
          const running = workspaces.filter((w) => w.status !== 'stopped').length;
          const d = dash[project.id];
          return (
            <div className="pcard" key={project.id} onClick={() => onSelect({ type: 'project', id: project.id })}>
              <div className="pcard-title"><span className="folder" />{project.name}</div>
              <div className="pcard-meta">저장소 {projectRepos.length}개 · 워크스페이스 {workspaces.length}개{running > 0 ? ` · 실행 중 ${running}개` : ''}</div>
              {d && <Summary d={d} />}
              <div className="pcard-list">
                {projectRepos.length === 0 && <button className="btn" onClick={(e) => { e.stopPropagation(); onSelect({ type: 'project', id: project.id }); }}>저장소 추가하러 가기</button>}
                {workspaces.slice(0, 4).map((w) => (
                  <div
                    className="pcard-ws"
                    key={w.id}
                    onClick={(e) => { e.stopPropagation(); onSelect({ type: 'workspace', id: w.id, projectId: project.id }); }}
                  >
                    <span className={`dot ${w.status}`} />
                    <span className="grow">{w.name}</span>
                    <span className="muted">{STATUS_LABEL[w.status]}</span>
                  </div>
                ))}
                {workspaces.length > 4 && <div className="muted">외 {workspaces.length - 4}개</div>}
                {projectRepos.length > 0 && workspaces.length === 0 && <div className="muted">워크스페이스 없음</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const ago = (at: number): string => { const m = Math.round((Date.now() - at) / 60_000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };
const STAGE: Record<string, string> = { verify: '확인 명령', review: '리뷰', secret: '비밀 값 검사', commit: '커밋', merge: '합치기', advance: 'main 반영', done: '완료' };

/** 프로젝트 카드의 한눈 요약. */
function Summary({ d }: { d: ProjectDashboard }) {
  const pct = d.todos.total ? Math.round((d.todos.done / d.todos.total) * 100) : 0;
  return (
    <div className="pcard-dash">
      {d.todos.total > 0 && (
        <div className="pcard-progress" title={`TODO ${d.todos.total}개 중 ${d.todos.done}개 끝남, ${d.todos.doing}개 하는 중`}>
          <div className="bar"><div style={{ width: `${pct}%` }} /></div>
          <span>TODO {d.todos.done}/{d.todos.total}{d.todos.doing ? ` · 하는 중 ${d.todos.doing}` : ''}</span>
        </div>
      )}
      <div className="pcard-badges">
        {d.agents.working > 0 && <span className="badge">일하는 중 {d.agents.working}</span>}
        {d.agents.waiting > 0 && <span className="badge warn">답 기다림 {d.agents.waiting}</span>}
        {d.attention > 0 && <span className="badge warn">확인할 것 {d.attention}</span>}
        {(d.budget.today > 0 || d.budget.state !== 'ok') && (
          <span className={`badge${d.budget.state === 'over' ? ' danger' : d.budget.state === 'warning' ? ' warn' : ''}`} title="오늘 쓴 토큰 (입력·캐시 쓰기·출력)">
            오늘 {tokens(d.budget.today)}{d.budget.dailyLimit > 0 ? ` / ${tokens(d.budget.dailyLimit)}` : ''}
          </span>
        )}
        {d.share && <span className="badge" title={d.share.mine ? '내가 리더인 함께하는 프로젝트' : '다른 사람이 리더인 함께하는 프로젝트'}>{d.share.mine ? '리더' : '참여'} · {d.share.online}/{d.share.people}명 닿음</span>}
      </div>
      {d.lastShip && <div className={`pcard-ship${d.lastShip.ok ? '' : ' bad'}`}>자동 반영 · {d.lastShip.workspaceName} · {STAGE[d.lastShip.stage] ?? d.lastShip.stage} {d.lastShip.ok ? '' : '멈춤 '}· {ago(d.lastShip.at)}</div>}
    </div>
  );
}
