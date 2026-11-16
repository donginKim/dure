/**
 * 자주 오는 변경 알림에 화면이 끌려다니지 않게 한다: 처음 것은 바로 하고, 그 뒤 ms 안에 온 것은 모아 한 번만 한다.
 * 창이 가려져 있으면(document.hidden) 미뤘다가 다시 보일 때 한 번 한다: 보지 않는 화면을 위해 일하지 않는다.
 * 돌려준 함수의 cancel() 로 걸어 둔 것을 거둔다.
 */
export function throttled(fn: () => void, ms: number): (() => void) & { cancel(): void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingHidden = false;
  const run = (): void => { last = Date.now(); timer = undefined; fn(); };
  const onVisible = (): void => { if (!document.hidden && pendingHidden) { pendingHidden = false; call(); } };
  const call = (): void => {
    if (typeof document !== 'undefined' && document.hidden) { pendingHidden = true; return; }
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) run(); else timer = setTimeout(run, wait);
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  return Object.assign(call, { cancel: (): void => { if (timer) clearTimeout(timer); timer = undefined; if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible); } });
}
