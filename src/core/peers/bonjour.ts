import { Bonjour, type Service } from 'bonjour-service';
import type { PeerDiscovery } from './peerService';

const TYPE = 'dure';

/**
 * 같은 네트워크에서 서로 찾는다 (Bonjour, mDNS). 여기서 알게 되는 것은 "누가 어디에 있다" 뿐이다:
 * 누구든 이 이름으로 자기를 알릴 수 있으므로 믿지 않는다. 연결은 사용자가 확인 코드를 맞춰 보고 수락해야 된다.
 */
export function createBonjourDiscovery(): PeerDiscovery {
  let bonjour: Bonjour | undefined;
  return {
    start(me, onSeen, onGone) {
      this.stop();
      const b = new Bonjour(undefined, () => undefined);
      bonjour = b;
      try {
        b.publish({ name: `dure-${me.id}`, type: TYPE, port: me.port, txt: { id: me.id, name: me.name.slice(0, 40) } });
        const browser = b.find({ type: TYPE });
        const idOf = (s: Service): string => String((s.txt as Record<string, unknown> | undefined)?.id ?? '');
        browser.on('up', (s: Service) => {
          const id = idOf(s);
          // IPv4 주소를 먼저 쓴다 (같은 네트워크에서 가장 잘 통한다).
          const host = (s.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? s.referer?.address;
          if (!id || id === me.id || !host) return;
          onSeen({ id, name: String((s.txt as Record<string, unknown> | undefined)?.name ?? ''), address: `${host}:${s.port}` });
        });
        browser.on('down', (s: Service) => { const id = idOf(s); if (id) onGone(id); });
      } catch { /* 이 네트워크에서는 자동으로 찾지 못한다. 주소로 직접 연결할 수 있다 */ }
    },
    stop() {
      const b = bonjour;
      bonjour = undefined;
      if (!b) return;
      try { b.unpublishAll(() => b.destroy()); } catch { try { b.destroy(); } catch { /* 이미 닫힘 */ } }
    },
  };
}
