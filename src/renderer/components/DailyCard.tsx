import { useCallback, useEffect, useState } from 'react';
import type { DailyDigest } from '@shared/types';
import { hm, reportText, tok } from '../digestView';
import type { Selection } from '../tree';

const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const FOLD_KEY = 'dure.daily.folded';

function Totals({ d }: { d: DailyDigest }) {
  return (
    <div className="daily-totals">
      <span>TODO <b>{d.totals.done}</b></span><span>커밋 <b>{d.totals.commits}</b></span><span>main 반영 <b>{d.totals.mains}</b></span>
      <span>토큰 <b>{tok(d.totals.tokens)}</b></span>{hm(d.totals.workMs) && <span>근무 <b>{hm(d.totals.workMs)}</b></span>}
    </div>
  );
}

/**
 * 오늘의 두레: 아침에는 브리핑(어제 한 일, 지금 나를 기다리는 것, 오늘 이어 갈 일), 저녁에는 오늘 결산.
 * 결산은 보고서 글로 복사할 수 있다. 이미 있는 기록에서 만든다 (LLM 을 부르지 않는다).
 */
export function DailyCard({ onSelect }: { onSelect: (s: Selection) => void }) {
  const [tab, setTab] = useState<'morning' | 'evening'>(new Date().getHours() < 14 ? 'morning' : 'evening');
  const [now, setNow] = useState<DailyDigest | null>(null);
  const [prev, setPrev] = useState<DailyDigest | null>(null);
  const [copied, setCopied] = useState(false);
  // 접어 둔 것은 그날만 기억한다: 다음 날 아침에는 다시 펴진다.
  const [folded, setFolded] = useState(() => { try { return window.localStorage.getItem(FOLD_KEY) === today(); } catch { return false; } });
  const load = useCallback(() => {
    window.dure.projects.digest(0).then(setNow).catch(() => undefined);
    window.dure.projects.digest(1).then(setPrev).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'todos' || topic === 'commit' || topic === 'attention') load(); });
    return off;
  }, [load]);
  if (!now || !prev) return null;
  const fold = (v: boolean): void => { setFolded(v); try { if (v) window.localStorage.setItem(FOLD_KEY, today()); else window.localStorage.removeItem(FOLD_KEY); } catch { /* 못 기억해도 된다 */ } };
  const copy = (d: DailyDigest): void => {
    navigator.clipboard.writeText(reportText(d)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };
  if (folded) {
    return (
      <button className="daily folded" onClick={() => fold(false)}>
        <b>오늘의 두레</b>
        <span className="muted">오늘 TODO {now.totals.done}개 완료{now.attention.length ? ` · 확인할 것 ${now.attention.length}` : ''}{now.doing.length ? ` · 하는 중 ${now.doing.length}` : ''}</span>
        <span className="grow" /><span className="muted">펴기</span>
      </button>
    );
  }
  const d = tab === 'morning' ? prev : now;
  return (
    <div className="daily">
      <div className="daily-head">
        <b>오늘의 두레</b>
        <div className="view-switch" role="tablist">
          <button role="tab" aria-selected={tab === 'morning'} className={tab === 'morning' ? 'on' : ''} onClick={() => setTab('morning')}>아침 브리핑</button>
          <button role="tab" aria-selected={tab === 'evening'} className={tab === 'evening' ? 'on' : ''} onClick={() => setTab('evening')}>오늘 결산</button>
        </div>
        <span className="grow" />
        <button className="btn ghost" title="보고서 글(마크다운)로 복사합니다. 일일 보고나 주간 보고 초안으로 쓰세요" onClick={() => copy(d)}>{copied ? '복사됨' : tab === 'morning' ? '어제 보고서 복사' : '오늘 보고서 복사'}</button>
        <button className="btn ghost" onClick={() => fold(true)}>접기</button>
      </div>
      {tab === 'morning' && (
        <div className="daily-cols">
          <div>
            <div className="daily-label">지금 나를 기다리는 것 <span className="count">{now.attention.length}</span></div>
            {now.attention.length === 0 ? <div className="muted">없습니다.</div> : now.attention.slice(0, 5).map((a, i) => <div key={i} className="daily-line warn">{a.title}{a.projectName && <span className="muted"> · {a.projectName}</span>}</div>)}
            {now.attention.length > 0 && <button className="btn ghost daily-more" onClick={() => onSelect({ type: 'attention' })}>확인할 것 열기</button>}
          </div>
          <div>
            <div className="daily-label">오늘 이어 갈 일 <span className="count">{now.doing.length}</span></div>
            {now.doing.length === 0 ? <div className="muted">하는 중인 일이 없습니다{now.todo ? ` (시작 전 ${now.todo}개)` : ''}.</div> : now.doing.slice(0, 5).map((t, i) => <div key={i} className="daily-line">{t.title}{t.project && <span className="muted"> · {t.project}</span>}</div>)}
            {now.doing.length > 5 && <div className="muted">외 {now.doing.length - 5}개</div>}
          </div>
          <div>
            <div className="daily-label">어제 한 일</div>
            <Totals d={prev} />
            {prev.projects.filter((p) => p.done.length).slice(0, 3).map((p) => <div key={p.projectId} className="daily-line">{p.name} <span className="muted">· {p.done.length}개 완료</span></div>)}
            {prev.totals.done === 0 && <div className="muted">어제 끝낸 TODO 가 없습니다.</div>}
          </div>
        </div>
      )}
      {tab === 'evening' && (
        <div className="daily-evening">
          <Totals d={now} />
          {now.totals.done === 0 && now.totals.commits === 0 && <div className="muted">오늘은 아직 끝낸 일이 없습니다.</div>}
          {now.projects.filter((p) => p.done.length || p.commits || p.mains).map((p) => (
            <div key={p.projectId} className="daily-project">
              <div className="daily-label">{p.name} <span className="muted">· 완료 {p.done.length}{p.commits ? ` · 커밋 ${p.commits}` : ''}{p.mains ? ` · main 반영 ${p.mains}` : ''}</span></div>
              {p.done.slice(0, 6).map((t, i) => <div key={i} className="daily-line done">{t.title}{t.workspace && <span className="muted"> · {t.workspace}</span>}</div>)}
              {p.done.length > 6 && <div className="muted">외 {p.done.length - 6}개</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
