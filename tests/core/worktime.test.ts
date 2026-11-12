import { join } from 'node:path';
import { openDatabase } from '@core/db';
import { SettingsService } from '@core/settings';
import { ceilHalf, dayOf, WorkTimeService, type NetworkProbe } from '@core/worktime';
import { tempDir } from '../helpers/repo';

const OFFICE: NetworkProbe = { ssid: '11st-OA', hidden: false, gateway: 'aa:bb:cc:00:00:01' };
const HOME: NetworkProbe = { ssid: 'home', hidden: false, gateway: 'aa:bb:cc:00:00:02' };
const HIDDEN: NetworkProbe = { ssid: null, hidden: true, gateway: 'aa:bb:cc:00:00:01' };

function setup(wifi = '11st-oa') {
  const db = openDatabase(join(tempDir(), 'dure.db'));
  const settings = new SettingsService(db);
  // 아래 시험들은 '붙어 있던 시간 그대로' 방식이다. 출퇴근 기록 방식은 맨 아래에서 따로 본다.
  settings.update({ workTimeEnabled: true, workWifi: wifi, workTimeUnit: 'minute' });
  let net: NetworkProbe = HOME;
  let now = new Date(2026, 10, 13, 9, 0, 0).getTime();
  const svc = new WorkTimeService({ db, settings: () => settings.get(), probe: async () => net, now: () => now });
  return { svc, settings, at: (n: NetworkProbe) => { net = n; }, pass: async (minutes: number) => { for (let i = 0; i < minutes; i += 1) { now += 60_000; await svc.tick(); } }, jump: (ms: number) => { now += ms; }, time: () => now };
}

test('그 이름의 와이파이에 붙어 있는 동안을 센다. 이름은 대소문자를 가리지 않는다', async () => {
  const t = setup();
  await t.svc.tick();
  expect(t.svc.status()).toMatchObject({ enabled: true, atWork: false, ssid: 'home', todayMs: 0, since: null });
  t.at(OFFICE);
  await t.svc.tick();
  const started = t.time();
  await t.pass(90);
  expect(t.svc.status()).toMatchObject({ atWork: true, ssid: '11st-OA', todayMs: 90 * 60_000, since: started });
  // 집에 가면 멈춘다
  t.at(HOME);
  await t.pass(30);
  expect(t.svc.status()).toMatchObject({ atWork: false, todayMs: 90 * 60_000, since: null });
});

test('잠깐 끊긴 것은 이어 붙이고, 5분 넘게 끊겼다 붙으면 새 구간이다', async () => {
  const t = setup();
  t.at(OFFICE); await t.svc.tick(); await t.pass(10);
  t.at(HOME); await t.pass(3);
  t.at(OFFICE); await t.pass(10);
  let day = t.svc.month(2026, 11)[0]!;
  // 3분 끊긴 것은 한 구간으로 이어진다 (그 사이도 근무로 센다)
  expect(day.sessions.length).toBe(1);
  expect(day.totalMs).toBe(23 * 60_000);
  t.at(HOME); await t.pass(60);
  t.at(OFFICE); await t.pass(20);
  day = t.svc.month(2026, 11)[0]!;
  expect(day.sessions.length).toBe(2);
  expect(day.totalMs).toBe((23 + 19) * 60_000);
  expect(day.firstAt).toBeLessThan(day.lastAt);
  // 잘못 잰 구간은 지울 수 있다
  t.svc.removeSession(day.sessions[1]!.id);
  expect(t.svc.month(2026, 11)[0]!.sessions.length).toBe(1);
});

