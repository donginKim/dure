import { useCallback, useEffect, useState } from 'react';
import type { Schedule, ScheduleInput, Workspace } from '@shared/types';
import { Empty } from './Empty';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const when = (at: number): string => { const d = new Date(at); const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return d.toDateString() === new Date().toDateString() ? `오늘 ${t}` : `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${t}`; };
const rule = (s: Schedule): string => (s.kind === 'daily' ? `매일 ${s.time}` : s.kind === 'weekly' ? `매주 ${DAYS[s.weekday ?? 1]}요일 ${s.time}` : s.runAt ? `한 번 · ${when(s.runAt)}` : '한 번');
const blank = (workspaceId: string): ScheduleInput & { inMinutes: string } => ({ workspaceId, title: '', prompt: '', kind: 'daily', time: '09:00', weekday: 5, inMinutes: '30' });

/**
 * 예약 실행: 정한 때에 워크스페이스의 에이전트에게 일을 시킨다 (매일, 매주, 조금 뒤에 한 번).
 * 때가 되면 두레가 그 워크스페이스에 메시지로 보낸다. 예산을 넘은 프로젝트면 보내지 않는다.
 */
export function SchedulesSection({ projectId, workspaces, readOnly }: { projectId: string; workspaces: Workspace[]; readOnly?: boolean }) {
  const [list, setList] = useState<Schedule[]>([]);
  const [form, setForm] = useState<(ScheduleInput & { inMinutes: string }) | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.schedules.list(projectId).then(setList).catch(() => undefined); }, [projectId]);
  useEffect(() => { load(); const off = window.dure.onChanged((topic) => { if (topic === 'schedules') load(); }); const t = setInterval(load, 60_000); return () => { off(); clearInterval(t); }; }, [load]);
  const name = (id: string): string => { const w = workspaces.find((x) => x.id === id); return !w ? '지운 워크스페이스' : w.role === 'coordinator' ? '조율 에이전트' : w.name; };
  const run = (p: Promise<unknown>): void => { setError(''); p.catch((e: Error) => setError(e.message)); };
  const save = (): void => {
    if (!form) return;
    const { inMinutes, ...input } = form;
    const payload: ScheduleInput = input.kind === 'once' ? { ...input, runAt: Date.now() + Math.max(1, Number(inMinutes) || 30) * 60_000 } : input;
    setError('');
    window.dure.schedules.save(payload).then(() => setForm(null)).catch((e: Error) => setError(e.message));
  };
  const first = workspaces[0]?.id ?? '';
  return (
    <div className="section">
      <div className="section-head">
        <h2>예약 <span className="count">{list.length}</span></h2>
        {!readOnly && !form && list.length > 0 && <button className="btn" disabled={!first} onClick={() => setForm(blank(first))}>예약 추가</button>}
      </div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      <div className="rows">
        {list.length === 0 && !form && (
          <Empty hint={'정한 때에 에이전트에게 일을 시킵니다. 예: 매일 9시 "의존성 점검", 금요일 17시 "주간 보고 초안", 30분 뒤 "배포 결과 확인".'}
            actions={!readOnly && <button className="btn" disabled={!first} onClick={() => setForm(blank(first))}>예약 추가</button>}>예약이 없습니다.</Empty>
        )}
        {list.map((s) => (
          <div key={s.id} className={`row sched-row${s.enabled ? '' : ' off'}`}>
            <div className="grow">
              <div><b>{s.title}</b> <span className="muted">· {name(s.workspaceId)} · {rule(s)}</span></div>
              <div className="sched-prompt" title={s.prompt}>{s.prompt}</div>
              <div className="muted sched-meta">{s.nextAt ? `다음: ${when(s.nextAt)}` : s.enabled ? '끝남' : '꺼짐'}{s.lastRunAt && s.kind !== 'once' ? ` · 마지막: ${when(s.lastRunAt)}` : ''}</div>
            </div>
            {!readOnly && <button className="btn ghost" title="때와 상관없이 지금 한 번 시킵니다" onClick={() => run(window.dure.schedules.runNow(s.id))}>지금 돌리기</button>}
            {!readOnly && <button className="btn ghost" onClick={() => run(window.dure.schedules.setEnabled(s.id, !s.enabled))}>{s.enabled ? '끄기' : '켜기'}</button>}
            {!readOnly && <button className="btn ghost" onClick={() => run(window.dure.schedules.remove(s.id))}>지우기</button>}
          </div>
        ))}
        {form && (
          <div className="row sched-form">
            <input type="text" value={form.title} placeholder="제목 (예: 의존성 점검)" onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <textarea value={form.prompt} rows={3} placeholder="에이전트에게 시킬 일" onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
            <div className="sched-when">
              <select value={form.workspaceId} onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.role === 'coordinator' ? '조율 에이전트' : w.name}</option>)}
              </select>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Schedule['kind'] })}>
                <option value="daily">매일</option><option value="weekly">매주</option><option value="once">조금 뒤에 한 번</option>
              </select>
              {form.kind === 'weekly' && <select value={form.weekday ?? 5} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={i} value={i}>{d}요일</option>)}</select>}
              {form.kind !== 'once' && <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />}
              {form.kind === 'once' && <><input type="text" inputMode="numeric" className="sched-min" value={form.inMinutes} onChange={(e) => setForm({ ...form, inMinutes: e.target.value })} /> 분 뒤</>}
              <span className="grow" />
              <button className="btn ghost" onClick={() => { setForm(null); setError(''); }}>취소</button>
              <button className="btn primary" disabled={!form.title.trim() || !form.prompt.trim()} onClick={save}>저장</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
