import { useCallback, useEffect, useState } from 'react';
import type { AgentConfig } from '@shared/types';

/**
 * 작업 폴더에 에이전트 설정 파일(.claude/settings.json, .mcp.json)이 있고 아직 허용하지 않았을 때 뜨는 띠.
 * 이 파일의 hook·권한·MCP 서버는 에이전트를 켜는 순간 이 PC 에서 쓰인다: 내용을 보고 허용해야 에이전트가 켜진다.
 * 내용이 바뀌면(받아 온 변경, 에이전트가 고침) 다시 묻는다.
 */
export function AgentConfigGate({ workspaceId }: { workspaceId: string }) {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.workspaces.agentConfig(workspaceId).then(setCfg).catch(() => undefined); }, [workspaceId]);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'terminals' || topic === 'workspaces') load(); }); }, [load]);
  if (!cfg || cfg.trusted) return null;
  return (
    <div className="member-nowork agent-config" role="alert">
      <div className="grow">
        <b>이 저장소에 에이전트 설정 파일이 있습니다</b>
        <div className="muted">{cfg.files.map((f) => f.path).join(', ')} · 에이전트를 켜면 여기 적힌 hook(명령 실행)·권한 허용·MCP 서버가 이 PC 에서 쓰입니다. 내용을 보고 허용해야 에이전트가 켜집니다.</div>
        {error && <div className="error" onClick={() => setError('')}>{error}</div>}
        {open && cfg.files.map((f) => (
          <div key={f.path} className="agent-config-file">
            <div className="plug-label">{f.path}{f.cut ? ' (앞부분만 보입니다)' : ''}</div>
            <pre className="plug-pre">{f.text}</pre>
          </div>
        ))}
      </div>
      <button className="btn ghost" aria-expanded={open} onClick={() => { setOpen((v) => !v); load(); }}>{open ? '접기' : '내용 보기'}</button>
      <button className="btn primary" title="지금 보이는 내용을 이 저장소에서 허용합니다. 내용이 바뀌면 다시 묻습니다" onClick={() => { if (!open) { setOpen(true); return; } setError(''); window.dure.workspaces.trustAgentConfig(workspaceId, cfg.hash).then(load).catch((e: Error) => { setError(e.message); load(); }); }}>{open ? '이 내용 허용' : '내용 보고 허용'}</button>
    </div>
  );
}
