import type { FeedItem } from '@shared/types';

const MAX_BYTES = 1_500_000;
const TTL = 20 * 60_000;

/** 읽어도 되는 주소인가: https 이고, 이 PC 나 사설망을 가리키지 않는다 (플러그인이 두레를 시켜 안쪽 주소를 읽게 하지 못하게). */
export function publicHttps(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.')) return false;
  if (/^\[/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return false; // 숫자 주소는 받지 않는다
  return true;
}

const decode = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block: string, name: string): string => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? m[1]! : ''; };

/** RSS 와 Atom 을 읽는다 (제목, 링크, 때만). 문서의 다른 것은 보지 않는다: 바깥 참조를 따라가지 않는다. */
export function parseFeed(xml: string, max = 30): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks.slice(0, max)) {
    const title = decode(tag(b, 'title')).slice(0, 200);
    let link = decode(tag(b, 'link'));
    if (!link) link = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '';
    link = link.replace(/&amp;/g, '&');
    const when = Date.parse(decode(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date')));
    if (!title) continue;
    out.push({ title, link: /^https?:\/\//i.test(link) ? link.slice(0, 1000) : '', at: Number.isFinite(when) ? when : 0 });
  }
  return out;
}

/** 피드를 읽어 온다. 20분 동안은 받아 둔 것을 쓴다. 크기와 시간에 상한이 있다. */
export class FeedReader {
  private readonly cache = new Map<string, { at: number; items: FeedItem[]; error: string }>();

  constructor(private readonly fetcher: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; url: string; text(): Promise<string> }> = (url, signal) => fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'feed-reader', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } })) {}

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
