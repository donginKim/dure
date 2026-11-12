import { EventEmitter } from 'node:events';
import type { BrowserRequest, Settings } from '@shared/types';
import type { MessageService } from './messages';
import type { WorkspaceStore } from './stores';

/**
 * 워크스페이스의 내장 브라우저 페이지를 실제로 움직이는 쪽. 앱에서는 Electron 메인 프로세스가 구현한다 (코어는 Electron 을 모른다).
 * 페이지는 워크스페이스마다 하나이고, 화면의 "브라우저" 보기에 보이는 바로 그 페이지다.
 */
export interface BrowserDriver {
  /**
   * 그 워크스페이스의 페이지가 있게 한다 (없으면 화면에 만들게 한다). 만들 수 없으면 던진다.
   * 새로 만들었으면 true: 그 페이지는 이미 url 을 불러오고 있다 (다시 이동시키지 않는다).
   */
  ensure(workspaceId: string, url: string): Promise<boolean>;
  navigate(workspaceId: string, url: string): Promise<void>;
  info(workspaceId: string): Promise<{ url: string; title: string }>;
  /** 페이지 안에서 식을 실행하고 값을 돌려준다 (JSON 으로 옮길 수 있는 값) */
  evaluate(workspaceId: string, expression: string): Promise<unknown>;
  /** 불러오는 중이면 끝날 때까지 기다린다 (누른 것이 다른 페이지로 넘어가게 했을 때) */
  idle(workspaceId: string): Promise<void>;
  /** 보이는 화면을 그림으로 (base64) */
  screenshot(workspaceId: string): Promise<{ data: string; mimeType: string }>;
  /** 지금 페이지의 콘솔 경고·오류와 불러오지 못한 것 (다른 페이지로 넘어가면 비워진다) */
  logs(workspaceId: string): string[];
  /** 페이지와 그 안의 모든 프레임(iframe)의 주소 */
  frames(workspaceId: string): string[];
  /** 페이지가 다른 문서로 넘어간 횟수. 작업 전후로 달라졌으면 그 사이에 페이지가 바뀐 것이다 */
  navigations(workspaceId: string): number;
}

export const noBrowser: BrowserDriver = new Proxy({} as BrowserDriver, {
  get: () => () => { throw new Error('이 환경에서는 내장 브라우저를 쓸 수 없다.'); },
});

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost)$/i;
const MAX_SNAPSHOT = 15_000;
export const BROWSER_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'] as const;

/** 설정의 "허용할 주소" 를 호스트 목록으로. 잘못된 것은 버린다. */
/** 호스트 이름으로 쓸 수 있는가: 점으로 나뉜 둘 이상의 라벨, 라벨은 영문·숫자·- 이고 - 로 시작하거나 끝나지 않는다. */
export const validHost = (h: string): boolean => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(h);

export function parseHosts(raw: string): string[] {
  return raw.split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '')).filter(validHost);
}

