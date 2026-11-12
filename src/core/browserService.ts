import type { Settings } from '@shared/types';
import type { WorkspaceStore } from './stores';

/**
 * 워크스페이스의 내장 브라우저 페이지를 실제로 움직이는 쪽. 앱에서는 Electron 메인 프로세스가 구현한다 (코어는 Electron 을 모른다).
 * 페이지는 워크스페이스마다 하나이고, 화면의 "브라우저" 보기에 보이는 바로 그 페이지다.
 */
export interface BrowserDriver {
  /** 그 워크스페이스의 페이지가 있게 한다 (없으면 화면에 만들게 한다). 만들 수 없으면 던진다 */
  ensure(workspaceId: string, url: string): Promise<void>;
  navigate(workspaceId: string, url: string): Promise<void>;
  info(workspaceId: string): Promise<{ url: string; title: string }>;
  /** 페이지 안에서 식을 실행하고 값을 돌려준다 (JSON 으로 옮길 수 있는 값) */
  evaluate(workspaceId: string, expression: string): Promise<unknown>;
  /** 페이지 좌표를 진짜 마우스처럼 누른다 */
  click(workspaceId: string, x: number, y: number): Promise<void>;
  /** 지금 초점이 있는 곳에 글을 넣는다 */
  insertText(workspaceId: string, text: string): Promise<void>;
  /** 키 하나를 누른다 (Enter, Tab, Escape, ArrowDown 등) */
  pressKey(workspaceId: string, key: string): Promise<void>;
  /** 보이는 화면을 그림으로 (base64) */
  screenshot(workspaceId: string): Promise<{ data: string; mimeType: string }>;
  /** 최근의 콘솔 경고·오류와 불러오지 못한 것 */
  logs(workspaceId: string): string[];
}

export const noBrowser: BrowserDriver = new Proxy({} as BrowserDriver, {
  get: () => () => { throw new Error('이 환경에서는 내장 브라우저를 쓸 수 없다.'); },
});

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost)$/i;
const MAX_SNAPSHOT = 15_000;
export const BROWSER_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'] as const;

/** 설정의 "허용할 주소" 를 호스트 목록으로. 잘못된 것은 버린다. */
export function parseHosts(raw: string): string[] {
  return raw.split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '')).filter((h) => /^[a-z0-9.-]+$/.test(h) && h.includes('.'));
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

/** ref 가 붙은 요소를 화면에 보이게 하고 가운데 좌표를 돌려준다. */
const locate = (ref: number): string => `(() => {
  const el = document.querySelector('[data-dure-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', disabled: !!el.disabled };
})()`;

export interface PageSnapshot { url: string; title: string; text: string; refs: number }

/**
 * 에이전트의 브라우저 조작. 정책(쓸 수 있는가, 어느 주소인가)을 여기서 본다.
 * 사용자는 같은 페이지를 화면에서 아무 주소로나 옮길 수 있으므로, 읽기와 조작을 할 때마다 지금 주소를 다시 확인한다:
 * 허용되지 않은 주소의 내용은 에이전트에게 주지 않는다.
 */
export class BrowserService {
  constructor(private readonly d: { driver: BrowserDriver; workspaces: WorkspaceStore; settings(): Settings; isProjectClosed(projectId: string): boolean }) {}

  private hosts(): string[] { return parseHosts(this.d.settings().agentBrowserHosts); }

  private check(workspaceId: string): void {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error('워크스페이스가 없다.');
    if (this.d.isProjectClosed(ws.projectId)) throw new Error('완료된 프로젝트다.');
    if (this.d.settings().agentBrowser === 'off') throw new Error('사용자가 에이전트의 브라우저 사용을 꺼 두었다. 필요하면 사용자에게 두레 설정에서 켜 달라고 하라.');
  }

  private refuse(url: string): Error {
    return new Error(`이 주소는 에이전트가 볼 수 없다: ${url.slice(0, 200)}. 로컬 주소(localhost, 127.0.0.1)와 사용자가 두레 설정에 허용한 주소만 된다. 필요하면 사용자에게 허용해 달라고 하라.`);
  }

  /** 지금 페이지가 에이전트에게 허용된 주소인지 본다. */
  private async here(workspaceId: string): Promise<{ url: string; title: string }> {
    const info = await this.d.driver.info(workspaceId);
    if (!info.url || info.url === 'about:blank') throw new Error('열린 페이지가 없다. 먼저 browser_open 으로 주소를 열어라.');
    if (!allowedUrl(info.url, this.hosts())) throw this.refuse(info.url);
    return info;
  }

