import { useEffect, useState, type ReactNode } from 'react';
import type { AgentKind, PermissionMode, Repo, Workspace } from '@shared/types';

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export const BYPASS_WARNING = '에이전트가 묻지 않고 모든 명령을 실행합니다. 믿는 저장소에서만 켜세요.';

export function NewWorkspaceDialog({ projectId, repos, onClose, onCreated }: {
  projectId: string; repos: Repo[]; onClose: () => void; onCreated: (ws: Workspace) => void;
}) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState('');
  const [agentKind, setAgentKind] = useState<AgentKind>('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repoId) return;
    let alive = true;
    setBranches([]);
    window.dure.repos.branches(repoId).then((list) => {
      if (!alive) return;
      setBranches(list);
      setBaseBranch(list.includes('main') ? 'main' : list.includes('master') ? 'master' : (list[0] ?? ''));
    }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [repoId]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      onCreated(await window.dure.workspaces.create({ projectId, repoId, baseBranch, agentKind, permissionMode, name: name.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="워크스페이스 만들기" onClose={onClose}>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label>저장소</label>
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>기준 브랜치</label>
        <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <span className="hint">이 브랜치에서 새 브랜치와 작업 폴더(worktree)를 만듭니다.</span>
      </div>
      <div className="field">
        <label>에이전트</label>
        <div className="radio-row">
          <label><input type="radio" checked={agentKind === 'claude'} onChange={() => setAgentKind('claude')} /> Claude Code</label>
          <label><input type="radio" checked={agentKind === 'codex'} onChange={() => setAgentKind('codex')} /> Codex</label>
        </div>
      </div>
      <div className="field">
        <label>이름 (선택)</label>
        <input type="text" value={name} placeholder="비워 두면 에이전트가 작업에 맞게 바꿀 수 있습니다" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>권한 모드</label>
        <div className="radio-row">
          <label><input type="radio" checked={permissionMode === 'ask'} onChange={() => setPermissionMode('ask')} /> 승인 필요</label>
          <label><input type="radio" checked={permissionMode === 'bypass'} onChange={() => setPermissionMode('bypass')} /> 승인 생략</label>
        </div>
        <span className="hint">승인 필요: 파일 수정은 자동 승인, 명령 실행은 승인을 거칩니다.</span>
      </div>
      {permissionMode === 'bypass' && <div className="notice">{BYPASS_WARNING}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy || !repoId || !baseBranch} onClick={() => void submit()}>만들기</button>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, checkbox, onClose, onConfirm }: {
  title: string; message: string; confirmLabel: string;
  checkbox?: { label: string }; onClose: () => void; onConfirm: (checked: boolean) => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await onConfirm(checked);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      {error && <div className="error">{error}</div>}
      <div style={{ lineHeight: 1.6 }}>{message}</div>
      {checkbox && (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {checkbox.label}
        </label>
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn danger" disabled={busy} onClick={() => void run()}>{confirmLabel}</button>
      </div>
    </Dialog>
  );
}
