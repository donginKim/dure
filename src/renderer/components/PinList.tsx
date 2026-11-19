import { useEffect, useRef, useState } from 'react';
import type { Pin } from '@shared/types';
import type { Entry } from '../chatView';
import { clock } from '../conversationView';
import { findEntry, pinSourceLabel } from '../pinsView';
import { Markdown } from './Markdown';

const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/**
 * 이 대화에 꽂은 핀의 목록. 줄을 누르면 그 글로 간다.
 * 그 글이 화면에 없으면 (지난 대화, 앞쪽이 줄어듦) 꽂을 때 담아 둔 내용을 그 자리에서 펼쳐 보인다.
 */
export function PinList({ pins, entries, onJump, onClose }: { pins: Pin[]; entries: Entry[]; onJump: (itemId: string) => void; onClose: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (box.current && t && !box.current.contains(t) && !t.closest('.pin-toggle')) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  const go = (pin: Pin): void => {
    if (findEntry(entries, pin)) onJump(pin.itemId);
    else setOpenId((id) => (id === pin.id ? null : pin.id));
  };
  const toNote = (pin: Pin): void => {
    setError('');
    window.dure.notes.create({ title: pin.title, body: pin.body })
      .then(() => setSent((s) => ({ ...s, [pin.id]: true })))
      .catch((e: Error) => setError(clean(e)));
  };
  const remove = (pin: Pin): void => { setError(''); window.dure.pins.remove(pin.id).catch((e: Error) => setError(clean(e))); };

  return (
    <div className="pin-list" ref={box} role="dialog" aria-label="핀">
      <div className="pin-list-head">
        <span className="pin-list-title">핀 {pins.length > 0 && <span className="count">{pins.length}</span>}</span>
        <button className="btn ghost" onClick={onClose} title="닫기 (Esc)">닫기</button>
      </div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      {pins.length === 0 && <div className="pin-empty">글에 마우스를 올려 핀을 꽂으면 여기에 모입니다. 대화가 새로 시작돼도 핀은 남습니다.</div>}
      <div className="pin-rows">
        {pins.map((pin) => {
          const here = !!findEntry(entries, pin);
          const open = openId === pin.id;
          return (
            <div key={pin.id} className={`pin-row${open ? ' open' : ''}`}>
              <button className="pin-go" onClick={() => go(pin)} aria-expanded={here ? undefined : open} title={here ? '이 글로 갑니다' : '지난 대화의 글입니다. 담아 둔 내용을 펼칩니다'}>
                <span className="pin-row-title">{pin.title || '(제목 없음)'}</span>
                <span className="pin-row-meta">{pinSourceLabel(pin)} · {clock(pin.createdAt)}{here ? '' : ' · 지난 대화'}</span>
              </button>
              <div className="pin-row-tools">
                {sent[pin.id]
                  ? <span className="pin-sent">메모에 담았습니다</span>
                  : <button className="btn ghost" onClick={() => toNote(pin)} title="이 글을 새 메모로 담습니다">메모로 보내기</button>}
                <button className="btn ghost" onClick={() => remove(pin)} title="이 핀을 뺍니다">빼기</button>
              </div>
              {open && (
                <div className="pin-saved">
                  <div className="pin-saved-note">지난 대화의 글입니다. 담아 둔 내용을 보여 줍니다.</div>
                  <Markdown text={pin.body} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
