import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, NoteSummary } from '@shared/types';
import { markMatches, noteHeading, noteTime } from '../notesView';

const Marked = ({ text, query }: { text: string; query: string }) => <>{markMatches(text, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;

/**
 * 메모장. 프로젝트와 상관없이 하나이고, 어느 화면에서든 오른쪽에 열어 쓴다.
 * 적는 대로 저장된다 (저장 버튼이 없다). 위의 칸으로 제목과 본문에서 찾는다.
 */
export function NotesPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [list, setList] = useState<NoteSummary[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 아직 저장하지 않은 글. 닫거나 다른 메모로 갈 때 먼저 저장한다.
  const pending = useRef<{ id: string; title: string; body: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const search = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    window.dure.notes.list(query).then(setList).catch((e: Error) => setError(e.message));
  }, [query]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'notes') load(); });
  }, [load]);
  // 열어 둔 메모를 다른 쪽(에이전트)이 바꾸면 따라간다. 내가 적는 중이면 내 글이 먼저다.
  const openId = note?.id;
  useEffect(() => {
    if (!openId) return undefined;
    return window.dure.onChanged((topic) => {
      if (topic !== 'notes' || pending.current) return;
      void window.dure.notes.get(openId).then((n) => { if (n && !pending.current) setNote((cur) => (cur && cur.id === n.id && cur.updatedAt !== n.updatedAt ? n : cur)); });
    });
  }, [openId]);

  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    try { await window.dure.notes.update(p.id, { title: p.title, body: p.body }); setSaved(true); } catch (e) { setError((e as Error).message); }
  }, []);
  // 패널이 닫힐 때 남은 글을 저장한다.
  useEffect(() => () => { void flush(); }, [flush]);

  const edit = (patch: Partial<Pick<Note, 'title' | 'body'>>): void => {
    if (!note) return;
    const next = { ...note, ...patch };
    setNote(next);
    setSaved(false);
    pending.current = { id: next.id, title: next.title, body: next.body };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 500);
  };
  const open = async (id: string): Promise<void> => {
    await flush();
    setError(''); setConfirmDelete(false);
    const n = await window.dure.notes.get(id).catch(() => null);
    if (n) setNote(n); else { setError('메모가 없습니다 (지워졌을 수 있습니다).'); load(); }
  };
  const create = async (): Promise<void> => {
    await flush();
    setError(''); setConfirmDelete(false);
    try { setNote(await window.dure.notes.create()); } catch (e) { setError((e as Error).message); }
  };
  const back = async (): Promise<void> => {
    await flush();
    // 아무것도 적지 않은 새 메모는 남기지 않는다.
    if (note && !note.title.trim() && !note.body.trim()) await window.dure.notes.remove(note.id).catch(() => undefined);
    setNote(null); setConfirmDelete(false);
    load();
    requestAnimationFrame(() => search.current?.focus());
  };
  const remove = async (): Promise<void> => {
    if (!note) return;
    clearTimeout(timer.current); pending.current = null;
    await window.dure.notes.remove(note.id).catch((e: Error) => setError(e.message));
    setNote(null); setConfirmDelete(false);
    load();
  };

  return (
    <aside className="notes" aria-label="메모">
      <div className="notes-head">
        {note ? <button className="btn ghost" onClick={() => void back()} title="메모 목록으로">‹ 목록</button> : <div className="notes-title">메모</div>}
        <span className="spacer" />
        {note && <span className="notes-saved">{saved ? '저장됨' : '저장하는 중…'}</span>}
        {note && (confirmDelete
          ? <><button className="btn danger" onClick={() => void remove()}>지우기</button><button className="btn ghost" onClick={() => setConfirmDelete(false)}>취소</button></>
          : <button className="btn ghost" onClick={() => setConfirmDelete(true)} title="이 메모를 지웁니다">지우기…</button>)}
        <button className="btn ghost" onClick={() => { void flush().then(onClose); }} title="메모를 닫습니다 (⌘⇧M)">닫기</button>
      </div>
      {error && <div className="error" style={{ margin: '0 12px 8px' }} onClick={() => setError('')}>{error}</div>}
      {note ? (
        <div className="notes-edit">
          <input type="text" className="notes-name" value={note.title} placeholder="제목 (비워도 됩니다)" onChange={(e) => edit({ title: e.target.value })} />
          <textarea className="notes-body" value={note.body} autoFocus placeholder="여기에 적으세요. 적는 대로 저장됩니다." onChange={(e) => edit({ body: e.target.value })} />
        </div>
      ) : (
        <>
          <div className="notes-tools">
            <input ref={search} type="search" className="notes-search" value={query} autoFocus placeholder="메모에서 찾기 (제목, 본문)" onChange={(e) => setQuery(e.target.value)} />
            <button className="btn primary" onClick={() => void create()}>+ 새 메모</button>
          </div>
          <div className="notes-list">
            {list.length === 0 && <div className="notes-empty">{query.trim() ? `"${query.trim()}" 이(가) 든 메모가 없습니다.` : '메모가 없습니다. "+ 새 메모" 로 적어 보세요. 프로젝트와 상관없이 어디서든 열어 쓸 수 있습니다.'}</div>}
            {list.map((n) => (
              <button key={n.id} className="notes-item" onClick={() => void open(n.id)}>
                <div className="notes-item-head"><span className="notes-item-title"><Marked text={noteHeading(n.title, n.preview)} query={query} /></span><span className="notes-item-time">{noteTime(n.updatedAt)}</span></div>
                {n.preview && <div className="notes-item-preview"><Marked text={n.preview} query={query} /></div>}
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
