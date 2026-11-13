import { useEffect, useState } from 'react';
import { Empty } from './Empty';
import type { ProjectDashboard } from '@shared/types';
import type { Selection, TreeNode } from '../tree';
import { BoardSection } from './BoardSection';

/**
 * 팀 현황: 다른 사람이 리더인 함께하는 프로젝트들의 현황판을 한 화면에 모은다.
 * 보기만 하는 자리(윗사람)로 들어간 프로젝트가 먼저 온다. 각 현황판은 그 팀 리더의 두레가 보내 준 마지막 것이다.
 */
export function TeamView({ tree, onSelect }: { tree: TreeNode[]; onSelect: (s: Selection) => void }) {
  const [dash, setDash] = useState<ProjectDashboard[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => { window.dure.projects.dashboard().then((d) => { if (alive) setDash(d); }).catch(() => undefined); };
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'peers') load(); });
    return () => { alive = false; off(); };
  }, []);
  const shared = (dash ?? []).filter((d) => d.share && !d.share.mine).sort((a, b) => Number(b.share!.observer) - Number(a.share!.observer));
  const name = (id: string): string => tree.find((n) => n.project.id === id)?.project.name ?? '프로젝트';
  return (
    <div className="page">
      <div className="section-head"><h1>팀 현황</h1></div>
      <div className="sub">다른 사람이 리더인 함께하는 프로젝트들의 현황입니다. 각 팀 리더의 두레가 보내 준 마지막 것이라, 리더의 PC 가 꺼져 있으면 멈춰 있습니다. 코드는 오지 않고 진행과 작업 보고(커밋 수, 확인 결과)만 옵니다.</div>
      {dash && shared.length === 0 && (
        <Empty hint={<>팀장이 함께하는 프로젝트의 "함께하는 사람" 에서 나를 <b>보기만</b> 으로 초대하면, 받은 초대를 "보기로 참여" 해 여기에 모입니다.</>} actions={<button className="btn" onClick={() => onSelect({ type: 'people' })}>사람 화면 열기</button>}>아직 없습니다.</Empty>
      )}
      {shared.map((d) => (
        <div key={d.projectId} className="team-block">
          <div className="team-head">
            <button className="btn ghost" onClick={() => onSelect({ type: 'project', id: d.projectId })}>{name(d.projectId)}</button>
            {d.share!.observer ? <span className="tag">보기만</span> : <span className="tag">참여</span>}
            <span className="muted">{d.share!.online}/{d.share!.people}명 닿음</span>
          </div>
          <BoardSection projectId={d.projectId} title="현황" />
        </div>
      ))}
    </div>
  );
}