test('자정을 넘기면 다음 날의 구간이 된다. 달마다 기록이 있는 날만 준다', async () => {
  const t = setup();
  t.at(OFFICE);
  t.jump(14 * 3_600_000 + 50 * 60_000);   // 23:50
  await t.svc.tick(); await t.pass(20);     // 00:10 까지
  const days = t.svc.month(2026, 11);
  expect(days.map((d) => d.day)).toEqual(['2026-11-13', '2026-11-14']);
  expect(days[0]!.totalMs).toBe(9 * 60_000);
  expect(days[1]!.totalMs).toBe(10 * 60_000);
  expect(t.svc.month(2026, 12)).toEqual([]);
  expect(dayOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
});

test('와이파이 이름이 가려져 있으면 이름으로는 못 알아본다. 그 네트워크를 근무지로 기억하면 알아본다', async () => {
  const t = setup();
  t.at(HIDDEN);
  await t.svc.tick();
  expect(t.svc.status()).toMatchObject({ atWork: false, ssid: null, ssidHidden: true, remembered: false, networks: 0 });
  expect(await t.svc.rememberCurrent()).toMatchObject({ atWork: true, remembered: true, networks: 1 });
  await t.pass(5);
  expect(t.svc.status().todayMs).toBe(5 * 60_000);
  // 다른 네트워크에서는 세지 않는다
  t.at({ ssid: null, hidden: true, gateway: 'aa:bb:cc:00:00:09' });
  await t.pass(5);
  expect(t.svc.status()).toMatchObject({ atWork: false, todayMs: 5 * 60_000 });
  t.svc.forgetNetworks();
  t.at(HIDDEN); await t.pass(2);
  expect(t.svc.status()).toMatchObject({ atWork: false, networks: 0 });
  t.at({ ssid: null, hidden: false, gateway: null });
  await expect(t.svc.rememberCurrent()).rejects.toThrow('알아볼 수 없습니다');
});

test('꺼 두면 세지 않는다. 이름을 비워 두면 어떤 와이파이도 근무지가 아니다', async () => {
  const t = setup('');
  t.at({ ssid: '', hidden: false, gateway: 'x' }); await t.pass(3);
  t.at(OFFICE); await t.pass(3);
  expect(t.svc.status()).toMatchObject({ atWork: false, todayMs: 0 });
  t.settings.update({ workWifi: '11st-OA' });
  await t.pass(3);
  expect(t.svc.status().atWork).toBe(true);
  t.settings.update({ workTimeEnabled: false });
  await t.pass(10);
  expect(t.svc.status()).toMatchObject({ enabled: false, atWork: false, todayMs: 2 * 60_000 });
});

describe('출퇴근 기록 (30분 단위로 올림, 퇴근은 단추로)', () => {
  const at = (h: number, m: number): number => new Date(2026, 10, 13, h, m, 0).getTime();
  const hm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  test('시각은 30분 단위로 올린다', () => {
    expect(hm(ceilHalf(at(9, 14)))).toBe('09:30');
    expect(hm(ceilHalf(at(15, 20)))).toBe('15:30');
    expect(hm(ceilHalf(at(9, 30)))).toBe('09:30');
    expect(hm(ceilHalf(at(9, 31)))).toBe('10:00');
    expect(hm(ceilHalf(at(9, 0) + 1000))).toBe('09:30');
  });

  test('09:14 에 와이파이에 붙으면 09:30 출근, 15:20 에 퇴근을 누르면 15:30 퇴근: 그날 6시간', async () => {
    const t = setup();                               // 09:00, 집
    t.settings.update({ workTimeUnit: 'half' });
    await t.svc.tick();
    expect(t.svc.status()).toMatchObject({ unit: 'half', openSession: null, todayMs: 0 });
    await t.pass(13);
    t.at(OFFICE);
    await t.pass(1);                                 // 09:14 에 붙는다
    let st = t.svc.status();
    expect(hm(st.openSession!.startAt)).toBe('09:30');
    // 올려 적은 출근 시각이 오기 전에는 0 이다
    expect(st.todayMs).toBe(0);
    await t.pass(46);                                // 10:00
    expect(t.svc.status().todayMs).toBe(30 * 60_000);
    // 와이파이가 끊겨도 퇴근이 아니다: 퇴근은 눌러야 한다
    t.at(HOME);
    await t.pass(60);                                // 11:00
    expect(t.svc.status()).toMatchObject({ atWork: false, todayMs: 90 * 60_000 });
    expect(t.svc.status().openSession).not.toBeNull();
    t.at(OFFICE);
    await t.pass(260);                               // 15:20
    st = t.svc.clockOut();
    expect(st.openSession).toBeNull();
    expect(st.todayMs).toBe(6 * 3_600_000);
    const day = t.svc.month(2026, 11)[0]!;
    expect(day.sessions.map((s) => [hm(s.startAt), hm(s.endAt), s.open])).toEqual([['09:30', '15:30', false]]);
    // 퇴근한 뒤에는 와이파이에 붙어 있어도 다시 저절로 출근하지 않는다
    await t.pass(30);
    expect(t.svc.status().openSession).toBeNull();
    expect(() => t.svc.clockOut()).toThrow('출근한 상태가 아닙니다');
    // 다시 일하면 직접 출근을 누른다
    expect(hm(t.svc.clockIn().openSession!.startAt)).toBe('16:00');
    expect(() => t.svc.clockIn()).toThrow('이미 출근한 상태');
  });

  test('퇴근을 누르지 않고 날이 바뀌면, 마지막으로 근무지에서 확인된 시각으로 닫는다', async () => {
    const t = setup();
    t.settings.update({ workTimeUnit: 'half' });
    t.at(OFFICE);
    await t.svc.tick();                              // 09:00 출근
    await t.pass(9 * 60 + 12);                       // 18:12 까지 근무지에 있었다
    t.at(HOME);
    await t.pass(60);
    t.jump(14 * 3_600_000);                          // 다음 날 아침
    t.at(OFFICE);
    await t.svc.tick();
    const days = t.svc.month(2026, 11);
    expect(days.map((d) => d.day)).toEqual(['2026-11-13', '2026-11-14']);
    expect(days[0]!.sessions.map((s) => [hm(s.startAt), hm(s.endAt), s.open, s.auto])).toEqual([['09:00', '18:30', false, true]]);
    expect(days[0]!.totalMs).toBe(9.5 * 3_600_000);
    // 새 날의 출근이 적혔다
    expect(t.svc.status().openSession).not.toBeNull();
  });
});
