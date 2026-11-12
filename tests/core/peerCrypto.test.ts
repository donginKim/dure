import { fingerprint, generateKeys, open, pairCommit, pairNonce, pairingCode, seal, sharedKey, validPub } from '@core/peers/crypto';

test('두 사람이 각자 계산한 공유 열쇠는 같고, 그 열쇠로 감싼 것만 풀린다', () => {
  const a = generateKeys(); const b = generateKeys(); const c = generateKeys();
  const ab = sharedKey(a.priv, b.pub, a.pub);
  const ba = sharedKey(b.priv, a.pub, b.pub);
  expect(ab.equals(ba)).toBe(true);
  const sealed = seal(ab, '안녕 {"x":1}', 'a|b');
  expect(open(ba, sealed, 'a|b')).toBe('안녕 {"x":1}');
  // 다른 사람의 열쇠, 바뀐 aad, 바뀐 내용으로는 풀리지 않는다
  expect(() => open(sharedKey(c.priv, a.pub, c.pub), sealed, 'a|b')).toThrow();
  expect(() => open(ba, sealed, 'a|c')).toThrow();
  const raw = Buffer.from(sealed.box, 'base64'); raw[0] ^= 1;
  expect(() => open(ba, { ...sealed, box: raw.toString('base64') }, 'a|b')).toThrow();
  expect(() => open(ba, { nonce: 'x', box: 'y' }, 'a|b')).toThrow('암호문이 올바르지 않습니다');
  // 같은 글도 매번 다르게 감싼다
  expect(seal(ab, 'x', '').box).not.toBe(seal(ab, 'x', '').box);
});

test('확인 코드는 두 열쇠와 두 무작위 값에서 나오고, 하나라도 다르면 달라진다', () => {
  const a = generateKeys(); const b = generateKeys(); const m = generateKeys();
  const na = pairNonce(); const nb = pairNonce();
  expect(pairingCode(a.pub, na, b.pub, nb)).toBe(pairingCode(a.pub, na, b.pub, nb));
  expect(pairingCode(a.pub, na, b.pub, nb)).toMatch(/^\d{6}$/);
  expect(pairingCode(a.pub, na, m.pub, nb)).not.toBe(pairingCode(a.pub, na, b.pub, nb));
  // 같은 열쇠여도 무작위 값이 다르면 코드가 다르다: 열쇠를 골라 코드를 맞출 수 없다
  const codes = new Set(Array.from({ length: 50 }, () => pairingCode(a.pub, pairNonce(), b.pub, nb)));
  expect(codes.size).toBeGreaterThan(40);
  // 약속은 열쇠와 값을 둘 다 묶는다
  expect(pairCommit(a.pub, na)).toBe(pairCommit(a.pub, na));
  expect(pairCommit(a.pub, na)).not.toBe(pairCommit(m.pub, na));
  expect(pairCommit(a.pub, na)).not.toBe(pairCommit(a.pub, nb));
  expect(fingerprint(a.pub)).toMatch(/^[0-9a-f]{8}$/);
});

test('올바르지 않은 공개 열쇠는 받지 않는다', () => {
  const a = generateKeys();
  expect(validPub(a.pub)).toBe(true);
  for (const bad of ['', 'abc', 'x'.repeat(100), null, 42, Buffer.alloc(31).toString('base64'), `${a.pub}\n`]) expect(validPub(bad)).toBe(false);
  expect(() => sharedKey(a.priv, 'nope', a.pub)).toThrow('공개 열쇠가 올바르지 않습니다');
  // 결과가 전부 0 이 되는 약한 열쇠
  expect(() => sharedKey(a.priv, Buffer.alloc(32).toString('base64'), a.pub)).toThrow('공개 열쇠가 올바르지 않습니다');
});
