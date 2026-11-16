import { layout, PANEL } from '../layout';
import { Resizer } from './Resizer';

/** 오른쪽 칸(TODO·대화·그림)의 왼쪽 가장자리: 끌어서 너비를 바꾼다. 너비는 모든 워크스페이스가 같이 쓴다. */
export function PanelResizer() {
  const width = (x: number, el: HTMLElement): number => (el.parentElement?.getBoundingClientRect().right ?? window.innerWidth) - x;
  return (
    <Resizer className="resizer resizer-panel" label="오른쪽 칸 너비"
      onDrag={(x, el) => layout.setPanel(width(x, el), false)}
      onDone={(x, el) => layout.setPanel(width(x, el), true)}
      onReset={() => layout.setPanel(null, true)}
      onNudge={(d, el) => layout.setPanel((el.parentElement?.getBoundingClientRect().width ?? PANEL.base) - d * 16, true)} />
  );
}
