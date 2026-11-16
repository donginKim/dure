/** 양옆 칸의 너비와 접힘. 이 PC 의 보기 설정일 뿐이라 화면 쪽 저장소에만 둔다 (못 읽어도 기본 모양으로 뜬다). */
const KEY = 'dure.layout';
export const SIDE = { min: 200, max: 480, base: 280 } as const;
export const PANEL = { min: 220, max: 720, base: 340 } as const;

type Layout = { side: number; panel: number | null; sideOff: boolean };
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));

function read(): Layout {
  const base: Layout = { side: SIDE.base, panel: null, sideOff: false };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout>;
    return {
      side: typeof v.side === 'number' ? clamp(v.side, SIDE.min, SIDE.max) : base.side,
      panel: typeof v.panel === 'number' ? clamp(v.panel, PANEL.min, PANEL.max) : null,
      sideOff: v.sideOff === true,
    };
  } catch { return base; }
}

let state = read();
const listeners = new Set<() => void>();

function apply(): void {
  const root = document.documentElement;
  root.style.setProperty('--side-w', state.sideOff ? '0px' : `${state.side}px`);
  if (state.sideOff) root.dataset.side = 'off'; else delete root.dataset.side;
  if (state.panel === null) { root.style.removeProperty('--panel-w'); delete root.dataset.panel; } else { root.style.setProperty('--panel-w', `${state.panel}px`); root.dataset.panel = 'set'; }
}
function save(): void { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 저장 못 해도 화면은 그대로 */ } }
function set(next: Partial<Layout>, keep: boolean): void {
  state = { ...state, ...next };
  apply();
  if (keep) save();
  for (const l of listeners) l();
}

export const layout = {
  init: apply,
  sideOff: (): boolean => state.sideOff,
  subscribe: (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** 끄는 동안에는 저장하지 않는다 (놓을 때 한 번). */
  setSide: (w: number, keep: boolean): void => set({ side: clamp(w, SIDE.min, SIDE.max), sideOff: false }, keep),
  setPanel: (w: number | null, keep: boolean): void => set({ panel: w === null ? null : clamp(w, PANEL.min, PANEL.max) }, keep),
  resetSide: (): void => set({ side: SIDE.base, sideOff: false }, true),
  toggleSide: (): void => set({ sideOff: !state.sideOff }, true),
};
