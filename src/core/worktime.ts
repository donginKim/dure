import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Settings, WorkDay, WorkSession, WorkStatus } from '@shared/types';

/** 지금 붙어 있는 네트워크. ssid: 와이파이 이름 (macOS 가 가리면 null, hidden 이 참). gateway: 공유기의 MAC 주소 */
export interface NetworkProbe { ssid: string | null; hidden: boolean; gateway: string | null }
interface Row { id: string; day: string; start_at: number; end_at: number; open: number; auto: number }

const POLL_MS = 60_000;
/** 이만큼 넘게 끊겼다 다시 붙으면 새 구간으로 센다 (잠깐 끊긴 것은 이어 붙인다) */
const GAP_MS = 5 * 60_000;
/** 출퇴근 시각을 맞추는 단위 */
export const SLOT_MS = 30 * 60_000;
const two = (n: number): string => String(n).padStart(2, '0');
/** 그 시각의 날짜 (이 PC 의 시간대) */
export const dayOf = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const toSession = (r: Row): WorkSession => ({ id: r.id, day: r.day, startAt: r.start_at, endAt: r.end_at, open: r.open === 1, auto: r.auto === 1 });
/** 30분 단위로 올린다 (이 PC 의 시각으로): 09:14 → 09:30, 15:20 → 15:30, 09:30 → 09:30 */
export function ceilHalf(at: number): number {
  const d = new Date(at);
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() < 30 ? 0 : 30).getTime();
  return at === base ? base : base + SLOT_MS;
}
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const run = (cmd: string, args: string[]): Promise<string> => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout));
});

/** macOS 에서 지금 붙어 있는 네트워크를 알아본다. 와이파이 이름은 위치 권한이 없으면 가려져 온다. */
export async function probeNetwork(): Promise<NetworkProbe> {
  // 와이파이 장치를 직접 찾는다. 기본 경로로 찾으면 VPN 을 켰을 때 VPN 의 가상 장치가 잡힌다.
  const ports = await run('/usr/sbin/networksetup', ['-listallhardwareports']);
  const dev = /Hardware Port: Wi-Fi\s*\nDevice: (en\d+)/.exec(ports)?.[1] ?? 'en0';
  let ssid: string | null = null; let hidden = false;
  const sum = await run('/usr/sbin/ipconfig', ['getsummary', dev]);
  const name = /^\s*SSID\s*:\s*(.+)$/m.exec(sum)?.[1]?.trim() ?? '';
  if (name === '<redacted>') hidden = true; else if (name) ssid = name;
  // 그 와이파이의 공유기 (DHCP 가 알려 준 주소) 와 그 MAC 주소
  let gateway: string | null = null;
  const ip = (await run('/usr/sbin/ipconfig', ['getoption', dev, 'router'])).trim();
  if (/^[0-9.]+$/.test(ip)) {
    const arp = await run('/usr/sbin/arp', ['-n', '-i', dev, ip]);
    const mac = /\bat\s+([0-9a-f:]{11,17})\b/i.exec(arp)?.[1] ?? '';
    // 자리마다 두 글자로 맞춘다 (arp 는 앞의 0 을 뺀다).
    if (mac) gateway = mac.split(':').map((x) => x.padStart(2, '0')).join(':').toLowerCase();
  }
  return { ssid, hidden, gateway };
}

/**
 * 근무시간. 근무지의 네트워크에 붙어 있는 동안을 잰다: 설정한 이름의 와이파이이거나, 사용자가 "근무지로 기억" 한 네트워크(공유기)다.
 * 1분마다 확인해, 붙어 있으면 지금 구간의 끝을 늘린다. 5분 넘게 끊겼다 붙으면 새 구간이다. 두레가 켜져 있을 때만 잰다.
 * 기본은 출퇴근 기록이다: 근무지에 붙으면 그날의 출근을 적고 (30분 단위로 올림: 09:14 → 09:30), 퇴근은 사용자가 눌러 적는다 (15:20 → 15:30).
 * 퇴근을 누르지 않고 날이 바뀌면 마지막으로 근무지에서 확인된 시각으로 닫는다.
 * 이벤트: 'changed'
 */
export class WorkTimeService extends EventEmitter {
  private timer: NodeJS.Timeout | undefined;
  private last: NetworkProbe = { ssid: null, hidden: false, gateway: null };
  private atWork = false;

