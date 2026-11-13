import { useCallback, useEffect, useState } from 'react';
import type { Figure } from '@shared/types';
import { fileName, groupFigures, svgDataUrl } from '../figureView';

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
/** Mermaid 는 처음 쓸 때 불러온다 (크다). 스크립트와 HTML 글자를 쓰지 않게 가장 엄격하게 둔다. */
function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidReady ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', flowchart: { htmlLabels: false }, fontFamily: 'system-ui, -apple-system, sans-serif' });
    return m.default;
  });
  return mermaidReady;
}

let seq = 0;
/** 그림 하나를 SVG 글로. Mermaid 는 여기서 그린다. 틀리면 오류를 돌려준다. */
async function toSvg(f: Figure): Promise<{ svg: string } | { error: string }> {
  if (f.kind === 'svg') return { svg: f.source };
  try {
    const m = await loadMermaid();
    const { svg } = await m.render(`dure-fig-${++seq}`, f.source);
    return { svg: /\sxmlns=/.test(svg.slice(0, 300)) ? svg : svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"') };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function FigureView({ figure, big }: { figure: Figure; big: boolean }) {
  const [out, setOut] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => { let alive = true; setOut(null); void toSvg(figure).then((r) => { if (alive) setOut(r); }); return () => { alive = false; }; }, [figure]);
  if (!out) return <div className="muted figure-wait">그리는 중…</div>;
  if ('error' in out) return <div className="error figure-error">그림으로 바꾸지 못했습니다 (Mermaid 문법): {out.error.slice(0, 400)}<pre className="raw">{figure.source.slice(0, 2000)}</pre></div>;
  return <img className={`figure-img${big ? ' big' : ''}`} src={svgDataUrl(out.svg)} alt={figure.title} draggable={false} />;
}

/** SVG 나 PNG 로 저장한다 (다운로드). PNG 는 그림을 두 배로 그려 만든다. */
async function save(f: Figure, as: 'svg' | 'png'): Promise<void> {
  const r = await toSvg(f);
  if ('error' in r) throw new Error(r.error);
  let blob: Blob;
  if (as === 'svg') blob = new Blob([r.svg], { type: 'image/svg+xml' });
  else {
    const img = new Image();
    img.src = svgDataUrl(r.svg);
    await img.decode();
    const w = Math.max(1, img.naturalWidth || 800); const h = Math.max(1, img.naturalHeight || 600);
    const c = document.createElement('canvas');
    c.width = w * 2; c.height = h * 2;
    const g = c.getContext('2d')!;
    g.scale(2, 2);
    g.drawImage(img, 0, 0, w, h);
    blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG 로 만들지 못했습니다.'))), 'image/png'));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName(f.title, as);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** 워크스페이스 옆 패널의 "그림" 탭. 에이전트가 그린 그림을 보이고, 판을 오가고, 크게 보고, 저장한다. */
export function FigurePanel({ workspaceId, readOnly, onCount }: { workspaceId: string; readOnly?: boolean; onCount?: (n: number) => void }) {
  const [list, setList] = useState<Figure[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.figures.list(workspaceId).then((l) => { setList(l); onCount?.(l.length); }).catch(() => setList([])); }, [workspaceId, onCount]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'figures') load(); });
  }, [load]);
  const groups = groupFigures(list);
  // 고른 것이 없거나 사라졌으면 가장 새 그림
  const current = list.find((f) => f.id === pick) ?? groups[0]?.versions[0];
  useEffect(() => { setPick(null); }, [groups[0]?.versions[0]?.id]);
  if (!current) return <div className="todo-scroll"><div className="rows-empty">아직 그림이 없습니다. 에이전트에게 "그림 그려줘", "구조를 도식으로 보여줘" 라고 하면 여기에 보입니다.</div></div>;
  const group = groups.find((g) => g.groupId === current.groupId)!;
  const vi = group.versions.findIndex((v) => v.id === current.id);
  return (
    <div className="todo-scroll figure-panel">
      <div className="figure-head">
        <select value={current.groupId} onChange={(e) => setPick(groups.find((g) => g.groupId === e.target.value)?.versions[0]?.id ?? null)} title="그림 고르기">
          {groups.map((g) => <option key={g.groupId} value={g.groupId}>{g.title}{g.versions.length > 1 ? ` (${g.versions.length}판)` : ''}</option>)}
        </select>
        {group.versions.length > 1 && (
          <span className="figure-ver">
            <button className="btn ghost" disabled={vi >= group.versions.length - 1} onClick={() => setPick(group.versions[vi + 1]!.id)} title="앞의 판">‹</button>
            {current.version}판
            <button className="btn ghost" disabled={vi <= 0} onClick={() => setPick(group.versions[vi - 1]!.id)} title="다음 판">›</button>
          </span>
        )}
      </div>
      {current.note && <div className="muted figure-note">{current.note}</div>}
      <button className="figure-frame" onClick={() => setBig(true)} title="크게 보기"><FigureView figure={current} big={false} /></button>
      <div className="figure-actions">
        <button className="btn ghost" onClick={() => setBig(true)}>크게 보기</button>
        <button className="btn ghost" onClick={() => { save(current, 'svg').catch((e: Error) => setError(e.message)); }}>SVG 저장</button>
        <button className="btn ghost" onClick={() => { save(current, 'png').catch((e: Error) => setError(e.message)); }}>PNG 저장</button>
        {current.kind === 'mermaid' && <button className="btn ghost" onClick={() => { void navigator.clipboard.writeText(current.source); }} title="Mermaid 코드를 복사합니다">코드 복사</button>}
        {!readOnly && <button className="btn ghost danger" onClick={() => { window.dure.figures.remove(current.id).catch((e: Error) => setError(e.message)); }}>이 판 지우기</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {big && (
        <div className="figure-overlay" onClick={() => setBig(false)} role="dialog" aria-label={current.title}>
          <div className="figure-overlay-title">{current.title} · {current.version}판 <span className="muted">(아무 곳이나 누르면 닫힙니다)</span></div>
          <FigureView figure={current} big />
        </div>
      )}
    </div>
  );
}
