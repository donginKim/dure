import { ReviewSection } from './ReviewSection';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommitResult, CommitState, PrInfo, Workspace } from '@shared/types';
import { fileLabel, forgetEdit, pathsToCommit, pushHint, recallEdit, rememberEdit, statusLabel } from '../commitView';
import { clock } from '../conversationView';
import { Dialog } from './dialogs';

/**
 * 커밋 창. 에이전트가 써 둔 메시지를 사용자가 고친 뒤, 커밋과 push 를 직접 누른다.
 * 에이전트는 커밋도 push 도 하지 않는다.
 */
export function CommitDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const [state, setState] = useState<CommitState | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessageRaw] = useState(recallEdit(workspace.id)?.message ?? '');
  // 고치는 글은 칠 때마다 기억해 둔다: 창을 닫거나 커밋이 실패해도 사라지지 않는다.
  const setMessage = (text: string): void => {
    setMessageRaw(text);
    const cur = recallEdit(workspace.id);
    rememberEdit(workspace.id, { base: cur?.base ?? '', draftAt: cur?.draftAt ?? null, message: text });
  };
  const known = useRef<Set<string>>(new Set()); // 이미 목록에서 본 파일
  const [newDraft, setNewDraft] = useState<string | null>(null); // 고치는 중에 에이전트가 새로 쓴 메시지
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  const [error, setError] = useState('');
  const [pushOutput, setPushOutput] = useState('');
  const [pushError, setPushError] = useState('');
  const messageRef = useRef(message);
  messageRef.current = message;

  const load = useCallback(async (selectAll: boolean) => {
    try {
      const s = await window.dure.commit.state(workspace.id);
      setState(s);
      // 처음 보는 파일은 체크한 채로 넣는다 (창을 연 뒤 에이전트가 새로 바꾼 파일). 사용자가 끈 것은 그대로 둔다.
      setChecked((cur) => new Set(s.files.map((f) => f.path).filter((p) => selectAll || cur.has(p) || !known.current.has(p))));
      known.current = new Set(s.files.map((f) => f.path));
      const saved = recallEdit(workspace.id);
      const draft = s.draft?.message ?? '';
      const draftAt = s.draft?.updatedAt ?? null;
      if (!saved) {
        // 처음 여는 것: 에이전트의 초안으로 채운다.
        setMessageRaw(draft);
        rememberEdit(workspace.id, { base: draft, message: draft, draftAt });
      } else if (s.draft && draftAt !== saved.draftAt) {
        // 에이전트가 초안을 새로 썼다. 사용자가 손대지 않았으면 바꾸고, 고치던 중이면 덮어쓰지 않고 알린다.
        if (messageRef.current === saved.base) {
          setMessageRaw(draft);
          rememberEdit(workspace.id, { base: draft, message: draft, draftAt });
        } else if (draft !== messageRef.current) {
          setNewDraft(draft);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load(true);
    return window.dure.onChanged((topic) => { if (topic === 'commit') void load(false); });
  }, [load]);

  const files = state?.files ?? [];
  const allChecked = files.length > 0 && files.every((f) => checked.has(f.path));
  const toggle = (path: string): void => setChecked((cur) => {
    const next = new Set(cur);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const commit = async (): Promise<void> => {
    if (!state) return;
    setBusy('commit'); setError(''); setCommitted(null);
    try {
      const res = await window.dure.commit.run(workspace.id, { files: pathsToCommit(files, checked), message });
      setCommitted(res);
      setMessageRaw('');
      setNewDraft(null);
      forgetEdit(workspace.id); // 커밋했으니 고치던 글은 더 필요 없다
      await load(true);
    } catch (e) {
      setError((e as Error).message); // 고친 메시지는 그대로 둔다
    } finally {
      setBusy(null);
    }
  };

  const push = async (): Promise<void> => {
    setBusy('push'); setPushError(''); setPushOutput('');
    try {
      setPushOutput(await window.dure.commit.push(workspace.id) || 'push 했습니다.');
      await load(false);
    } catch (e) {
      setPushError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const hint = state ? pushHint(state) : null;
  const edited = (recallEdit(workspace.id)?.base ?? '') !== message;

  return (
    <Dialog title="커밋" onClose={onClose} wide>
      <div className="commit-branch">{state ? state.branch : '읽는 중…'}</div>

      <div className="commit-files">
        {files.length === 0 && state && <div className="muted commit-none">커밋할 변경이 없습니다.</div>}
        {files.length > 0 && (
          <label className="commit-file all">
            <input type="checkbox" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(files.map((f) => f.path)))} />
            <span className="grow">전체 선택</span>
            <span className="muted">{checked.size}/{files.length}</span>
          </label>
        )}
        {files.map((f) => (
          <label className="commit-file" key={f.path}>
            <input type="checkbox" checked={checked.has(f.path)} onChange={() => toggle(f.path)} />
            <span className={`commit-status ${f.status}`}>{statusLabel(f.status)}</span>
            <span className="commit-path grow" title={fileLabel(f)}>{fileLabel(f)}</span>
            {f.added !== null && <span className="commit-stat"><i className="plus">+{f.added}</i> <i className="minus">−{f.removed ?? 0}</i></span>}
          </label>
        ))}
      </div>

      {state?.merging && (
        <div className="thread-notice">
          <span className="grow">병합이 진행 중입니다. 일부 파일만 커밋할 수 없어 전체를 한 번에 커밋합니다.</span>
        </div>
      )}
      <ReviewSection workspaceId={workspace.id} hasChanges={(state?.files.length ?? 0) > 0} />
      <div className="commit-msg-head">
        <span>커밋 메시지</span>
        {state?.draft && !edited && <span className="muted">에이전트가 작성 · {clock(state.draft.updatedAt)}</span>}
        {edited && <span className="muted">고치는 중</span>}
      </div>
      {newDraft !== null && (
        <div className="thread-notice">
          <span className="grow">에이전트가 메시지를 새로 썼습니다.</span>
          <button
            className="btn accent"
            onClick={() => {
              setMessageRaw(newDraft);
              rememberEdit(workspace.id, { base: newDraft, message: newDraft, draftAt: state?.draft?.updatedAt ?? null });
              setNewDraft(null);
            }}
          >불러오기</button>
        </div>
      )}
      <textarea
        className="commit-msg"
        rows={9}
        value={message}
        spellCheck={false}
        placeholder={'에이전트에게 "커밋 메시지 써 줘" 라고 하거나 직접 쓰세요.'}
        onChange={(e) => setMessage(e.target.value)}
      />

      {error && <pre className="error commit-out">{error}</pre>}
      {committed && <div className="commit-done">커밋했습니다: <code>{committed.hash}</code> {committed.subject}</div>}

      <div className="commit-actions">
        <button className="btn primary" disabled={busy !== null || checked.size === 0 || !message.trim()} onClick={() => void commit()}>
          {busy === 'commit' ? '커밋하는 중…' : '커밋'}
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>닫기</button>
      </div>

      <div className="commit-push">
        <div className="grow">
          <div className="commit-push-title">push</div>
          <div className="muted commit-push-hint">{hint?.text ?? ''}</div>
        </div>
        <button className="btn" disabled={busy !== null || !hint?.canPush} onClick={() => void push()}>
          {busy === 'push' ? 'push 하는 중…' : 'push'}
        </button>
      </div>
      {pushError && <pre className="error commit-out">{pushError}</pre>}
      {pushOutput && <pre className="commit-out ok">{pushOutput}</pre>}
      <PrSection workspaceId={workspace.id} refresh={`${pushOutput}|${committed?.hash ?? ''}`} />
    </Dialog>
  );
}

/** PR 만들기: push 한 브랜치로 기준 브랜치에 들어가는 PR 을 만든다. 제목과 설명은 에이전트의 초안이나 커밋 제목으로 채워진다. */
function PrSection({ workspaceId, refresh }: { workspaceId: string; refresh: string }) {
  const [info, setInfo] = useState<PrInfo | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState('');
  useEffect(() => {
    let alive = true;
    window.dure.pr.info(workspaceId).then((i) => { if (!alive) return; setInfo(i); setTitle((t) => t || i.title); setBody((b) => b || i.body); }).catch(() => undefined);
    return () => { alive = false; };
  }, [workspaceId, refresh]);
  if (!info || !info.url) return null;
  const create = (): void => {
    setBusy(true); setError('');
    window.dure.pr.create(workspaceId, { title, body }).then(setMade).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="commit-pr">
      <div className="commit-push">
        <div className="grow">
          <div className="commit-push-title">PR</div>
          <div className="muted commit-push-hint">{info.head} → {info.base}{info.pushed ? '' : ' · 먼저 push 해야 합니다 (올라간 커밋으로 만듭니다)'}</div>
        </div>
        <button className="btn" disabled={!info.pushed} onClick={() => setOpen((v) => !v)}>{open ? '접기' : 'PR 만들기…'}</button>
      </div>
      {open && info.pushed && (
        <div className="commit-pr-form">
          <input type="text" value={title} placeholder="PR 의 제목" onChange={(e) => setTitle(e.target.value)} />
          <textarea value={body} rows={6} placeholder="PR 의 설명 (무엇을 왜 바꿨는지, 어떻게 확인했는지)" onChange={(e) => setBody(e.target.value)} />
          <div className="commit-actions">
            {info.canCreate && <button className="btn primary" disabled={busy || !title.trim()} onClick={create}>{busy ? '만드는 중…' : 'PR 만들기'}</button>}
            <button className="btn" onClick={() => { void window.dure.pr.open(workspaceId).catch((e: Error) => setError(e.message)); }}>브라우저에서 열기</button>
            {!info.canCreate && <span className="muted commit-push-hint">{info.host === 'github' ? 'gh (GitHub CLI) 가 없어 브라우저에서 만듭니다. 제목과 설명은 복사해 붙이세요.' : '이 저장소는 브라우저에서 만듭니다. 제목과 설명은 복사해 붙이세요.'}</span>}
          </div>
        </div>
      )}
      {error && <pre className="error commit-out">{error}</pre>}
      {made && <div className="commit-done">PR 을 만들었습니다: <button className="link" onClick={() => { void window.dure.pr.open(workspaceId, made); }}>{made}</button></div>}
    </div>
  );
}
