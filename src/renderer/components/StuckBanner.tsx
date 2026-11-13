import { useState } from 'react';
import type { StuckInfo, Workspace } from '@shared/types';

/**
 * 에이전트가 막힌 것 같을 때 채팅 위에 뜨는 띠. 같은 오류를 되풀이하거나, 일하는 중인데 오래 움직임이 없을 때.
 * "멈추고 방법 바꾸게 하기" 는 하던 일을 멈추고 원인을 다시 보라고 보낸다.
 */
export function StuckBanner({ workspace, stuck, onError }: { workspace: Workspace; stuck: StuckInfo; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const min = Math.max(1, Math.round((Date.now() - stuck.since) / 60_000));
  const redirect = (): void => {
    setBusy(true);
    const why = stuck.reason === 'repeat' ? `같은 오류를 ${stuck.count}번 되풀이했다` : `${min}분 동안 아무 진전이 없었다`;
    window.dure.workspaces.interrupt(workspace.id)
      .then(() => window.dure.chat.send(workspace.id, `[두레] ${why}. 같은 방법을 다시 하지 말고 멈춰서 원인을 다시 살펴라: 무엇을 하려 했고, 무엇이 막혔고, 다른 방법이 무엇인지 짧게 적어라. 네가 풀 수 없는 것(권한, 환경, 다른 워크스페이스의 일)이면 사용자에게 물어라.`))
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="limit-band rejected stuck-band">
      <div className="grow">
        {stuck.reason === 'repeat'
          ? <>같은 오류를 <b>{stuck.count}번</b> 되풀이하고 있습니다. 막힌 것 같습니다.{stuck.detail && <code className="stuck-detail">{stuck.detail}</code>}</>
          : <>{min}분 동안 아무 움직임이 없습니다. 멈춰 있는 것 같습니다.</>}
      </div>
      <button className="btn" disabled={busy} onClick={redirect} title="하던 일을 멈추고, 같은 방법을 되풀이하지 말고 원인을 다시 보라고 보냅니다">멈추고 방법 바꾸게 하기</button>
      <button className="btn ghost" disabled={busy} onClick={() => { window.dure.workspaces.dismissStuck(workspace.id).catch((e: Error) => onError(e.message)); }}>그대로 두기</button>
    </div>
  );
}
