import { useCallback, useEffect, useState } from 'react';
import type { ChatView, Workspace } from '@shared/types';
import { QuestionCard } from './ChatPane';

const cut = (s: string, n = 1200): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 조율 화면 위에 뜨는 "답을 기다리는 워크스페이스" 카드. 조율 에이전트가 일을 시킨 워크스페이스들이 승인이나 질문을 기다리면,
 * 워크스페이스 화면에 들어가지 않고 여기서 바로 답한다. 한 번에 하나씩 보이고, 나머지는 수로 보인다.
 */
export function WaitingAsks({ workspaces, onOpen }: { workspaces: Workspace[]; onOpen: (workspaceId: string) => void }) {
  const waiting = workspaces.filter((w) => w.role !== 'coordinator' && w.status === 'waiting_user');
  const ids = waiting.map((w) => w.id).join(',');
  const [views, setViews] = useState<Record<string, ChatView>>({});
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    void Promise.all(waiting.map((w) => window.dure.chat.get(w.id).then((v) => [w.id, v] as const).catch(() => null)))
      .then((list) => setViews(Object.fromEntries(list.filter((x): x is readonly [string, ChatView] => x !== null))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'chat' || topic === 'workspaces') load(); });
  }, [load]);
  // 새로 기다리는 것이 생기면 다시 보인다.
  useEffect(() => { setHidden(false); }, [ids]);
  const asks = waiting.filter((w) => views[w.id]?.question || views[w.id]?.pendingPermission);
  if (asks.length === 0 || hidden) {
    return asks.length > 0 ? <button className="btn waiting-pill" onClick={() => setHidden(false)}>답을 기다리는 워크스페이스 {asks.length}</button> : null;
  }
  const w = asks[0]!;
  const v = views[w.id]!;
  const run = (p: Promise<unknown>): void => { setError(''); p.then(load).catch((e: Error) => setError(e.message)); };
  const perm = v.pendingPermission;
  return (
    <div className="waiting-asks" role="dialog" aria-label="답을 기다리는 워크스페이스">
      <div className="waiting-head">
        <span className="dot waiting_user" />
        <b>"{w.name}"</b>
        <span className="muted">{v.question ? '이(가) 묻습니다' : '이(가) 실행해도 되는지 묻습니다'}{asks.length > 1 ? ` · 이 뒤에 ${asks.length - 1}개가 더 기다립니다` : ''}</span>
        <span className="grow" />
        <button className="btn ghost" onClick={() => onOpen(w.id)} title="그 워크스페이스의 화면으로 갑니다">대화 보기</button>
        <button className="btn ghost" onClick={() => setHidden(true)} title="접어 둡니다 (새로 기다리는 것이 생기면 다시 뜹니다)">접기</button>
      </div>
      {error && <div className="error">{error}</div>}
      {v.question ? (
        <QuestionCard
          key={v.question.requestId}
          question={v.question}
          onAnswer={(answers) => run(window.dure.chat.answerQuestion(w.id, v.question!.requestId, answers))}
          onDismiss={() => run(window.dure.chat.dismissQuestion(w.id, v.question!.requestId))}
        />
      ) : perm && (
        <div className="permit">
          <div className="permit-what">{perm.summary}</div>
          {perm.input && perm.input !== perm.summary && <pre className="raw">{cut(perm.input)}</pre>}
          <div className="permit-actions">
            {perm.canAnswer ? (
              <>
                <button className="btn primary" onClick={() => run(window.dure.chat.answerPermission(w.id, 'allow', perm.requestId))}>허용</button>
                <button className="btn" onClick={() => run(window.dure.chat.answerPermission(w.id, 'deny', perm.requestId))}>거부</button>
                {perm.canAlways && <button className="btn" title="허용하고, 이번 대화 동안 같은 것은 묻지 않습니다" onClick={() => run(window.dure.chat.answerPermission(w.id, 'always', perm.requestId))}>허용하고 이번 대화에서는 묻지 않기</button>}
                {perm.canAlways && perm.alwaysRule && <span className="permit-hint">묻지 않게 될 것: <code>{perm.alwaysRule}</code></span>}
              </>
            ) : <span className="permit-hint">이 요청은 여기서 답할 수 없습니다. "대화 보기" 로 그 워크스페이스에서 답하세요.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
