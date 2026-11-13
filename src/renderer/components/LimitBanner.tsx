import { useEffect, useState } from 'react';
import type { LimitInfo, ModelChoice, Workspace } from '@shared/types';
import { limitText } from '../limitView';

/**
 * 사용 한도에 걸렸거나 가까울 때 채팅 위에 뜨는 띠. 걸렸으면 다른 모델로 바꿔 바로 이어 가는 단추를 보인다:
 * 모델을 바꾸고, 에이전트에게 하던 일을 이어 가라고 보낸다 (대화는 끊기지 않는다).
 */
export function LimitBanner({ workspace, limit, hasAgent, onError }: { workspace: Workspace; limit: LimitInfo; hasAgent: boolean; onError: (m: string) => void }) {
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.dure.settings.models().then(setModels).catch(() => setModels([])); }, []);
  const current = workspace.model || limit.model;
  const others = models.filter((m) => m.value !== 'default' && m.value !== current).slice(0, 3);
  const go = (model: string): void => {
    setBusy(true);
    window.dure.workspaces.setModel(workspace.id, model)
      .then((r) => (r.applied === 'now' && hasAgent
        ? window.dure.chat.send(workspace.id, `[두레] 사용 한도에 걸려 멈췄다. 모델을 ${model} 로 바꿨다. 하던 일을 이어서 하라.`)
        : undefined))
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className={`limit-band ${limit.status}`}>
      <div className="grow">{limitText(limit, Date.now())}</div>
      {limit.status === 'rejected' && others.map((m) => (
        <button key={m.value} className="btn" disabled={busy} title={m.description || m.value} onClick={() => go(m.value)}>{m.name} 로 이어 가기</button>
      ))}
    </div>
  );
}
