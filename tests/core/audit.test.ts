import { AuditLog } from '@core/audit';
import { openDatabase } from '@core/db';

function setup(keepDays = 0) {
  const db = openDatabase(':memory:');
  let now = Date.UTC(2026, 10, 1);
  const log = new AuditLog({ db, now: () => now, keepDays: () => keepDays });
  return { db, log, tick: (ms: number) => { now += ms; }, at: () => now };
}
const WHO = { host: 'mac', user: 'tester', app: '0.1.0' };

test('한 줄씩 적고, 새것부터 읽고, 누가·무엇을·결과로 거른다', () => {
  const { log, tick } = setup();
  log.record({ actor: 'user', action: 'plugin.approve', target: 'report-kit' });
  tick(1000);
  log.record({ actor: 'agent', actorName: 'API', action: 'db.query', projectId: 'p1', workspaceId: 'w1', target: '운영 DB', outcome: 'denied', reason: '사용자가 거절', detail: { rows: 0 } });
  tick(1000);
  log.record({ actor: 'system', action: 'autoship.stop', projectId: 'p1', outcome: 'failed', reason: '확인 명령 실패' });
  expect(log.list().map((e) => e.action)).toEqual(['autoship.stop', 'db.query', 'plugin.approve']);
  expect(log.list({ actor: 'agent' })).toMatchObject([{ actorName: 'API', outcome: 'denied', reason: '사용자가 거절', detail: { rows: 0 } }]);
  expect(log.list({ action: 'db.' }).map((e) => e.action)).toEqual(['db.query']);
  expect(log.list({ projectId: 'p1' })).toHaveLength(2);
  expect(log.list({ outcome: 'failed' })).toHaveLength(1);
  expect(log.count({ projectId: 'p1' })).toBe(2);
  // 이어 읽기
  const first = log.list({ limit: 2 });
  expect(log.list({ limit: 2, before: first[1]!.seq }).map((e) => e.action)).toEqual(['plugin.approve']);
});

test('줄을 고치거나 빼면 어디서 어긋났는지 드러난다', () => {
  const { db, log } = setup();
  for (let i = 0; i < 5; i++) log.record({ actor: 'user', action: 'todo.add', target: `t${i}` });
  expect(log.verify()).toMatchObject({ ok: true, count: 5, brokenAt: null, firstSeq: 1, lastSeq: 5 });
  db.prepare("UPDATE audit_log SET target = '고친 값' WHERE seq = 3").run();
  expect(log.verify()).toMatchObject({ ok: false, brokenAt: 3 });
  db.prepare("UPDATE audit_log SET target = 't2' WHERE seq = 3").run();
  expect(log.verify().ok).toBe(true);
  // 결과만 살짝 바꿔도 드러난다
  db.prepare("UPDATE audit_log SET outcome = 'denied' WHERE seq = 5").run();
  expect(log.verify()).toMatchObject({ ok: false, brokenAt: 5 });
  db.prepare("UPDATE audit_log SET outcome = 'ok' WHERE seq = 5").run();
  // 중간 줄을 빼면 그 다음 줄에서 어긋난다
  db.prepare('DELETE FROM audit_log WHERE seq = 2').run();
  expect(log.verify()).toMatchObject({ ok: false, brokenAt: 3 });
});

test('다시 켜도 앞의 줄에 이어 적는다', () => {
  const { db, log } = setup();
  log.record({ actor: 'user', action: 'a.one' });
  const again = new AuditLog({ db });
  again.record({ actor: 'user', action: 'a.two' });
  expect(again.verify()).toMatchObject({ ok: true, count: 2 });
});

test('본문은 길게 적히지 않고, 줄바꿈·제어 문자는 걷어 낸다. 기록이 실패해도 던지지 않는다', () => {
  const { db, log } = setup();
  log.record({ actor: 'agent', action: 'tool.message send!', target: `줄\n바꿈\x1b[31m ${'가'.repeat(500)}`, reason: 'x'.repeat(1000), detail: { note: 'y'.repeat(1000), n: 3 } });
  const e = log.list()[0]!;
  expect(e.action).toBe('tool.message_send_');
  expect(e.target).not.toMatch(/[\n\x1b]/);
  expect(e.target.length).toBeLessThanOrEqual(200);
  expect(e.reason.length).toBeLessThanOrEqual(300);
  expect(String(e.detail.note).length).toBeLessThanOrEqual(200);
  expect(e.detail.n).toBe(3);
  db.close();
  expect(() => log.record({ actor: 'user', action: 'after.close' })).not.toThrow();
});

test('보관 기간이 지난 줄은 지우되, 남은 줄의 이어짐은 계속 확인된다', () => {
  const { log, tick } = setup(30);
  log.record({ actor: 'user', action: 'old.one' });
  log.record({ actor: 'user', action: 'old.two' });
  tick(40 * 86_400_000);
  log.record({ actor: 'user', action: 'new.one' });
  expect(log.prune()).toBe(2);
  expect(log.list().map((e) => e.action)).toEqual(['audit.prune', 'new.one']);
  expect(log.verify()).toMatchObject({ ok: true, count: 2, pruned: 2 });
  expect(log.prune()).toBe(0);
  // 지우지 않는 설정(0)
  const keep = setup(0);
  keep.log.record({ actor: 'user', action: 'x' }); keep.tick(9999 * 86_400_000);
  expect(keep.log.prune()).toBe(0);
});

test('내보내기: JSONL 은 첫 줄에 묶음의 설명을 싣고, 받는 쪽이 지문으로 이어짐을 다시 확인할 수 있다', async () => {
  const { createHash } = await import('node:crypto');
  const { log, tick } = setup();
  log.record({ actor: 'user', action: 'plugin.approve', target: 'kit' });
  tick(5);
  log.record({ actor: 'agent', actorName: 'API', action: 'db.query', target: '=cmd|x', outcome: 'denied', reason: '쉼표, 와 "따옴표"' });
  const lines = log.export('jsonl', {}, WHO).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ type: 'meta', format: 'dure-audit/1', host: 'mac', osUser: 'tester', rows: 2, chainOk: true });
  let prev = '';
  for (const r of lines.slice(1)) {
    expect(r.prev).toBe(prev);
    expect(r.hash).toBe(createHash('sha256').update(JSON.stringify([prev, r.at, r.actor, r.actorName, r.action, r.projectId, r.workspaceId, r.target, r.outcome, r.reason, r.detail])).digest('hex'));
    prev = r.hash as string;
  }
  expect(lines[0]!.head).toBe(prev);
  expect(lines[1]!.time).toBe('2026-11-01T00:00:00.000Z');
  // CSV: 머리 줄, 따옴표·쉼표 처리, 수식으로 읽힐 값은 무디게
  const csv = log.export('csv', { actor: 'agent' }, WHO).trim().split('\n');
  expect(csv[0]).toBe('seq,time,actor,actor_name,action,outcome,project_id,workspace_id,target,reason,detail,prev,hash');
  expect(csv).toHaveLength(2);
  expect(csv[1]).toContain(",'=cmd|x,");
  expect(csv[1]).toContain('"쉼표, 와 ""따옴표"""');
});
