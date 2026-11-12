import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

/**
 * 두레끼리의 암호화. 설치마다 X25519 열쇠 한 쌍을 갖는다.
 * 두 사람의 열쇠로 공유 열쇠를 만들고(ECDH + HKDF), 그것으로 내용을 감싼다(AES-256-GCM).
 * 암호가 풀린다는 것이 곧 "그 열쇠의 주인이 보냈다" 는 확인이다 (따로 서명하지 않는다).
 */
export interface KeyPair { pub: string; priv: string }

// DER 머리 (고정): 그 뒤의 32바이트가 열쇠다.
const SPKI_HEAD = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_HEAD = Buffer.from('302e020100300506032b656e04220420', 'hex');

export function generateKeys(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_HEAD.length).toString('base64'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_HEAD.length).toString('base64'),
  };
}

/** 공개 열쇠로 쓸 수 있는 글인가 (base64 로 적은 32바이트). */
export function validPub(pub: unknown): pub is string {
  if (typeof pub !== 'string' || pub.length > 64) return false;
  const raw = Buffer.from(pub, 'base64');
  return raw.length === 32 && raw.toString('base64') === pub;
}

/** 두 사람의 공유 열쇠. 누가 계산해도 같다. */
export function sharedKey(myPriv: string, theirPub: string, myPub: string): Buffer {
  if (!validPub(theirPub)) throw new Error('공개 열쇠가 올바르지 않습니다.');
  let secret: Buffer;
  try {
    secret = diffieHellman({
      privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_HEAD, Buffer.from(myPriv, 'base64')]), format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: Buffer.concat([SPKI_HEAD, Buffer.from(theirPub, 'base64')]), format: 'der', type: 'spki' }),
    });
  } catch {
    // 약한 열쇠(결과가 전부 0 이 되는 것)는 암호 라이브러리가 거절한다.
    throw new Error('공개 열쇠가 올바르지 않습니다.');
  }
  if (secret.every((b) => b === 0)) throw new Error('공개 열쇠가 올바르지 않습니다.');
  const info = Buffer.from(['dure-peer-v1', ...[myPub, theirPub].sort()].join('|'));
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

export interface Sealed { nonce: string; box: string }

/** 내용을 감싼다. aad 는 암호화하지 않지만 바뀌면 풀리지 않는 글이다 (보낸 사람과 받는 사람의 id 를 넣는다). */
export function seal(key: Buffer, plain: string, aad: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString('base64'), box: body.toString('base64') };
}

/** 푼다. 열쇠가 다르거나 내용·aad 가 바뀌었으면 던진다. */
export function open(key: Buffer, sealed: Sealed, aad: string): string {
  const nonce = Buffer.from(String(sealed?.nonce ?? ''), 'base64');
  const body = Buffer.from(String(sealed?.box ?? ''), 'base64');
  if (nonce.length !== 12 || body.length < 16) throw new Error('암호문이 올바르지 않습니다.');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
}

/** 연결할 때 한 번 쓰는 무작위 값. */
export const pairNonce = (): string => randomBytes(16).toString('base64');

/** 요청하는 쪽이 먼저 내는 약속: 자기 열쇠와 무작위 값을 정해 두었다는 표시 (값 자체는 아직 보이지 않는다). */
export const pairCommit = (pub: string, nonce: string): string => createHash('sha256').update(['dure-commit-v1', pub, nonce].join('|')).digest('base64');

/**
 * 연결할 때 두 사람이 말로 맞춰 보는 확인 코드 (6자리). 두 공개 열쇠와 두 무작위 값에서 만든다.
 * 요청한 쪽은 약속을 먼저 내고, 상대의 무작위 값을 받은 뒤에야 자기 값을 보인다:
 * 중간에 낀 사람은 상대의 값을 보기 전에 자기 것을 정해야 해서, 열쇠를 여러 개 만들어 보며 코드를 맞출 수 없다
 * (한 번 시도할 때마다 맞을 확률이 백만분의 일이다).
 */
export function pairingCode(initPub: string, initNonce: string, respPub: string, respNonce: string): string {
  const h = createHash('sha256').update(['dure-pair-v2', initPub, initNonce, respPub, respNonce].join('|')).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** 열쇠의 짧은 지문 (화면에 보이는 것). */
export const fingerprint = (pub: string): string => createHash('sha256').update(pub).digest('hex').slice(0, 8);
