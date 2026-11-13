import { useCallback, useEffect, useRef, useState } from 'react';
import type { DbAccess, DbColumn, DbConnection, DbKind, DbResult, DbTable, Workspace } from '@shared/types';
import { ACCESS_HELP, ACCESS_LABEL, cellText, DEFAULT_PORT, emptyForm, formOf, formProblem, KIND_LABEL, previewSql, QUERY_HINT, QUERY_PLACEHOLDER, toInput, type DbForm } from '../dbView';
import { DbRequests } from './DbRequests';

/** 연결을 등록하거나 고치는 창. */
function ConnectionDialog({ projectId, editing, onClose }: { projectId: string; editing: DbConnection | null; onClose: (saved: DbConnection | null) => void }) {
  const [f, setF] = useState<DbForm>(() => (editing ? formOf(editing) : emptyForm()));
  const [clearPassword, setClearPassword] = useState(false);
  const [canStore, setCanStore] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.dure.db.canStoreSecrets().then(setCanStore).catch(() => undefined); }, []);
  const set = (p: Partial<DbForm>): void => setF((x) => ({ ...x, ...p }));
  const problem = formProblem(f);
  const save = async (): Promise<void> => {
    setBusy(true); setError('');
    try { onClose(await window.dure.db.save(toInput(f, projectId, editing, clearPassword))); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="backdrop">
      <div className="dialog wide">
        <h3>{editing ? `DB 연결 고치기: ${editing.name}` : 'DB 연결 등록'}</h3>
        <div className="db-note">두레는 이 연결로 <b>조회만</b> 합니다. 쓰기와 스키마 변경은 실행되지 않습니다. 그래도 읽기 전용 계정을 쓰는 것이 안전합니다.</div>
        {error && <div className="error">{error}</div>}
        <div className="db-grid">
          <div className="field"><label>연결 이름</label><input type="text" autoFocus value={f.name} placeholder="예: 로컬 개발 DB" onChange={(e) => set({ name: e.target.value })} /><div className="hint">에이전트는 이 이름으로 연결을 가리킵니다</div></div>
          <div className="field"><label>종류</label>
            <select value={f.kind} onChange={(e) => { const kind = e.target.value as DbKind; set({ kind, port: f.port === String(DEFAULT_PORT[f.kind]) ? String(DEFAULT_PORT[kind]) : f.port }); }}>
              <option value="postgres">{KIND_LABEL.postgres}</option><option value="mysql">{KIND_LABEL.mysql}</option><option value="oracle">{KIND_LABEL.oracle}</option><option value="mongo">{KIND_LABEL.mongo}</option>
            </select>
          </div>
          {f.kind === 'mongo' ? (
            <>
              <div className="field db-wide"><label>연결 문자열</label>
                <input type="password" value={f.password} placeholder={editing?.hasPassword && editing.kind === 'mongo' ? '저장된 연결 문자열을 그대로 씁니다. 바꾸려면 새로 적으세요' : 'mongodb://사용자:비밀번호@호스트:27017/DB이름  또는  mongodb+srv://…'} onChange={(e) => set({ password: e.target.value })} />
                <div className="hint">비밀번호가 들어 있어 통째로 암호화해 저장합니다. 화면에도 에이전트에게도 다시 보이지 않습니다. 읽기만 할 수 있는 계정을 쓰세요.</div>
              </div>
              <div className="field"><label>데이터베이스 (연결 문자열에 있으면 비워도 됩니다)</label><input type="text" value={f.database} onChange={(e) => set({ database: e.target.value })} /></div>
            </>
          ) : (
            <>
          <div className="field"><label>호스트</label><input type="text" value={f.host} onChange={(e) => set({ host: e.target.value })} /></div>
          <div className="field"><label>포트</label><input type="text" value={f.port} onChange={(e) => set({ port: e.target.value })} /></div>
          <div className="field"><label>{f.kind === 'oracle' ? '서비스 이름' : '데이터베이스'}{f.kind === 'mysql' && ' (비워도 됩니다)'}</label><input type="text" value={f.database} onChange={(e) => set({ database: e.target.value })} /></div>
          <div className="field"><label>사용자</label><input type="text" value={f.user} onChange={(e) => set({ user: e.target.value })} /></div>
          <div className="field db-wide"><label>비밀번호</label>
            <input type="password" value={f.password} disabled={clearPassword} placeholder={editing?.hasPassword ? '저장된 비밀번호를 그대로 씁니다. 바꾸려면 새로 적으세요' : ''} onChange={(e) => set({ password: e.target.value })} />
            <div className="hint">{canStore ? 'macOS 키체인의 열쇠로 암호화해 저장합니다. 화면에도 에이전트에게도 다시 보이지 않습니다. (에이전트가 조회로 알아낼 수 있는 것, 예를 들어 접속한 사용자 이름은 막지 못합니다.)' : '이 환경에서는 비밀번호를 안전하게 저장할 수 없습니다. 비밀번호 없는 연결만 등록할 수 있습니다.'}</div>
            {editing?.hasPassword && <label className="check"><input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> 저장된 비밀번호 지우기</label>}
          </div>
          <label className="check db-wide"><input type="checkbox" checked={f.ssl} onChange={(e) => set({ ssl: e.target.checked })} /> SSL 로 접속 <span className="muted">(서버 인증서는 확인하지 않습니다)</span></label>
            </>
          )}
          <div className="field db-wide"><label>에이전트가 이 연결을 쓰는 방식</label>
            <select value={f.agentAccess} onChange={(e) => set({ agentAccess: e.target.value as DbAccess })}>
              {(['ask', 'auto', 'off'] as DbAccess[]).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
            </select>
            <div className="hint">{ACCESS_HELP[f.agentAccess]} 조회 결과는 에이전트의 대화에 들어가 모델 제공사로 전송됩니다.</div>
          </div>
        </div>
        <div className="dialog-actions">
          {problem && <span className="muted" style={{ marginRight: 'auto' }}>{problem}</span>}
          <button className="btn ghost" disabled={busy} onClick={() => onClose(null)}>취소</button>
          <button className="btn primary" disabled={busy || problem !== null} onClick={() => void save()}>{editing ? '저장' : '등록'}</button>
        </div>
      </div>
    </div>
  );
}

/** 고른 연결: 표 목록, 스키마, 조회. */
function Browser({ conn }: { conn: DbConnection }) {
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [tablesError, setTablesError] = useState('');
  const [picked, setPicked] = useState<DbTable | null>(null);
  const [columns, setColumns] = useState<DbColumn[] | null>(null);
  const [filter, setFilter] = useState('');
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<DbResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  // Oracle: 볼 계정(스키마). 비우면 내 것과 다른 계정 것을 함께 받는다 (큰 DB 에서는 느릴 수 있다).
  const [schema, setSchema] = useState('');
  const [schemas, setSchemas] = useState<string[]>([]);
  useEffect(() => {
    setSchema(''); setSchemas([]);
    if (conn.kind === 'oracle') window.dure.db.schemas(conn.id).then(setSchemas).catch(() => setSchemas([]));
  }, [conn.id, conn.kind]);
  const tablesSeq = useRef(0);
  const loadTables = useCallback(() => {
    setTables(null); setTablesError('');
    const seq = ++tablesSeq.current;
    window.dure.db.tables(conn.id, schema || undefined)
      .then((t) => { if (seq === tablesSeq.current) setTables(t); })
      .catch((e: Error) => { if (seq === tablesSeq.current) setTablesError(e.message); });
  }, [conn.id, schema]);
  useEffect(() => { loadTables(); }, [loadTables]);

  const [columnsError, setColumnsError] = useState('');
  const pickSeq = useRef(0);
  const pick = (t: DbTable): void => {
    setPicked(t); setColumns(null); setColumnsError('');
    // 표를 빠르게 바꿔 누르면 늦게 온 앞 표의 칸이 덮지 않게 한다.
    const seq = ++pickSeq.current;
    // 직접 고친 문장은 그대로 두고, 비었거나 앞에서 넣어 준 본보기일 때만 바꾼다.
    if (!sql.trim() || /^SELECT \* FROM .* (LIMIT 100|WHERE ROWNUM <= 100)$/.test(sql.trim()) || /^\{"collection":"[^"]*","op":"find","filter":\{\},"limit":100\}$/.test(sql.trim())) setSql(previewSql(conn.kind, t));
    window.dure.db.columns(conn.id, t.schema, t.name).then((c) => { if (seq === pickSeq.current) setColumns(c); }).catch((e: Error) => { if (seq === pickSeq.current) setColumnsError(e.message); });
  };
  const run = (): void => {
    if (!sql.trim() || running) return;
    setRunning(true); setError('');
    window.dure.db.query(conn.id, sql).then(setResult).catch((e: Error) => { setError(e.message); setResult(null); }).finally(() => setRunning(false));
  };
  const shown = (tables ?? []).filter((t) => !filter.trim() || `${t.schema}.${t.name}`.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="db-browser">
      <div className="db-tables">
        <div className="db-tables-head">
          <input type="text" value={filter} placeholder="표 찾기" onChange={(e) => setFilter(e.target.value)} />
          <button className="btn ghost" title="표 목록을 다시 읽습니다" onClick={loadTables}>새로 고침</button>
        </div>
        {conn.kind === 'oracle' && schemas.length > 0 && (
          <div className="db-tables-head">
            <select value={schema} title="볼 계정(스키마)을 고릅니다" onChange={(e) => { setSchema(e.target.value); setPicked(null); setColumns(null); }}>
              <option value="">내 계정 + 다른 계정 전부</option>
              {schemas.map((x) => <option key={x} value={x}>{x}{x.toUpperCase() === conn.user.toUpperCase() ? ' (내 계정)' : ''}</option>)}
            </select>
          </div>
        )}
        <div className="db-tables-list">
          {tablesError && <div className="error">{tablesError}</div>}
          {!tables && !tablesError && <div className="muted">표 목록을 읽는 중…</div>}
          {tables && shown.length === 0 && <div className="muted">{tables.length === 0 ? '표가 없습니다.' : '찾는 표가 없습니다.'}</div>}
          {shown.map((t) => (
            <button key={`${t.schema}.${t.name}`} className={`db-table${picked?.schema === t.schema && picked.name === t.name ? ' on' : ''}`} title="누르면 스키마를 보고, 조회 칸에 문장을 넣습니다" onClick={() => pick(t)}>
              <span className="db-table-name">{(conn.kind === 'postgres' && t.schema !== 'public') || (conn.kind === 'oracle' && t.schema.toUpperCase() !== conn.user.toUpperCase()) ? `${t.schema}.` : ''}{t.name}</span>
              {t.type === 'view' && <span className="tag">뷰</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="db-main">
        {picked && (
          <div className="db-columns">
            <div className="db-sub">{picked.name} 의 칸 {columns && <span className="count">{columns.length}</span>}</div>
            {columnsError ? <div className="error">{columnsError}</div> : !columns ? <div className="muted">읽는 중…</div> : (
              <div className="db-scroll">
                <table className="db-grid-table">
                  <thead><tr><th>이름</th><th>형식</th><th>NULL</th><th>기본값</th><th>키</th></tr></thead>
                  <tbody>{columns.map((c) => <tr key={c.name}><td>{c.name}</td><td>{c.type}</td><td>{c.nullable ? '허용' : ''}</td><td>{c.default ?? ''}</td><td>{c.key}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div className="db-query">
          <div className="db-sub">조회 <span className="plan-hint">{QUERY_HINT[conn.kind]}</span></div>
          <textarea value={sql} spellCheck={false} placeholder={QUERY_PLACEHOLDER[conn.kind]} onChange={(e) => setSql(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }} />
          <div className="db-query-actions">
            <button className="btn primary" disabled={running || !sql.trim()} onClick={run}>{running ? '조회하는 중…' : '조회 (⌘Enter)'}</button>
            {result && <span className="muted">{result.rows.length}행 · {result.ms}ms{result.truncated && ' · 1000행에서 잘렸습니다'}</span>}
          </div>
          {error && <div className="error">{error}</div>}
          {result && (
            <div className="db-scroll db-result">
              <table className="db-grid-table">
                <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>
                  {result.rows.map((r, i) => <tr key={i}>{r.map((v, k) => <td key={k} className={v === null ? 'null' : ''} title={cellText(v)}>{cellText(v)}</td>)}</tr>)}
                  {result.rows.length === 0 && <tr><td colSpan={Math.max(1, result.columns.length)} className="null">결과가 없습니다</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 프로젝트의 "DB" 탭. 연결을 등록하고, 표와 스키마를 보고, 조회한다. 에이전트의 조회 요청도 여기서 결정할 수 있다. */
export function DbPanel({ projectId, workspaces, readOnly }: { projectId: string; workspaces: Workspace[]; readOnly: boolean }) {
  const [conns, setConns] = useState<DbConnection[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing: DbConnection | null } | null>(null);
  const [removing, setRemoving] = useState<DbConnection | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const load = useCallback(() => {
    window.dure.db.list(projectId).then(setConns).catch((e: Error) => setError(e.message));
  }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'db') load(); });
  }, [load]);

  const active = conns?.find((c) => c.id === activeId) ?? conns?.[0] ?? null;
  const test = (c: DbConnection): void => {
    setTested((t) => ({ ...t, [c.id]: '확인하는 중…' }));
    window.dure.db.test(c.id).then((r) => setTested((t) => ({ ...t, [c.id]: `접속됨 (${r.ms}ms)` }))).catch((e: Error) => setTested((t) => ({ ...t, [c.id]: `접속 실패: ${e.message}` })));
  };

  return (
    <div className="page db-page">
      {!readOnly && <DbRequests projectId={projectId} workspaces={workspaces} />}
      {error && <div className="error">{error}</div>}
      <div className="section">
        <div className="section-head">
          <h2>DB 연결 <span className="plan-hint">이 프로젝트의 모든 워크스페이스가 같이 씁니다. 조회 전용입니다</span></h2>
          {!readOnly && <button className="btn" onClick={() => setDialog({ editing: null })}>연결 등록</button>}
        </div>
        <div className="rows">
          {conns && conns.length === 0 && <div className="rows-empty">등록된 DB 연결이 없습니다. 연결을 등록하면 여기서 표와 데이터를 보고, 에이전트도 두레를 통해 조회할 수 있습니다. 에이전트에게 비밀번호는 넘어가지 않습니다.</div>}
          {(conns ?? []).map((c) => (
            <div key={c.id} className={`row db-conn${active?.id === c.id ? ' on' : ''}`} onClick={() => setActiveId(c.id)}>
              <div className="grow">
                <div>{c.name} <span className="tag">{KIND_LABEL[c.kind]}</span> <span className={`tag${c.agentAccess === 'auto' ? ' warn' : ''}`} title={ACCESS_HELP[c.agentAccess]}>에이전트: {ACCESS_LABEL[c.agentAccess]}</span></div>
                <div className="path">{c.user ? `${c.user}@` : ''}{c.host}{c.kind === 'mongo' && c.port === 27017 ? '' : `:${c.port}`}{c.database && `/${c.database}`}{c.ssl && ' · SSL'}{!c.hasPassword && c.kind !== 'mongo' && ' · 비밀번호 없음'}</div>
                {tested[c.id] && <div className={`db-tested${tested[c.id]!.startsWith('접속 실패') ? ' bad' : ''}`}>{tested[c.id]}</div>}
                {c.warnings && c.warnings.length > 0 && (
                  <div className="db-warn">읽기 전용 계정이 아닙니다: {c.warnings.join(' · ')}. 두레는 조회만 실행하지만, 이런 계정은 조회 문장으로도 할 수 있는 일이 있습니다. 에이전트의 조회는 "바로 조회" 로 두어도 매번 승인을 받습니다. 읽기 전용 계정으로 바꾸는 것을 권합니다.</div>
                )}
                {c.warnings && c.warnings.length === 0 && <div className="db-tested">계정 권한 확인됨: 조회 말고 눈에 띄는 권한이 없습니다</div>}
              </div>
              <button className="btn ghost" onClick={(e) => { e.stopPropagation(); test(c); }}>접속 확인</button>
              {!readOnly && <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setDialog({ editing: c }); }}>고치기</button>}
              {!readOnly && <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setRemoving(c); }}>지우기</button>}
            </div>
          ))}
        </div>
      </div>
      {active && <Browser key={active.id} conn={active} />}
      {dialog && <ConnectionDialog projectId={projectId} editing={dialog.editing} onClose={(saved) => { setDialog(null); if (saved) { setActiveId(saved.id); load(); test(saved); } }} />}
      {removing && (
        <div className="backdrop">
          <div className="dialog">
            <h3>DB 연결 지우기</h3>
            <div>"{removing.name}" 연결을 지웁니다. 저장된 비밀번호도 함께 지워집니다. DB 자체에는 아무 일도 일어나지 않습니다.</div>
            <div className="dialog-actions">
              <button className="btn ghost" onClick={() => setRemoving(null)}>취소</button>
              <button className="btn danger" onClick={() => { window.dure.db.remove(removing.id).catch((e: Error) => setError(e.message)).finally(() => { setRemoving(null); load(); }); }}>지우기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
