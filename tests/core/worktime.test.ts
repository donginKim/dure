import { join } from 'node:path';
import { openDatabase } from '@core/db';
import { SettingsService } from '@core/settings';
import { dayOf, WorkTimeService, type NetworkProbe } from '@core/worktime';
import { tempDir } from '../helpers/repo';

const OFFICE: NetworkProbe = { ssid: '11st-OA', hidden: false, gateway: 'aa:bb:cc:00:00:01' };
const HOME: NetworkProbe = { ssid: 'home', hidden: false, gateway: 'aa:bb:cc:00:00:02' };
const HIDDEN: NetworkProbe = { ssid: null, hidden: true, gateway: 'aa:bb:cc:00:00:01' };

function setup(wifi = '11st-oa') {
  const db = openDatabase(join(tempDir(), 'dure.db'));
  const settings = new SettingsService(db);
  settings.update({ workTimeEnabled: true, workWifi: wifi });
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

test('30분 단위: 매 정각과 30분에 확인해, 그때 붙어 있으면 그 30분을 통째로 센다', async () => {
  const t = setup();                       // 09:00
  t.settings.update({ workTimeUnit: 'half' });
  // 09:10 에 도착한다: 09:00 의 확인 때는 없었으니 그 칸은 세지 않는다
  await t.svc.tick();
  await t.pass(10);
  t.at(OFFICE);
  await t.pass(19);                        // 09:29
  expect(t.svc.status().todayMs).toBe(0);
  await t.pass(1);                         // 09:30 의 확인
  expect(t.svc.status()).toMatchObject({ atWork: true, todayMs: 30 * 60_000 });
  await t.pass(29);                        // 09:59: 같은 칸은 한 번만 센다
  expect(t.svc.status().todayMs).toBe(30 * 60_000);
  await t.pass(61);                        // 11:00 까지: 10:00, 10:30, 11:00 의 확인
  let day = t.svc.month(2026, 11)[0]!;
  // 이어진 칸은 한 구간이다: 09:30 ~ 11:30
  expect(day.sessions.length).toBe(1);
  expect(day.totalMs).toBe(4 * 30 * 60_000);
  expect(new Date(day.firstAt).getMinutes()).toBe(30);
  expect(new Date(day.lastAt).getMinutes()).toBe(30);
  // 11:10 에 나간다: 11:00 에 있었으니 11:30 까지 센 것으로 남고, 그 뒤는 세지 않는다
  t.at(HOME);
  await t.pass(80);                        // 12:20
  expect(t.svc.status()).toMatchObject({ atWork: false, todayMs: 4 * 30 * 60_000 });
  // 다시 붙으면 새 구간
  t.at(OFFICE);
  await t.pass(10);                        // 12:30
  day = t.svc.month(2026, 11)[0]!;
  expect(day.sessions.length).toBe(2);
  expect(day.totalMs).toBe(5 * 30 * 60_000);
});

test('30분 단위: 정각·30분에 두레가 확인하지 못했으면 (꺼져 있었거나 잠들어 있었으면) 그 칸은 세지 않는다', async () => {
  const t = setup();
  t.settings.update({ workTimeUnit: 'half' });
  t.at(OFFICE);
  t.jump(7 * 60_000);                      // 09:07 에 처음 확인한다 (정각에서 2분 넘게 지났다)
  await t.svc.tick();
  expect(t.svc.status()).toMatchObject({ atWork: true, todayMs: 0 });
  t.jump(24 * 60_000);                     // 09:31: 30분에서 1분 지났다 → 그 칸의 확인으로 친다
  await t.svc.tick();
  expect(t.svc.status().todayMs).toBe(30 * 60_000);
});
