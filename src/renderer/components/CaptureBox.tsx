import { useEffect, useRef, useState } from 'react';

/** 빠른 메모 입력 창 (전역 단축키로 뜬다). Enter 로 적고 닫는다. Shift+Enter 는 줄바꿈, Esc 는 닫기. */
export function CaptureBox() {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    document.documentElement.classList.add('capture-window');
    window.dure.settings.get().then((s) => { document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark'; }).catch(() => undefined);
    ref.current?.focus();
  }, []);
  const save = (): void => {
    if (!text.trim()) { window.close(); return; }
    window.dure.captures.add(text).then(() => window.close()).catch((e: Error) => setError(e.message));
  };
  return (
    <div className="capture">
      <div className="capture-title">빠른 메모 <span className="muted">Enter 적기 · Shift+Enter 줄바꿈 · Esc 닫기</span></div>
      <textarea ref={ref} value={text} rows={3} placeholder="떠오른 일을 적어 두세요. 두레의 받은 메모에 쌓입니다." onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') window.close(); else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); } }} />
      {error && <div className="error">{error}</div>}
    </div>
  );
}
