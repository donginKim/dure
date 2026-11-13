import { useCallback, useEffect, useState } from 'react';
import { Help } from './Help';
import type { AutoShipMode, Project, ShipEvent } from '@shared/types';

const STAGE: Record<ShipEvent['stage'], string> = { verify: '확인 명령', review: '리뷰', secret: '비밀 값', commit: '커밋', merge: '합치기', advance: '옮기기', done: '반영' };

/** 자동 반영 (현황 탭): 프로젝트마다 끄고 켠다. 최근 기록을 보인다. */
export function AutoShipSection({ project, readOnly, hasVerify }: { project: Project; readOnly: boolean; hasVerify: boolean }) {
  const [log, setLog] = useState<ShipEvent[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.projects.shipLog(project.id).then(setLog).catch(() => setLog([])); }, [project.id]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'commit') load(); });
  }, [load]);
  const set = (mode: AutoShipMode): void => { setError(''); window.dure.projects.setAutoShip(project.id, mode).catch((e: Error) => setError(e.message)); };
  return (
    <div className="section">
      <div className="section-head">
        <h2>자동 반영</h2>
        <select value={project.autoShip} disabled={readOnly} onChange={(e) => set(e.target.value as AutoShipMode)}>
          <option value="off">끔 (내가 커밋하고 옮긴다)</option>
          <option value="commit">워크스페이스 브랜치에 자동 커밋</option>
          <option value="main">기준 브랜치(main)까지 자동 반영</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <Help>
        {project.autoShip === 'off'
          ? '에이전트가 커밋 초안을 올리면 커밋 창에서 내가 커밋하고, 합치기에서 내가 옮깁니다.'
          : `에이전트가 커밋 초안을 올리면 두레가 차례로 확인합니다: 확인 명령이 통과하고, 리뷰에 "높음" 이 없고, 비밀 값처럼 보이는 것이 없으면 커밋합니다.${project.autoShip === 'main' ? ' 그다음 기준 브랜치에 합쳐 보고, 합친 결과로 확인 명령을 다시 돌려 통과하면 기준 브랜치를 앞으로 감습니다.' : ''} 시험 설정이나 scripts 처럼 확인 명령의 결과를 바꿀 수 있는 파일이 바뀌면 사람에게 넘깁니다. 비밀 값 찾기는 흔한 모양만 봅니다. 하나라도 걸리면 멈추고 "확인할 것" 에 올립니다. push 는 하지 않습니다.`}
        {project.autoShip !== 'off' && !hasVerify && <b> 확인 명령이 없는 저장소는 자동으로 반영하지 않습니다: 위의 저장소 줄에 확인 명령을 적으세요.</b>}
      </Help>
      {log.length > 0 && (
        <div className="ship-log">
          {log.slice(0, 12).map((e) => (
            <div key={e.id} className={`ship-row${e.ok ? '' : ' bad'}`}>
              <span className="muted ship-at">{new Date(e.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="tag">{STAGE[e.stage]}</span>
              <b>{e.workspaceName}</b>
              <span className="grow">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
