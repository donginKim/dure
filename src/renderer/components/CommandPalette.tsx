import { useEffect, useMemo, useRef, useState } from 'react';
import type { AttentionItem } from '@shared/types';
import { STATUS_LABEL, type Selection, type TreeNode } from '../tree';

interface Cmd { id: string; group: string; title: string; hint?: string; keys: string; run: () => void }

/** 글자를 띄엄띄엄 맞춰도 찾는다 (예: "결api" → "결제 API"). 점수가 낮을수록 잘 맞는다. 맞지 않으면 -1 */
export function fuzzy(text: string, q: string): number {
  const t = text.toLowerCase().replace(/\s+/g, '');
  const s = q.toLowerCase().replace(/\s+/g, '');
  if (!s) return 0;
  const at = t.indexOf(s);
  if (at >= 0) return at;
  let i = 0; let gaps = 0; let last = -1;
  for (const ch of s) {
    const j = t.indexOf(ch, i);
    if (j < 0) return -1;
    if (last >= 0) gaps += j - last - 1;
    last = j; i = j + 1;
  }
  return 100 + gaps;
}

/**
 * ⌘K 명령 창: 프로젝트·워크스페이스로 가고, 확인할 것을 열고, 자주 쓰는 화면을 연다. 키보드만으로 쓴다.
 * ↑↓ 로 고르고 Enter 로 실행, Esc 로 닫는다.
 */
export function CommandPalette({ tree, onSelect, onClose, onNewProject, onToggleNotes }: {
  tree: TreeNode[]; onSelect: (s: Selection) => void; onClose: () => void; onNewProject: () => void; onToggleNotes: () => void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); window.dure.attention.list().then(setAttention).catch(() => undefined); }, []);

  const all = useMemo<Cmd[]>(() => {
    const go = (s: Selection) => () => { onSelect(s); onClose(); };
    const out: Cmd[] = [];
    for (const a of attention) out.push({ id: `a:${a.id}`, group: '확인할 것', title: a.title, hint: a.projectName, keys: `${a.title} ${a.projectName} 확인`, run: go({ type: 'attention' }) });
    for (const { project, workspaces } of tree) {
      out.push({ id: `p:${project.id}`, group: '프로젝트', title: project.name, hint: `워크스페이스 ${workspaces.length}`, keys: project.name, run: go({ type: 'project', id: project.id }) });
      for (const w of workspaces) {
        const name = w.role === 'coordinator' ? '조율 에이전트' : w.name;
        out.push({ id: `w:${w.id}`, group: '워크스페이스', title: name, hint: `${project.name} · ${STATUS_LABEL[w.status]}`, keys: `${name} ${project.name}`, run: go(w.role === 'coordinator' ? { type: 'project', id: project.id } : { type: 'workspace', id: w.id, projectId: project.id }) });
      }
    }
    const act = (id: string, title: string, keys: string, run: () => void, hint?: string): void => { out.push({ id, group: '할 일', title, keys: `${title} ${keys}`, run, hint }); };
    act('new-project', '새 프로젝트', 'new project 만들기', () => { onNewProject(); onClose(); });
    act('attention', '확인할 것 열기', 'attention inbox', go({ type: 'attention' }));
    act('notes', '메모 열기/닫기', 'notes memo', () => { onToggleNotes(); onClose(); }, '⌘⇧M');
    act('team', '팀 현황', 'team board', go({ type: 'team' }));
    act('people', '사람', 'people peers 연결', go({ type: 'people' }));
    act('worktime', '근무시간', 'worktime', go({ type: 'worktime' }));
    act('settings', '설정', 'settings preferences', go({ type: 'settings' }), '⌘,');
    act('home', '프로젝트 전체 보기', 'home dashboard 대시보드', go(null));
    return out;
  }, [tree, attention, onSelect, onClose, onNewProject, onToggleNotes]);

  const shown = useMemo(() => {
    if (!q.trim()) return all.filter((c) => c.group !== '워크스페이스' || all.length < 40).slice(0, 60);
    return all.map((c) => ({ c, s: fuzzy(c.keys, q) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s).slice(0, 40).map((x) => x.c);
  }, [all, q]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.cmd-item.on')?.scrollIntoView({ block: 'nearest' }); }, [at]);

  const key = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); shown[at]?.run(); }
  };
  let lastGroup = '';
  return (
    <div className="cmd-backdrop" onMouseDown={onClose}>
      <div className="cmd" role="dialog" aria-label="명령 창" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="cmd-input" value={q} placeholder="프로젝트, 워크스페이스, 할 일을 찾습니다…" onChange={(e) => setQ(e.target.value)} onKeyDown={key} />
        <div className="cmd-list" ref={list}>
          {shown.length === 0 && <div className="cmd-empty">맞는 것이 없습니다.</div>}
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <div key={c.id}>
                {head && <div className="cmd-group">{head}</div>}
                <div className={`cmd-item${i === at ? ' on' : ''}`} onMouseEnter={() => setAt(i)} onClick={c.run}>
                  <span className="grow">{c.title}</span>
                  {c.hint && <span className="muted">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmd-foot muted">↑↓ 고르기 · Enter 실행 · Esc 닫기</div>
      </div>
    </div>
  );
}
