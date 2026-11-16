import { useRef } from 'react';

/** 칸의 가장자리를 잡아 끌어 너비를 바꾼다. 두 번 누르면 처음 너비로. 화살표 키로도 움직인다. */
export function Resizer({ className, label, onDrag, onDone, onReset, onNudge }: {
  className: string; label: string;
  /** 끄는 동안: 포인터의 가로 자리와 손잡이 */
  onDrag: (x: number, el: HTMLElement) => void;
  /** 놓았을 때 */
  onDone: (x: number, el: HTMLElement) => void;
  onReset: () => void;
  /** 화살표 키: 왼쪽 -1, 오른쪽 +1 */
  onNudge: (dir: -1 | 1, el: HTMLElement) => void;
}) {
  const dragging = useRef(false);
  return (
    <div
      className={className} role="separator" aria-orientation="vertical" aria-label={label} title={`${label} (두 번 누르면 처음 너비)`} tabIndex={0}
      onPointerDown={(e) => { if (e.button !== 0) return; dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); document.documentElement.classList.add('resizing'); e.preventDefault(); }}
      onPointerMove={(e) => { if (dragging.current) onDrag(e.clientX, e.currentTarget); }}
      onPointerUp={(e) => { if (!dragging.current) return; dragging.current = false; document.documentElement.classList.remove('resizing'); onDone(e.clientX, e.currentTarget); }}
      onPointerCancel={() => { dragging.current = false; document.documentElement.classList.remove('resizing'); }}
      onDoubleClick={onReset}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onNudge(e.key === 'ArrowLeft' ? -1 : 1, e.currentTarget); } }}
    />
  );
}