  async open(workspaceId: string, url: string): Promise<PageSnapshot> {
    this.check(workspaceId);
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`;
    if (!allowedUrl(target, this.hosts())) throw this.refuse(target);
    await this.d.driver.ensure(workspaceId, target);
    await this.d.driver.navigate(workspaceId, target);
    return this.snapshot(workspaceId);
  }

  async snapshot(workspaceId: string): Promise<PageSnapshot> {
    this.check(workspaceId);
    await this.here(workspaceId);
    const r = await this.d.driver.evaluate(workspaceId, SNAPSHOT_SCRIPT) as { url: string; title: string; lines: string[]; refs: number; cut: boolean } | null;
    if (!r) throw new Error('페이지를 읽지 못했다.');
    // 읽는 사이에 다른 곳으로 넘어갔을 수 있다.
    if (!allowedUrl(r.url, this.hosts())) throw this.refuse(r.url);
    const text = [...r.lines, ...(r.cut ? ['… (페이지가 길어 뒤를 잘랐다. 필요한 곳으로 이동하거나 스크롤한 뒤 다시 읽어라)'] : [])].join('\n');
    return { url: r.url, title: String(r.title ?? '').slice(0, 200), text: text || '(보이는 내용이 없다)', refs: r.refs };
  }

  private async point(workspaceId: string, ref: number): Promise<{ x: number; y: number; tag: string; type: string }> {
    if (!Number.isInteger(ref) || ref < 1) throw new Error('ref 는 browser_snapshot 이 붙인 번호다.');
    const at = await this.d.driver.evaluate(workspaceId, locate(ref)) as { x: number; y: number; tag: string; type: string; disabled: boolean } | null;
    if (!at) throw new Error(`[${ref}] 인 요소가 없다. 페이지가 바뀌었을 수 있다: browser_snapshot 으로 다시 읽어라.`);
    if (at.disabled) throw new Error(`[${ref}] 는 꺼져 있어 쓸 수 없다.`);
    return at;
  }

  async click(workspaceId: string, ref: number): Promise<PageSnapshot> {
    this.check(workspaceId);
    await this.here(workspaceId);
    const at = await this.point(workspaceId, ref);
    await this.d.driver.click(workspaceId, at.x, at.y);
    await settle();
    return this.snapshot(workspaceId);
  }

  async type(workspaceId: string, ref: number, text: string, o: { submit?: boolean } = {}): Promise<PageSnapshot> {
    this.check(workspaceId);
    await this.here(workspaceId);
    if (typeof text !== 'string' || text.length > 5000) throw new Error('넣을 글은 5000자까지다.');
    const at = await this.point(workspaceId, ref);
    if (!['input', 'textarea'].includes(at.tag)) throw new Error(`[${ref}] 는 글을 넣는 칸이 아니다 (${at.tag}).`);
    await this.d.driver.click(workspaceId, at.x, at.y);
    // 있던 글을 고르고 새 글로 바꾼다.
    await this.d.driver.evaluate(workspaceId, `(() => { const el = document.querySelector('[data-dure-ref="${ref}"]'); if (el) { el.focus(); if (el.select) el.select(); } return true; })()`);
    await this.d.driver.insertText(workspaceId, text);
    if (o.submit) await this.d.driver.pressKey(workspaceId, 'Enter');
    await settle();
    return this.snapshot(workspaceId);
  }

  async press(workspaceId: string, key: string): Promise<PageSnapshot> {
    this.check(workspaceId);
    await this.here(workspaceId);
    if (!(BROWSER_KEYS as readonly string[]).includes(key)) throw new Error(`누를 수 있는 키: ${BROWSER_KEYS.join(', ')}`);
    await this.d.driver.pressKey(workspaceId, key);
    await settle();
    return this.snapshot(workspaceId);
  }

  async screenshot(workspaceId: string): Promise<{ data: string; mimeType: string; url: string }> {
    this.check(workspaceId);
    const info = await this.here(workspaceId);
    const shot = await this.d.driver.screenshot(workspaceId);
    // 찍는 사이에 다른 곳으로 넘어갔으면 주지 않는다.
    await this.here(workspaceId);
    return { ...shot, url: info.url };
  }

  async logs(workspaceId: string): Promise<{ url: string; lines: string[] }> {
    this.check(workspaceId);
    const info = await this.here(workspaceId);
    return { url: info.url, lines: this.d.driver.logs(workspaceId).slice(-50).map((l) => l.slice(0, 500)) };
  }
}

/** 누른 뒤 화면이 바뀔 틈을 준다. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 400));
