import { FeedReader, parseFeed, publicHttps } from '@core/feeds';

test('publicHttps: https 의 바깥 주소만', () => {
  expect(publicHttps('https://feeds.bbci.co.uk/news/world/rss.xml')).toBe(true);
  for (const bad of ['http://example.com/rss', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://intranet/x', 'https://db.internal/x', 'https://user:pw@example.com/x', 'file:///etc/passwd', 'nope']) expect(publicHttps(bad)).toBe(false);
});

test('parseFeed: RSS 와 Atom 에서 제목·링크·때를 읽고, 꾸밈과 태그는 걷어 낸다', () => {
  const rss = `<rss><channel><title>채널</title>
    <item><title><![CDATA[[속보] 첫째 &amp; 둘째]]></title><link>https://a.example.com/1?x=1&amp;y=2</link><pubDate>Mon, 16 Nov 2026 09:00:00 +0900</pubDate></item>
    <item><title>&lt;b&gt;굵게&lt;/b&gt; <script>alert(1)</script>보통</title><link>javascript:alert(1)</link></item>
    <item><title></title><link>https://a.example.com/3</link></item></channel></rss>`;
  const items = parseFeed(rss);
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ title: '[속보] 첫째 & 둘째', link: 'https://a.example.com/1?x=1&y=2' });
  expect(items[0]!.at).toBe(Date.parse('2026-11-16T00:00:00Z'));
  expect(items[1]).toMatchObject({ title: '<b>굵게</b> alert(1)보통', link: '' });
  const atom = '<feed><entry><title>아톰 글</title><link rel="alternate" href="https://b.example.com/p"/><updated>2026-11-16T01:02:03Z</updated></entry></feed>';
  expect(parseFeed(atom)).toEqual([{ title: '아톰 글', link: 'https://b.example.com/p', at: Date.parse('2026-11-16T01:02:03Z') }]);
});

test('FeedReader: 받아 둔 것을 다시 쓰고, 안쪽 주소는 읽지 않고, 실패하면 앞의 것을 보인다', async () => {
  let calls = 0; let fail = false;
  const r = new FeedReader(async (url) => { calls++; if (fail) throw new Error('끊김'); return { ok: true, status: 200, url, text: async () => '<rss><item><title>하나</title><link>https://x.example.com/1</link></item></rss>' }; });
  expect((await r.read('https://x.example.com/rss')).items).toHaveLength(1);
  await r.read('https://x.example.com/rss');
  expect(calls).toBe(1);
  expect((await r.read('https://localhost/rss')).error).toContain('읽을 수 없는 주소');
  expect(calls).toBe(1);
  fail = true;
  const again = await r.read('https://x.example.com/rss', true);
  expect(again.error).toBe('끊김');
  expect(again.items).toHaveLength(1);
  // 안쪽 주소로 넘겨지면 받지 않는다
  const redirect = new FeedReader(async () => ({ ok: true, status: 200, url: 'https://127.0.0.1/secret', text: async () => '<rss><item><title>비밀</title></item></rss>' }));
  expect(await redirect.read('https://y.example.com/rss')).toMatchObject({ items: [], error: '다른 주소로 넘겨졌습니다.' });
});