  constructor(private readonly d: { db: Database.Database; settings(): Settings; probe?: () => Promise<NetworkProbe>; now?: () => number }) { super(); }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }
  private remembered(gateway: string | null): boolean {
    return gateway !== null && this.d.db.prepare('SELECT 1 FROM work_networks WHERE gateway = ?').get(gateway) !== undefined;
  }
  private matches(p: NetworkProbe): boolean {
    const want = this.d.settings().workWifi;
    return (p.ssid !== null && want.trim() !== '' && sameName(p.ssid, want)) || this.remembered(p.gateway);
  }

  /** 주기적으로 확인하기 시작한다. */
  start(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    this.timer.unref?.();
    void this.tick();
  }
  dispose(): void { clearInterval(this.timer); }

  /** 지금 네트워크를 보고, 근무지면 지금 구간의 끝을 지금으로 늘린다 (없으면 새 구간). */
  async tick(): Promise<void> {
    if (!this.d.settings().workTimeEnabled) {
      if (this.atWork) { this.atWork = false; this.emit('changed'); }
      return;
    }
    let p: NetworkProbe;
    try { p = await (this.d.probe ?? probeNetwork)(); } catch { return; }
    this.last = p;
    const at = this.matches(p);
    const now = this.now();
    if (this.d.settings().workTimeUnit === 'half') {
      // 출퇴근 기록: 근무지에 붙으면 그날의 출근을 적는다 (하루에 한 번 저절로). 퇴근은 사용자가 누른다.
      this.closeStale(now);
      const today = dayOf(now);
      const open = this.openRow();
      if (at && open) this.d.db.prepare('UPDATE work_sessions SET end_at = ? WHERE id = ?').run(Math.max(now, open.start_at), open.id);
      else if (at && !this.d.db.prepare('SELECT 1 FROM work_sessions WHERE day = ?').get(today)) this.begin(now);
    } else if (at) {
      const day = dayOf(now);
      const open = this.d.db.prepare('SELECT * FROM work_sessions WHERE day = ? ORDER BY end_at DESC LIMIT 1').get(day) as Row | undefined;
      if (open && now - open.end_at <= GAP_MS && now >= open.end_at) this.d.db.prepare('UPDATE work_sessions SET end_at = ? WHERE id = ?').run(now, open.id);
      else this.d.db.prepare('INSERT INTO work_sessions (id, day, start_at, end_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), day, now, now);
    }
    this.atWork = at;
    this.emit('changed');
  }

  private openRow(): Row | undefined {
    return this.d.db.prepare('SELECT * FROM work_sessions WHERE open = 1 ORDER BY start_at DESC LIMIT 1').get() as Row | undefined;
  }

  /** 출근을 적는다 (30분 단위로 올린 시각으로). */
  private begin(now: number): void {
    const start = ceilHalf(now);
    // 끝에는 마지막으로 확인된 시각을 적어 둔다 (퇴근을 누르지 않았을 때 그 시각으로 닫는다).
    this.d.db.prepare('INSERT INTO work_sessions (id, day, start_at, end_at, open, auto) VALUES (?, ?, ?, ?, 1, 0)').run(crypto.randomUUID(), dayOf(now), start, Math.max(now, start));
  }

  /** 퇴근을 누르지 않고 날이 바뀐 구간을 닫는다: 마지막으로 근무지에서 확인된 시각을 30분 단위로 올려 퇴근으로 적는다. */
  private closeStale(now: number): void {
    const today = dayOf(now);
    for (const r of this.d.db.prepare('SELECT * FROM work_sessions WHERE open = 1 AND day != ?').all(today) as Row[]) {
      this.d.db.prepare('UPDATE work_sessions SET end_at = ?, open = 0, auto = 1 WHERE id = ?').run(Math.max(r.start_at, ceilHalf(r.end_at)), r.id);
    }
  }

  /** 사용자가 출근을 누른다 (와이파이에 붙지 않았거나, 퇴근한 뒤 다시 일할 때). */
  clockIn(): WorkStatus {
    const now = this.now();
    this.closeStale(now);
    if (this.openRow()) throw new Error('이미 출근한 상태입니다.');
    this.begin(now);
    this.emit('changed');
    return this.status();
  }

  /** 사용자가 퇴근을 누른다: 지금 시각을 30분 단위로 올려 퇴근으로 적는다 (15:20 → 15:30). */
  clockOut(): WorkStatus {
    const now = this.now();
    const open = this.openRow();
    if (!open) throw new Error('출근한 상태가 아닙니다.');
    this.d.db.prepare('UPDATE work_sessions SET end_at = ?, open = 0 WHERE id = ?').run(Math.max(open.start_at, ceilHalf(now)), open.id);
    this.emit('changed');
    return this.status();
  }

  status(): WorkStatus {
    const now = this.now();
    const today = this.day(dayOf(now));
    const s = this.d.settings();
    const openRow = s.workTimeUnit === 'half' ? this.openRow() : undefined;
    const last = today.sessions[today.sessions.length - 1];
    return {
      enabled: s.workTimeEnabled, atWork: this.atWork, ssid: this.last.ssid, ssidHidden: this.last.hidden,
      remembered: this.remembered(this.last.gateway), networks: (this.d.db.prepare('SELECT count(*) AS n FROM work_networks').get() as { n: number }).n,
      todayMs: today.totalMs, since: openRow ? openRow.start_at : s.workTimeUnit === 'minute' && this.atWork && last ? last.startAt : null,
      openSession: openRow ? toSession(openRow) : null, clockedOut: !openRow && today.sessions.length > 0, unit: s.workTimeUnit,
    };
  }

  private day(day: string): WorkDay {
    const now = this.now();
    const sessions = (this.d.db.prepare('SELECT * FROM work_sessions WHERE day = ? ORDER BY start_at').all(day) as Row[]).map(toSession);
    // 아직 퇴근하지 않은 구간은 지금까지를 센다 (올려 적은 출근 시각이 아직 오지 않았으면 0).
    const span = (x: WorkSession): number => (x.open ? Math.max(0, now - x.startAt) : x.endAt - x.startAt);
    const grossMs = sessions.reduce((n, x) => n + span(x), 0);
    const breakMin = (this.d.db.prepare('SELECT minutes FROM work_breaks WHERE day = ?').get(day) as { minutes: number } | undefined)?.minutes ?? 0;
    // 휴게 시간은 일한 시간에서 뺀다 (일한 시간보다 길어도 0 아래로 내려가지 않는다).
    return { day, sessions, grossMs, breakMin, totalMs: Math.max(0, grossMs - breakMin * 60_000), firstAt: sessions[0]?.startAt ?? 0, lastAt: sessions[sessions.length - 1]?.endAt ?? 0 };
  }

  /** 그 달의 근무 기록 (기록이 있는 날만). month 는 1~12 */
  month(year: number, month: number): WorkDay[] {
    const prefix = `${Math.floor(year)}-${two(Math.min(12, Math.max(1, Math.floor(month))))}-`;
    // 근무 기록이 있는 날과, 휴게 시간만 적어 둔 날
    const days = (this.d.db.prepare('SELECT day FROM work_sessions WHERE day LIKE ? UNION SELECT day FROM work_breaks WHERE day LIKE ? ORDER BY day').all(`${prefix}%`, `${prefix}%`) as { day: string }[]).map((r) => r.day);
    return days.map((d) => this.day(d));
  }

  /** 지금 붙어 있는 네트워크를 근무지로 기억한다 (와이파이 이름을 읽을 수 없을 때 쓴다). */
  async rememberCurrent(): Promise<WorkStatus> {
    const p = await (this.d.probe ?? probeNetwork)();
    if (!p.gateway) throw new Error('지금 붙어 있는 네트워크를 알아볼 수 없습니다 (네트워크에 연결돼 있는지 확인하세요).');
    this.d.db.prepare('INSERT INTO work_networks (gateway, label, created_at) VALUES (?, ?, ?) ON CONFLICT(gateway) DO NOTHING').run(p.gateway, p.ssid ?? '', this.now());
    await this.tick();
    return this.status();
  }

  /** 기억해 둔 네트워크를 모두 잊는다. */
  forgetNetworks(): void {
    this.d.db.prepare('DELETE FROM work_networks').run();
    void this.tick();
  }

  /** 그날의 휴게 시간을 적는다 (분). 0 이면 지운다. 근무시간에서 뺀다. */
  setBreak(day: string, minutes: number): WorkDay {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('날짜가 올바르지 않습니다.');
    const m = Math.floor(Number(minutes));
    if (!Number.isFinite(m) || m < 0 || m > 24 * 60) throw new Error('휴게 시간은 0분부터 24시간까지 적을 수 있습니다.');
    if (m === 0) this.d.db.prepare('DELETE FROM work_breaks WHERE day = ?').run(day);
    else this.d.db.prepare('INSERT INTO work_breaks (day, minutes) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET minutes = excluded.minutes').run(day, m);
    this.emit('changed');
    return this.day(day);
  }

  /** 구간 하나를 지운다 (잘못 잰 것을 고칠 때). */
  removeSession(id: string): void {
    if (this.d.db.prepare('DELETE FROM work_sessions WHERE id = ?').run(String(id)).changes) this.emit('changed');
  }
}
