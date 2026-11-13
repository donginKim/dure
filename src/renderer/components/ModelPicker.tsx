import { useEffect, useState } from 'react';
import type { ModelChoice, Workspace } from '@shared/types';

/**
 * 워크스페이스의 모델 고르기. 한도에 걸렸을 때 다른 모델로 이어 가는 데 쓴다.
 * 채팅 방식으로 도는 중이면 대화를 끊지 않고 다음 응답부터 바뀐다. 아니면 다음에 시작할 때 듣는다.
 */
export function ModelPicker({ workspace, readOnly, onError, onNote }: { workspace: Workspace; readOnly: boolean; onError: (m: string) => void; onNote: (m: string) => void }) {
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.dure.settings.models().then(setModels).catch(() => setModels([])); }, []);
  if (workspace.agentKind !== 'claude' || readOnly) return null;
  const known = models.some((m) => m.value === workspace.model);
  const change = (value: string): void => {
    setBusy(true);
    window.dure.workspaces.setModel(workspace.id, value)
      .then((r) => onNote(r.applied === 'now' ? '모델을 바꿨습니다. 다음 응답부터 이 모델로 이어 갑니다 (대화는 그대로입니다).' : '모델을 바꿨습니다. 에이전트를 다음에 시작할 때 이 모델로 뜹니다.'))
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <select className="engine-select" value={workspace.model} disabled={busy} onChange={(e) => change(e.target.value)}
      title="이 워크스페이스의 모델. 사용 한도에 걸리면 다른 모델로 바꿔 이어 갈 수 있습니다. 채팅 방식으로 도는 중이면 대화를 끊지 않고 바뀝니다">
      <option value="">모델: 설정의 기본</option>
      {!known && workspace.model && <option value={workspace.model}>모델: {workspace.model}</option>}
      {models.filter((m) => m.value !== 'default').map((m) => <option key={m.value} value={m.value} title={m.description}>모델: {m.name}</option>)}
    </select>
  );
}
