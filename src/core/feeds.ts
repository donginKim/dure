import { lookup } from 'node:dns/promises';
import type { FeedItem } from '@shared/types';

const MAX_BYTES = 1_500_000;
const TTL = 20 * 60_000;

/** 읽어도 되는 주소인가: https 이고, 이 PC 나 사설망을 가리키지 않는다 (플러그인이 두레를 시켜 안쪽 주소를 읽게 하지 못하게). */
export function publicHttps(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (h === 'localhost' || /\.(local|localhost|internal|lan|home|corp|intranet|arpa)$/.test(h) || !h.includes('.')) return false;
  if (/^\[/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return false; // 숫자 주소는 받지 않는다
  return true;
}

const codePoint = (n: number): string => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '');
// 짧게 자른 글에만 쓴다 (RAW 글자 이하): 긴 글에 정규식을 돌리지 않는다.
const decode = (raw: string): string => raw.slice(0, RAW).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d{1,8});/g, (_, n: string) => codePoint(Number(n))).replace(/&amp;/g, '&')
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();

const RAW = 4000;
const BLOCK = 40_000;
// 영문 대문자만 내린다: 글자 수가 달라지는 문자(İ 등)가 있어도 자리가 어긋나지 않게.
const lowerAscii = (x: string): string => x.replace(/[A-Z]+/g, (c) => c.toLowerCase());
const nameEnd = (c: string | undefined): boolean => c === '>' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/';

/** 글 안에서 <name ...>속</name> 의 속을 찾는다. 앞에서 뒤로 한 번만 훑는다 (나쁜 피드가 앱을 붙잡지 못하게). */
function inner(lower: string, src: string, name: string, from = 0): { body: string; end: number } | null {
  const open = `<${name}`;
  let i = from;
  for (;;) {
    i = lower.indexOf(open, i);
    if (i < 0) return null;
    if (nameEnd(lower[i + open.length])) break;
    i += open.length;
  }
  const gt = lower.indexOf('>', i);
  if (gt < 0) return null;
  if (lower[gt - 1] === '/') return { body: '', end: gt + 1 };
  const close = lower.indexOf(`</${name}`, gt);
  if (close < 0) return null;
  return { body: src.slice(gt + 1, close), end: close + name.length + 2 };
}

/** RSS 와 Atom 을 읽는다 (제목, 링크, 때만). 문서의 다른 것은 보지 않는다: 바깥 참조를 따라가지 않는다. */
export function parseFeed(xml: string, max = 30): FeedItem[] {
  const out: FeedItem[] = [];
  const src = xml.slice(0, MAX_BYTES);
  const lower = lowerAscii(src);
  const kind = inner(lower, src, 'item') ? 'item' : 'entry';
  let at = 0;
  for (let n = 0; n < max * 3 && out.length < max; n++) {
    const hit = inner(lower, src, kind, at);
    if (!hit) break;
    at = hit.end;
    const b = hit.body.slice(0, BLOCK); const bl = lowerAscii(b);
    const tag = (name: string): string => inner(bl, b, name)?.body ?? '';
    const title = decode(tag('title')).slice(0, 200);
    if (!title) continue;
    let link = decode(tag('link'));
    if (!link) link = /<link[^>]{0,500}?href="([^"]{1,1000})"/i.exec(b.slice(0, BLOCK))?.[1] ?? '';
    link = link.replace(/&amp;/g, '&');
    const when = Date.parse(decode(tag('pubdate') || tag('updated') || tag('published') || tag('dc:date')));
    out.push({ title, link: /^https?:\/\//i.test(link) ? link.slice(0, 1000) : '', at: Number.isFinite(when) ? when : 0 });
  }
  return out;
}

/** 사설망·이 PC·링크로컬을 가리키는 숫자 주소인가. */
export function privateAddress(ip: string): boolean {
  const s = ip.toLowerCase();
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!s.includes(':')) return true; // 알 수 없는 꼴은 받지 않는다
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('::ffff:');
}

type Fetched = { ok: boolean; status: number; url: string; text(): Promise<string> };

async function checkHost(url: string): Promise<void> {
  if (!publicHttps(url)) throw new Error('다른 주소로 넘겨졌습니다.');
  const found = await lookup(new URL(url).hostname, { all: true });
  if (found.length === 0 || found.some((f) => privateAddress(f.address))) throw new Error('읽을 수 없는 주소입니다 (안쪽 주소).');
}

/** 넘겨질 때마다 주소를 다시 보고(요청을 보내기 전에), 받는 양을 받으면서 센다. */
async function safeFetch(url: string, signal: AbortSignal): Promise<Fetched> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    await checkHost(cur);
    const res = await fetch(cur, { signal, redirect: 'manual', headers: { 'User-Agent': 'feed-reader', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      void res.body?.cancel().catch(() => {});
      cur = new URL(res.headers.get('location')!, cur).toString();
      continue;
    }
    const final = cur;
    return {
      ok: res.ok, status: res.status, url: final,
      text: async () => {
        if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES * 4) { void res.body?.cancel().catch(() => {}); throw new Error('너무 큽니다.'); }
        const reader = res.body?.getReader();
        if (!reader) return '';
        const parts: Uint8Array[] = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const room = MAX_BYTES - size;
          parts.push(value.byteLength > room ? value.subarray(0, room) : value);
          size += Math.min(value.byteLength, room);
          if (size >= MAX_BYTES) { void reader.cancel().catch(() => {}); break; } // 상한까지만 받고 끊는다
        }
        return new TextDecoder().decode(Buffer.concat(parts));
      },
    };
  }
  throw new Error('너무 여러 번 넘겨졌습니다.');
}

/** 피드를 읽어 온다. 20분 동안은 받아 둔 것을 쓴다. 크기와 시간에 상한이 있다. */
export class FeedReader {
  private readonly cache = new Map<string, { at: number; items: FeedItem[]; error: string }>();

  constructor(private readonly fetcher: (url: string, signal: AbortSignal) => Promise<Fetched> = safeFetch) {}

  async read(url: string, force = false): Promise<{ items: FeedItem[]; error: string; at: number }> {
    const hit = this.cache.get(url);
    if (hit && !force && Date.now() - hit.at < TTL) return hit;
    let items: FeedItem[] = []; let error = '';
    if (!publicHttps(url)) error = '읽을 수 없는 주소입니다 (https 의 바깥 주소만).';
    else {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12_000);
      try {
        const res = await this.fetcher(url, ctl.signal);
        // 다른 곳으로 넘겨져도 바깥 https 여야 한다.
        if (!publicHttps(res.url || url)) throw new Error('다른 주소로 넘겨졌습니다.');
        if (!res.ok) throw new Error(`받지 못했습니다 (${res.status}).`);
        const text = (await res.text()).slice(0, MAX_BYTES);
        items = parseFeed(text);
        if (items.length === 0) error = '소식이 없습니다.';
      } catch (e) { error = e instanceof Error && e.name === 'AbortError' ? '응답이 없습니다.' : e instanceof Error ? e.message.slice(0, 120) : '읽지 못했습니다.'; } finally { clearTimeout(timer); }
    }
    // 실패했으면 앞서 받아 둔 것을 그대로 보인다.
    const entry = { at: Date.now(), items: items.length ? items : hit?.items ?? [], error };
    this.cache.set(url, entry);
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    return entry;
  }
}