/** 에이전트가 이 주소의 페이지를 보거나 조작해도 되는가. 로컬 주소와, 사용자가 설정에 적은 호스트(그 하위 도메인 포함)만 된다. */
export function allowedUrl(url: string, extraHosts: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (LOCAL.test(host) || LOCAL.test(`[${host}]`)) return true;
  return extraHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * 페이지 안에서 도는 글: 보이는 요소를 훑어 번호(ref)를 붙이고 한 줄씩 적는다.
 * 누를 수 있는 것과 입력칸에만 번호가 붙는다. 번호는 요소의 data-dure-ref 속성에 남겨, 뒤의 누르기·입력이 같은 요소를 찾는다.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const MAX = ${MAX_SNAPSHOT};
  const lines = [];
  let n = 0, size = 0, cut = false;
  for (const old of document.querySelectorAll('[data-dure-ref]')) old.removeAttribute('data-dure-ref');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const one = (s, max) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const push = (line) => { if (cut) return; size += line.length + 1; if (size > MAX) { cut = true; return; } lines.push(line); };
  const label = (el) => one(el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.value || '', 120);
  const walk = (node, depth) => {
    for (const el of node.children) {
      if (cut) return;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'head'].includes(tag)) continue;
      if (!visible(el)) continue;
      const pad = '  '.repeat(Math.min(depth, 6));
      const role = el.getAttribute('role');
      const clickable = tag === 'a' || tag === 'button' || tag === 'summary' || role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' || role === 'checkbox' || role === 'option' || el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const ref = ++n; el.setAttribute('data-dure-ref', String(ref));
        const type = tag === 'input' ? (el.getAttribute('type') || 'text') : tag;
        const secret = type === 'password';
        const state = type === 'checkbox' || type === 'radio' ? (el.checked ? ' 선택됨' : ' 선택 안 됨') : '';
        const value = secret ? (el.value ? ' 값=(숨김)' : '') : (tag === 'select' ? ' 값="' + one(el.selectedOptions[0]?.text, 60) + '"' : (el.value ? ' 값="' + one(el.value, 80) + '"' : ''));
        const name = one(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '', 80);
        push(pad + '[' + ref + '] 입력(' + type + ')' + (name ? ' "' + name + '"' : '') + value + state + (el.disabled ? ' 꺼짐' : ''));
        if (tag === 'select') push(pad + '  선택지: ' + [...el.options].slice(0, 20).map((o) => one(o.text, 30)).join(' | '));
        continue;
      }
      if (clickable) {
        const ref = ++n; el.setAttribute('data-dure-ref', String(ref));
        const kind = tag === 'a' || role === 'link' ? '링크' : '버튼';
        push(pad + '[' + ref + '] ' + kind + ' "' + label(el) + '"' + (el.disabled || el.getAttribute('aria-disabled') === 'true' ? ' 꺼짐' : ''));
        continue;
      }
      if (/^h[1-6]$/.test(tag)) { push(pad + '제목' + tag[1] + ': ' + one(el.innerText, 160)); continue; }
      if (tag === 'img') { const alt = one(el.getAttribute('alt'), 80); if (alt) push(pad + '그림: ' + alt); continue; }
      // 자식 요소가 없는 글 덩어리
      const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ');
      const text = one(own, 300);
      if (text) push(pad + text);
      walk(el, depth + 1);
    }
  };
  walk(document.body ?? document.documentElement, 0);
  return { url: location.href, title: document.title, lines, refs: n, cut };
})()`;

/*
 * 누르기와 입력은 페이지 안에서 도는 글로 한다 (진짜 마우스·키보드 입력을 보내지 않는다).
 * 이유: 보기에 나와 있지 않은 페이지는 Chromium 이 숨은 것으로 다뤄 진짜 입력을 버리거나 한참 뒤에 처리한다 (실측).
 * 에이전트는 사용자가 다른 화면을 보는 동안에도 페이지를 써야 한다. 한계: 드래그, 마우스를 올려야 나오는 메뉴 같은 것은 되지 않는다.
 */
/** 스크립트가 도는 문서가 기대한 주소(origin)의 것이 아니면 아무것도 하지 않는다: 확인과 실행 사이에 페이지가 넘어갔을 수 있다. */
const GUARD = (origin: string): string => `if (location.origin !== ${JSON.stringify(origin)}) return { moved: true };`;
const FIND = (ref: number, origin: string): string => `${GUARD(origin)} const el = document.querySelector('[data-dure-ref="${ref}"]'); if (!el) return { missing: true };`;

/** 요소를 누른다: 누르는 동안의 이벤트를 차례로 내고, 기본 동작(링크 이동, 체크, 폼 보내기)이 일어나게 click() 을 부른다. */
const CLICK = (ref: number, origin: string): string => `(() => {
  ${FIND(ref, origin)}
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { disabled: true };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', at));
  if (typeof el.focus === 'function') el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', at));
  el.click();
  return { ok: true };
})()`;

/** 입력칸의 값을 바꾼다. 화면 라이브러리(React 등)가 알아채도록 원래의 값 넣기 함수를 쓰고 input, change 이벤트를 낸다. */
const TYPE = (ref: number, text: string, origin: string): string => `(() => {
  ${FIND(ref, origin)}
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return { notInput: tag };
  if (el.disabled || el.readOnly) return { disabled: true };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`;

/** 초점이 있는 곳에 키를 누른다. 키 이벤트를 내고, 페이지가 막지 않았으면 그 키의 기본 동작을 흉내 낸다. */
const PRESS = (key: string, origin: string): string => `(() => {
  ${GUARD(origin)}
  const key = ${JSON.stringify(key)};
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
  const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
  const init = { key: key === 'Space' ? ' ' : key, code: key, keyCode: codes[key], which: codes[key], bubbles: true, cancelable: true, composed: true };
  const went = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (went && (key === 'Enter' || key === 'Space')) el.dispatchEvent(new KeyboardEvent('keypress', init));
  if (went) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (key === 'Enter') {
      if (tag === 'button' || tag === 'a' || tag === 'summary' || (tag === 'input' && ['submit', 'button', 'checkbox', 'radio'].includes(type))) el.click();
      else if (tag === 'input' && el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
    } else if (key === 'Space') {
      if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'checkbox', 'radio'].includes(type))) el.click();
    } else if (key === 'Tab') {
      const all = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((x) => !x.disabled && x.tabIndex >= 0 && x.getClientRects().length > 0);
      const next = all[(all.indexOf(el) + 1) % Math.max(1, all.length)];
      if (next) next.focus();
    } else if (key === 'PageDown' || key === 'PageUp') window.scrollBy(0, (key === 'PageDown' ? 1 : -1) * window.innerHeight * 0.9);
    else if (key === 'Home') window.scrollTo(0, 0);
    else if (key === 'End') window.scrollTo(0, document.documentElement.scrollHeight);
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true };
})()`;

type Acted = { ok?: boolean; missing?: boolean; disabled?: boolean; notInput?: string; moved?: boolean } | null;

export interface PageSnapshot { url: string; title: string; text: string; refs: number }

const MOVED = '지금 페이지는 에이전트가 볼 수 없는 주소다 (사용자가 다른 곳으로 옮겼거나 페이지가 넘어갔다). 내용을 주지 않는다. browser_open 으로 볼 주소를 다시 열어라.';
const DENY_MS = 2 * 60_000;
type Held = BrowserRequest & { waiter?: (allowed: boolean) => void; late: boolean };

/**
 * 에이전트의 브라우저 조작. 정책(쓸 수 있는가, 어느 주소인가, 사용자가 허용했는가)을 여기서 본다.
 * 사용자는 같은 페이지를 화면에서 아무 주소로나 옮길 수 있으므로, 읽기와 조작을 할 때마다 지금 주소를 다시 확인한다:
 * 허용되지 않은 주소의 내용은 에이전트에게 주지 않는다 (그 주소 자체도 알려 주지 않는다).
 *
 * 한계: 허용한 주소의 페이지는 에이전트가 직접 만든 것일 수 있고, 그 페이지의 스크립트는 브라우저가 허락하는 범위에서 다른 곳에 요청을 보낼 수 있다.
 * 주소 하나를 허용하는 것은 "그 페이지가 할 수 있는 일" 을 허용하는 것이다. 허용 카드에 그렇게 적는다.
 * 이벤트: 'changed' (projectId) — 허용 요청이 생기거나 결정됨
 */
export class BrowserService extends EventEmitter {
  /** 사용자가 허용한 주소 (프로젝트마다). 두레를 다시 켜면 다시 묻는다 */
  private readonly approved = new Set<string>();
  /** 사용자가 방금 거부한 주소와 그 시각: 한동안은 다시 묻지 않고 바로 거절한다 */
  private readonly denied = new Map<string, number>();
  private readonly requests = new Map<string, Held>();
  /** 워크스페이스마다 작업을 한 줄로 세운다: 확인과 실행 사이에 다른 호출이 끼어들지 못한다 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly d: {
    driver: BrowserDriver; workspaces: WorkspaceStore; settings(): Settings; isProjectClosed(projectId: string): boolean;
    /** 늦게 온 결정을 에이전트에게 알리는 데 쓴다 */
    messages?: MessageService;
    waitMs?: number;
  }) {
    super();
  }

  private hosts(): string[] { return parseHosts(this.d.settings().agentBrowserHosts); }
  private key(projectId: string, origin: string): string { return `${projectId}\n${origin}`; }

  private serial<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(workspaceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(workspaceId, tail);
    void tail.then(() => { if (this.queues.get(workspaceId) === tail) this.queues.delete(workspaceId); });
    return next;
  }

  private check(workspaceId: string): string {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error('워크스페이스가 없다.');
    if (this.d.isProjectClosed(ws.projectId)) throw new Error('완료된 프로젝트다.');
    if (this.d.settings().agentBrowser === 'off') throw new Error('사용자가 에이전트의 브라우저 사용을 꺼 두었다. 필요하면 사용자에게 두레 설정에서 켜 달라고 하라.');
    return ws.projectId;
  }

  /** 에이전트가 이 주소의 페이지를 읽거나 조작해도 되는가: 정책에 맞고, (묻는 설정이면) 사용자가 허용했다. */
  private usable(projectId: string, url: string): boolean {
    if (typeof url !== 'string' || !allowedUrl(url, this.hosts())) return false;
    if (this.d.settings().agentBrowser !== 'ask') return true;
    try { return this.approved.has(this.key(projectId, new URL(url).origin)); } catch { return false; }
  }

  /** 지금 페이지가 에이전트에게 허용된 주소인지 본다. 아니면 그 주소를 알려 주지 않고 거절한다. */
  private async here(workspaceId: string, projectId: string): Promise<{ url: string; title: string; origin: string }> {
    const info = await this.d.driver.info(workspaceId);
    if (!info.url || info.url === 'about:blank') throw new Error('열린 페이지가 없다. 먼저 browser_open 으로 주소를 열어라.');
    if (info.url.startsWith('chrome-error:')) throw new Error('페이지를 불러오지 못했다. 개발 서버가 떠 있는지, 주소와 포트가 맞는지 확인하라.');
    if (!this.usable(projectId, info.url)) throw new Error(MOVED);
    return { ...info, origin: new URL(info.url).origin };
  }

  /** 결정을 기다리는 요청. */
  pending(projectId: string): BrowserRequest[] {
    return [...this.requests.values()].filter((r) => r.projectId === projectId).map(({ id, projectId: p, workspaceId, origin, url, createdAt }) => ({ id, projectId: p, workspaceId, origin, url, createdAt }));
  }

  /** 사용자가 주소를 허용하거나 거부한다. 그 프로젝트에서 같은 주소를 묻던 요청을 모두 함께 끝낸다. */
  decide(requestId: string, allow: boolean): void {
    const chosen = this.requests.get(requestId);
    if (!chosen) throw new Error('결정을 기다리는 요청이 아닙니다.');
    const k = this.key(chosen.projectId, chosen.origin);
    if (allow) { this.approved.add(k); this.denied.delete(k); } else this.denied.set(k, Date.now());
    for (const r of [...this.requests.values()].filter((x) => x.projectId === chosen.projectId && x.origin === chosen.origin)) {
      this.requests.delete(r.id);
      if (r.waiter) { r.waiter(allow); continue; }
      // 도구 호출이 이미 돌아갔다: 알림으로 깨운다.
      if (r.late) {
        try {
          this.d.messages?.send({ projectId: r.projectId, from: { kind: 'system' }, toWorkspaceId: r.workspaceId, title: '브라우저', body: allow ? `사용자가 ${r.origin} 을 여는 것을 허용했다. browser_open 을 다시 불러라.` : `사용자가 ${r.origin} 을 여는 것을 거부했다. 다시 요청하지 마라.` });
        } catch { /* 알림 실패가 결정을 바꾸면 안 된다 */ }
      }
    }
    this.emit('changed', chosen.projectId);
  }

  /** 처음 여는 주소면 사용자의 허용을 받는다. 오래 걸리면 기다리는 중이라고 돌려보낸다. */
  private async ask(workspaceId: string, projectId: string, url: string): Promise<void> {
    if (this.usable(projectId, url)) return;
    const origin = new URL(url).origin;
    const refused = this.denied.get(this.key(projectId, origin));
    if (refused && Date.now() - refused < DENY_MS) throw new Error(`사용자가 방금 ${origin} 을 여는 것을 거부했다. 다시 요청하지 말고, 필요하면 사용자에게 이유를 물어라.`);
    const same = [...this.requests.values()].find((r) => r.workspaceId === workspaceId && r.origin === origin);
    if (same) throw new Error(`사용자가 ${origin} 을 여는 것을 아직 허용하지 않았다. 허용되면 두레가 알려 준다. 그때 browser_open 을 다시 불러라.`);
    if ([...this.requests.values()].filter((r) => r.workspaceId === workspaceId).length >= 3) throw new Error('허용을 기다리는 주소가 이미 3개다. 사용자의 결정을 기다려라.');
    const req: Held = { id: crypto.randomUUID(), projectId, workspaceId, origin, url: url.slice(0, 500), createdAt: Date.now(), late: false };
    this.requests.set(req.id, req);
    this.emit('changed', projectId);
    const allowed = await new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => { req.waiter = undefined; resolve(null); }, this.d.waitMs ?? 40_000);
      req.waiter = (v) => { clearTimeout(timer); resolve(v); };
    });
    if (allowed === null) { req.late = true; throw new Error(`사용자가 ${origin} 을 여는 것을 아직 허용하지 않았다 (두레 화면에 요청이 떠 있다). 다른 일을 하거나 턴을 끝내라. 허용되면 두레가 알려 준다. 그때 browser_open 을 다시 불러라.`); }
    if (!allowed) throw new Error(`사용자가 ${origin} 을 여는 것을 거부했다. 다시 요청하지 말고, 필요하면 사용자에게 이유를 물어라.`);
  }

  /** 워크스페이스가 지워지면 그 요청도 없앤다. */
  dropWorkspace(workspaceId: string): void {
    for (const r of [...this.requests.values()]) if (r.workspaceId === workspaceId) { this.requests.delete(r.id); r.waiter?.(false); this.emit('changed', r.projectId); }
  }

  async open(workspaceId: string, url: string): Promise<PageSnapshot> {
    const projectId = this.check(workspaceId);
    const raw = String(url ?? '').trim();
    const typed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    if (!allowedUrl(typed, this.hosts())) throw new Error(`이 주소는 에이전트가 열 수 없다: ${typed.slice(0, 200)}. 로컬 주소(localhost, 127.0.0.1)와 사용자가 두레 설정에 허용한 주소만 된다. 필요하면 사용자에게 허용해 달라고 하라.`);
    // 검사한 것과 여는 것이 같은 글이게 한다 (주소를 읽는 방식의 차이로 다른 곳이 열리지 않게).
    const target = new URL(typed).href;
    // 허용을 기다리는 동안에는 줄을 잡지 않는다 (40초까지 걸린다).
    await this.ask(workspaceId, projectId, target);
    return this.serial(workspaceId, async () => {
      // 기다리는 사이에 설정이 바뀌었을 수 있다.
      this.check(workspaceId);
      const created = await this.d.driver.ensure(workspaceId, target);
      if (!created) await this.d.driver.navigate(workspaceId, target);
      await this.d.driver.idle(workspaceId).catch(() => undefined);
      return this.read(workspaceId, projectId);
    });
  }

  /** 페이지를 읽는다. 내용과 주소를 같은 문서에서 함께 가져와, 그 주소가 허용된 것일 때만 돌려준다. */
  private async read(workspaceId: string, projectId: string): Promise<PageSnapshot> {
    await this.here(workspaceId, projectId);
    const r = await this.d.driver.evaluate(workspaceId, SNAPSHOT_SCRIPT) as { url?: unknown; title?: unknown; lines?: unknown; refs?: unknown; cut?: unknown } | null;
    // 페이지가 돌려준 값은 믿지 않는다: 모양과 크기를 여기서 다시 본다 (페이지가 기본 함수를 바꿔 놓았을 수 있다).
    if (!r || typeof r !== 'object' || typeof r.url !== 'string' || !Array.isArray(r.lines)) throw new Error('페이지를 읽지 못했다.');
    if (!this.usable(projectId, r.url)) throw new Error(MOVED);
    const lines: string[] = [];
    let size = 0;
    let cut = r.cut === true;
    for (const line of r.lines) {
      if (typeof line !== 'string') continue;
      const one = line.slice(0, 600);
      size += one.length + 1;
      if (size > MAX_SNAPSHOT) { cut = true; break; }
      lines.push(one);
    }
    if (cut) lines.push('… (페이지가 길어 뒤를 잘랐다. 필요한 곳으로 이동하거나 스크롤한 뒤 다시 읽어라)');
    return { url: r.url.slice(0, 2000), title: String(typeof r.title === 'string' ? r.title : '').slice(0, 200), text: lines.join('\n') || '(보이는 내용이 없다)', refs: Number.isInteger(r.refs) ? r.refs as number : 0 };
  }

  snapshot(workspaceId: string): Promise<PageSnapshot> {
    const projectId = this.check(workspaceId);
    return this.serial(workspaceId, () => this.read(workspaceId, projectId));
  }

  /** 누른 뒤 화면이 바뀔 틈을 준다. 다른 페이지로 넘어가는 중이면 다 불러올 때까지 기다린다 (그 전에 읽으면 번호가 옛 페이지에 붙는다). */
  private async settle(workspaceId: string): Promise<void> {
    await sleep(300);
    await this.d.driver.idle(workspaceId).catch(() => undefined);
    await sleep(150);
  }

  /** 페이지 안에서 한 조작의 결과를 보고, 안 됐으면 이유를 던진다. */
  private acted(r: Acted, ref: number): void {
    if (!r || typeof r !== 'object') throw new Error('페이지에서 조작하지 못했다.');
    if (r.moved === true) throw new Error(MOVED);
    if (r.missing === true) throw new Error(`[${ref}] 인 요소가 없다. 페이지가 바뀌었을 수 있다: browser_snapshot 으로 다시 읽어라.`);
    if (r.disabled === true) throw new Error(`[${ref}] 는 꺼져 있어 쓸 수 없다.`);
    if (r.notInput !== undefined) throw new Error(`[${ref}] 는 글을 넣는 칸이 아니다 (${String(r.notInput).slice(0, 20)}).`);
    if (r.ok !== true) throw new Error('페이지에서 조작하지 못했다.');
  }

  private ref(ref: number): number {
    if (!Number.isInteger(ref) || ref < 1 || ref > 100_000) throw new Error('ref 는 browser_snapshot 이 붙인 번호다.');
    return ref;
  }

  click(workspaceId: string, ref: number): Promise<PageSnapshot> {
    const projectId = this.check(workspaceId);
    const n = this.ref(ref);
    return this.serial(workspaceId, async () => {
      const { origin } = await this.here(workspaceId, projectId);
      this.acted(await this.d.driver.evaluate(workspaceId, CLICK(n, origin)) as Acted, n);
      await this.settle(workspaceId);
      return this.read(workspaceId, projectId);
    });
  }

  type(workspaceId: string, ref: number, text: string, o: { submit?: boolean } = {}): Promise<PageSnapshot> {
    const projectId = this.check(workspaceId);
    const n = this.ref(ref);
    if (typeof text !== 'string' || text.length > 5000) throw new Error('넣을 글은 5000자까지다.');
    return this.serial(workspaceId, async () => {
      const { origin } = await this.here(workspaceId, projectId);
      this.acted(await this.d.driver.evaluate(workspaceId, TYPE(n, text, origin)) as Acted, n);
      if (o.submit) this.acted(await this.d.driver.evaluate(workspaceId, PRESS('Enter', origin)) as Acted, n);
      await this.settle(workspaceId);
      return this.read(workspaceId, projectId);
    });
  }

  press(workspaceId: string, key: string): Promise<PageSnapshot> {
    const projectId = this.check(workspaceId);
    if (!(BROWSER_KEYS as readonly string[]).includes(key)) throw new Error(`누를 수 있는 키: ${BROWSER_KEYS.join(', ')}`);
    return this.serial(workspaceId, async () => {
      const { origin } = await this.here(workspaceId, projectId);
      this.acted(await this.d.driver.evaluate(workspaceId, PRESS(key, origin)) as Acted, 0);
      await this.settle(workspaceId);
      return this.read(workspaceId, projectId);
    });
  }

  screenshot(workspaceId: string): Promise<{ data: string; mimeType: string; url: string }> {
    const projectId = this.check(workspaceId);
    return this.serial(workspaceId, async () => {
      const info = await this.here(workspaceId, projectId);
      // 그림에는 페이지 안의 프레임(iframe)도 찍힌다: 허용되지 않은 주소의 프레임이 하나라도 있으면 찍지 않는다.
      const foreign = this.d.driver.frames(workspaceId).filter((u) => u && u !== 'about:blank' && u !== 'about:srcdoc').some((u) => !this.usable(projectId, u));
      if (foreign) throw new Error('이 페이지 안에 허용되지 않은 주소의 프레임(iframe)이 있어 화면을 찍지 않는다. 내용은 browser_snapshot 으로 읽어라 (프레임 안은 읽지 않는다).');
      const before = this.d.driver.navigations(workspaceId);
      const shot = await this.d.driver.screenshot(workspaceId);
      // 찍는 사이에 페이지가 넘어갔으면 무엇이 찍혔는지 알 수 없다: 주지 않는다.
      if (this.d.driver.navigations(workspaceId) !== before) throw new Error('찍는 사이에 페이지가 넘어갔다. 다시 찍어라.');
      await this.here(workspaceId, projectId);
      return { ...shot, url: info.url };
    });
  }

  logs(workspaceId: string): Promise<{ url: string; lines: string[] }> {
    const projectId = this.check(workspaceId);
    return this.serial(workspaceId, async () => {
      const info = await this.here(workspaceId, projectId);
      return { url: info.url, lines: this.d.driver.logs(workspaceId).slice(-50).map((l) => String(l).slice(0, 500)) };
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
