import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangedFile, FileDiff, Workspace } from '@shared/types';
import { diffLineKind } from '../browserView';

const STATUS: Record<ChangedFile['status'], string> = { added: '추가', modified: '수정', deleted: '삭제', renamed: '이름 바뀜', untracked: '새 파일' };

/** 워크스페이스의 "변경" 보기: 마지막 커밋 뒤에 바뀐 파일과 그 내용. 보기만 한다 (커밋은 "커밋" 버튼으로). */
export function DiffPane({ workspace }: { workspace: Workspace }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const load = useCallback(() => {
    window.dure.commit.state(workspace.id).then((s) => { setFiles(s.files); setError(''); }).catch((e: Error) => setError(e.message));
  }, [workspace.id]);
  useEffect(() => {
    load();
    // 에이전트가 파일을 고치면 워크스페이스 상태가 바뀐다: 그때 다시 읽는다.
    return window.dure.onChanged((topic) => { if (topic === 'commit' || topic === 'workspaces') load(); });
  }, [load]);

  const current = files?.find((f) => f.path === picked) ?? files?.[0] ?? null;
  const path = current?.path ?? null;
  const stamp = files?.map((f) => `${f.path}:${f.status}:${f.added}:${f.removed}`).join('|') ?? '';
  useEffect(() => {
    if (!path) { setDiff(null); return; }
    const mine = ++seq.current;
    window.dure.commit.diff(workspace.id, path)
      .then((d) => { if (mine === seq.current) { setDiff(d); setError(''); } })
      .catch((e: Error) => { if (mine === seq.current) { setDiff(null); setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } });
  }, [workspace.id, path, stamp]);

  if (!files) return <div className="diff"><div className="chat-empty">{error || '바뀐 파일을 읽는 중…'}</div></div>;
  if (files.length === 0) return <div className="diff"><div className="chat-empty">마지막 커밋 뒤에 바뀐 파일이 없습니다.</div></div>;
  return (
    <div className="diff">
      <div className="diff-files">
        <div className="diff-files-head">바뀐 파일 <span className="count">{files.length}</span><button className="btn ghost" title="다시 읽습니다" onClick={load}>새로 고침</button></div>
        <div className="diff-files-list">
          {files.map((f) => (
            <button key={f.path} className={`diff-file${f.path === path ? ' on' : ''}`} title={f.from ? `${f.from} → ${f.path}` : f.path} onClick={() => setPicked(f.path)}>
              <span className={`diff-st ${f.status}`}>{STATUS[f.status]}</span>
              <span className="diff-name">{f.path}</span>
              {f.added !== null && <span className="diff-num"><i className="add">+{f.added}</i> <i className="del">-{f.removed ?? 0}</i></span>}
            </button>
          ))}
        </div>
      </div>
      <div className="diff-body">
        {error && <div className="error" style={{ margin: 12 }}>{error}</div>}
        {current && <div className="diff-title">{current.from ? `${current.from} → ` : ''}{current.path}</div>}
        {diff?.binary && <div className="chat-empty">이진 파일입니다. 내용을 보여 주지 않습니다.</div>}
        {diff && !diff.binary && diff.text === '' && <div className="chat-empty">보여 줄 변경이 없습니다 (권한만 바뀌었거나 빈 파일입니다).</div>}
        {diff && !diff.binary && diff.text !== '' && (
          <pre className="diff-text">
            {diff.text.split('\n').map((line, i) => <div key={i} className={`dl ${diffLineKind(line)}`}>{line || ' '}</div>)}
            {diff.truncated && <div className="dl meta">… 길어서 뒤를 잘랐습니다. 전체는 셸에서 git diff 로 보세요.</div>}
          </pre>
        )}
      </div>
    </div>
  );
}
