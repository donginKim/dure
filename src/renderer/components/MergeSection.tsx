import { useCallback, useEffect, useState } from 'react';
import type { MergePlan, MergeStep } from '@shared/types';
import { ConfirmDialog } from './dialogs';

const STATE_LABEL: Record<MergeStep['state'], string> = { ok: '합쳐짐', conflict: '충돌', merged: '이미 들어감', empty: '커밋 없음', missing: '브랜치 없음' };

/**
 * 합치기 도우미 (현황 탭). 저장소·기준 브랜치마다 워크스페이스 브랜치를 차례로 합쳐 본 결과를 보인다.
 * 합치기 브랜치를 만들어 확인 명령을 돌리고, 사용자가 누르면 기준 브랜치를 앞으로 옮긴다.
 */
export function MergeSection({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const [plans, setPlans] = useState<MergePlan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [verify, setVerify] = useState<Record<string, { ok: boolean; output: string } | null>>({});
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<MergePlan | null>(null);
  const load = useCallback(() => { window.dure.merge.plans(projectId).then(setPlans).catch((e: Error) => { setError(e.message); setPlans([]); }); }, [projectId]);
  useEffect(() => { load(); }, [load]);
  if (!plans || plans.length === 0) return null;
  const key = (p: MergePlan): string => `${p.repoId}|${p.base}`;
  const act = (p: MergePlan, what: string, job: () => Promise<unknown>): void => {
    setBusy(key(p)); setError('');
    job().then(() => load()).catch((e: Error) => setError(e.message)).finally(() => setBusy(null));
    void what;
  };
  return (
    <div className="section">
      <div className="section-head">
        <h2>합치기</h2>
        <button className="btn ghost" onClick={load} title="브랜치들을 다시 차례로 합쳐 봅니다 (아무것도 바꾸지 않습니다)">다시 미리 보기</button>
      </div>
      {error && <div className="error">{error}</div>}
      {plans.map((p) => {
        const conflicts = p.steps.filter((s) => s.state === 'conflict');
        const ok = p.steps.filter((s) => s.state === 'ok');
        const k = key(p);
        return (
          <div key={k} className="merge-plan">
            <div className="merge-head">
              <div className="grow"><b>{p.repoName}</b> → <code>{p.base}</code> <span className="muted">· 합칠 것 {ok.length}개{conflicts.length ? ` · 충돌 ${conflicts.length}개` : ''}</span></div>
              {!readOnly && (
                <>
                  <button className="btn" disabled={busy !== null || !p.result} title={`충돌 없는 것을 차례로 합쳐 두고${p.verifyCommand ? ` 확인 명령(${p.verifyCommand})을 돌립니다` : ''}. ${p.base} 와 작업 폴더는 건드리지 않습니다`}
                    onClick={() => act(p, 'prepare', () => window.dure.merge.prepare(projectId, p.repoId, p.base).then((r) => {
                      setVerify((v) => ({ ...v, [k]: r.verify }));
                      setNote((n) => ({ ...n, [k]: `합친 결과를 만들었습니다.${r.verify ? (r.verify.ok ? ' 확인 명령 통과.' : ' 확인 명령 실패: 아래 출력을 보세요.') : ' (확인 명령이 없어 시험은 돌리지 않았습니다)'}` }));
                    }))}>
                    {busy === k ? '합치는 중…' : '합쳐서 확인하기'}
                  </button>
                  <button className="btn primary" disabled={busy !== null || !p.ready} title={p.ready ? `합친 결과로 ${p.base} 를 앞으로 감습니다` : `먼저 "합쳐서 확인하기" 를 누르세요${p.verifyCommand ? ' (확인 명령이 통과해야 옮길 수 있습니다)' : ''}`} onClick={() => setConfirm(p)}>{p.base} 로 옮기기</button>
                </>
              )}
            </div>
            <div className="merge-steps">
              {p.steps.map((s, i) => (
                <div key={s.workspaceId} className={`merge-step ${s.state}`}>
                  <span className="merge-n">{i + 1}</span>
                  <span className="merge-name">{s.name}</span>
                  <code className="muted">{s.branch}</code>
                  <span className={`tag merge-${s.state}`}>{STATE_LABEL[s.state]}{s.ahead ? ` · 커밋 ${s.ahead}` : ''}</span>
                  {s.uncommitted > 0 && <span className="tag warn" title="커밋하지 않은 변경은 합치기에 들어가지 않습니다">커밋 안 한 변경 {s.uncommitted}</span>}
                  <span className="grow" />
                  {s.state === 'conflict' && !readOnly && (
                    <button className="btn ghost" disabled={busy !== null} onClick={() => act(p, 'ask', () => window.dure.merge.askToResolve(projectId, p.repoId, p.base, s.workspaceId).then(() => setNote((n) => ({ ...n, [k]: `"${s.name}" 에이전트에게 충돌을 풀라고 보냈습니다.` }))))}>
                      에이전트에게 풀게 하기
                    </button>
                  )}
                  {s.state === 'conflict' && (
                    <div className="merge-conflict">
                      충돌 파일: {s.conflicts.join(', ')}
                      {s.with.length > 0 && <> · 함께 충돌: {s.with.map((id) => p.steps.find((x) => x.workspaceId === id)?.name ?? '').join(', ')}</>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {note[k] && <div className="muted merge-note">{note[k]}</div>}
            {verify[k] && !verify[k]!.ok && <pre className="verify-out">{verify[k]!.output || '(출력 없음)'}</pre>}
          </div>
        );
      })}
      <div className="help">에이전트 사이의 순서(앞의 일)를 따라, 없으면 만든 순서로 합칩니다. 미리 보기와 "합쳐서 확인하기" 는 기준 브랜치와 작업 폴더를 건드리지 않습니다 (합친 결과는 브랜치가 아닌 두레의 ref 에 둡니다). 커밋하지 않은 변경은 들어가지 않습니다.</div>
      {confirm && (
        <ConfirmDialog
          title={`${confirm.base} 로 옮기기`}
          message={`${confirm.repoName} 의 ${confirm.base} 를 합친 결과로 앞으로 감습니다 (fast-forward). ${confirm.base} 가 그사이 바뀌었거나, ${confirm.base} 가 체크아웃된 폴더에 커밋하지 않은 변경이 있으면 하지 않습니다. push 는 하지 않습니다.`}
          confirmLabel="옮기기"
          onClose={() => setConfirm(null)}
          onConfirm={async () => { const m = await window.dure.merge.advance(projectId, confirm.repoId, confirm.base); setNote((n) => ({ ...n, [key(confirm)]: m })); setConfirm(null); load(); }}
        />
      )}
    </div>
  );
}
