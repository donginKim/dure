import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ClaudeEffort, ModelChoice, Settings } from '@shared/types';
import { BYPASS_WARNING } from './dialogs';
import { SlackSettings } from './SlackSettings';
import { UpdateSettings } from './UpdateNotice';

type Key = keyof Settings;

import { isClaudeModel } from '../settingsView';

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<string, string> = { low: '낮음 (low)', medium: '보통 (medium)', high: '높음 (high)', xhigh: '매우 높음 (xhigh)', max: '최대 (max)' };

/** 설정 한 줄: 이름, 설명, 값, 그리고 기본값과 다를 때의 "기본값으로". */
function Row({ label, help, changed, error, onReset, children }: {
  label: string; help?: ReactNode; changed: boolean; error?: string; onReset: () => void; children: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">{label}{changed && <span className="set-changed" title="기본값과 다릅니다">바꿈</span>}</div>
        {help && <div className="set-help">{help}</div>}
        {error && <div className="set-error">{error}</div>}
      </div>
      <div className="set-control">
        {children}
        {changed && <button className="btn ghost set-reset" onClick={onReset}>기본값으로</button>}
      </div>
    </div>
  );
}

/** 글자·숫자 입력: 치는 동안은 저장하지 않고, 칸을 벗어나거나 Enter 를 누르면 저장한다. */
function TextInput({ value, placeholder, wide, numeric, onCommit }: {
  value: string; placeholder?: string; wide?: boolean; numeric?: boolean; onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = (): void => { if (draft !== value) onCommit(draft); };
  return (
    <input
      type="text" className={`set-input${wide ? ' wide' : ''}${numeric ? ' num' : ''}`} value={draft} placeholder={placeholder} inputMode={numeric ? 'decimal' : undefined}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(value); }}
    />
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`set-toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span className="knob" />
      <span className="set-toggle-text">{on ? '켬' : '끔'}</span>
    </button>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="view-switch" role="radiogroup">
      {options.map((o) => <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

/** 두레의 설정 화면. 바꾸면 바로 저장된다. */
export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaults, setDefaults] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [saved, setSaved] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');

  // 모델 목록: 받아 둔 것이 있으면 곧바로 오고, 없으면 Claude Code 에게 물어 오느라 몇 초 걸린다.
  const loadModels = useCallback((refresh = false) => {
    setModelsLoading(true);
    setModelsError('');
    window.dure.settings.models(refresh)
      .then((m) => setModels(m))
      .catch((e: Error) => setModelsError(e.message))
      .finally(() => setModelsLoading(false));
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([window.dure.settings.get(), window.dure.settings.defaults()]).then(([s, d]) => {
      if (!alive) return;
      setSettings(s); setDefaults(d);
    });
    loadModels();
    const off = window.dure.onChanged((topic) => {
      if (topic === 'settings') void window.dure.settings.get().then((s) => { if (alive) setSettings(s); });
    });
    return () => { alive = false; off(); };
  }, [loadModels]);

  const save = useCallback(<K extends Key>(key: K, value: Settings[K]) => {
    window.dure.settings.update({ [key]: value } as Partial<Settings>).then((s) => {
      setSettings(s);
      setErrors((e) => ({ ...e, [key]: undefined }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }).catch((e: Error) => setErrors((prev) => ({ ...prev, [key]: e.message })));
  }, []);

  if (!settings || !defaults) return <div className="page"><h1>설정</h1></div>;
  const s = settings;
  const row = (key: Key): { changed: boolean; error?: string; onReset: () => void } => ({
    changed: s[key] !== defaults[key], error: errors[key], onReset: () => save(key, defaults[key]),
  });
  const number = (key: 'threadCap' | 'projectCap' | 'terminalFontSize' | 'chatFontSize' | 'peerPort') => (v: string): void => {
    const n = Number(v.trim());
    if (!v.trim() || Number.isNaN(n)) { setErrors((e) => ({ ...e, [key]: '숫자를 쓰세요.' })); return; }
    save(key, n);
  };
  const pick = (key: 'worktreeRoot' | 'repoRoot') => (): void => { void window.dure.settings.pickFolder().then((p) => { if (p) save(key, p); }); };
  const modelKnown = !s.claudeModel || models.some((m) => m.value === s.claudeModel);
  const listed = models.filter((m) => m.value !== 'default');
  const claudeModels = listed.filter(isClaudeModel);
  const otherModels = listed.filter((m) => !isClaudeModel(m));
  const modelOption = (m: ModelChoice): ReactNode => <option key={m.value} value={m.value}>{m.name}{m.description ? ` — ${m.description}` : ''}</option>;
  // 고른 모델이 받는 단계만 보인다. 모델을 고르지 않았거나 목록이 없으면 전부 보인다.
  const chosen = models.find((m) => m.value === (s.claudeModel || 'default'));
  const efforts = chosen ? ALL_EFFORTS.filter((e) => chosen.efforts.includes(e)) : ALL_EFFORTS;
  const effortUnsupported = s.claudeEffort !== '' && !efforts.includes(s.claudeEffort);

  return (
    <div className="page settings">
      <h1>설정</h1>
      <div className="sub">두레 전체에 적용됩니다. 바꾸면 바로 저장됩니다.{saved && <span className="set-saved">저장됨</span>}</div>

      <div className="section">
        <div className="section-head"><h2>새 워크스페이스</h2></div>
        <div className="set-box">
          <Row label="기본 에이전트" help="워크스페이스를 만들 때 처음 골라져 있는 에이전트입니다." {...row('defaultAgent')}>
            <Choice value={s.defaultAgent} onChange={(v) => save('defaultAgent', v)} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
          </Row>
          <Row
            label="기본 방식" {...row('defaultEngine')}
            help="채팅: 에이전트가 터미널 화면 없이 돌고, 글이 실시간으로 흐르고, 승인과 질문이 버튼으로 옵니다. 터미널: Claude Code 를 터미널에서 그대로 띄웁니다. Codex 는 터미널만 됩니다. 이미 만든 워크스페이스는 에이전트를 끈 뒤 워크스페이스 머리에서 바꿀 수 있습니다."
          >
            <Choice value={s.defaultEngine} onChange={(v) => save('defaultEngine', v)} options={[{ value: 'chat', label: '채팅' }, { value: 'terminal', label: '터미널' }]} />
          </Row>
          <Row
            label="기본 권한 모드" {...row('defaultPermissionMode')}
            help={s.defaultPermissionMode === 'bypass' ? <span className="set-warn">{BYPASS_WARNING}</span> : '승인 필요: 파일 수정은 자동 승인, 명령 실행은 승인을 거칩니다.'}
          >
            <Choice value={s.defaultPermissionMode} onChange={(v) => save('defaultPermissionMode', v)} options={[{ value: 'ask', label: '승인 필요' }, { value: 'bypass', label: '승인 생략' }]} />
          </Row>
          <Row label="작업 폴더를 만드는 위치" help="워크스페이스의 작업 폴더(worktree)가 이 아래에 프로젝트 이름으로 만들어집니다. 비워 두면 기본 위치(~/dure/worktrees)입니다. 이미 만든 워크스페이스는 옮기지 않습니다." {...row('worktreeRoot')}>
            <TextInput wide value={s.worktreeRoot} placeholder="~/dure/worktrees" onCommit={(v) => save('worktreeRoot', v)} />
            <button className="btn" onClick={pick('worktreeRoot')}>고르기</button>
          </Row>
          <Row label="새 저장소를 만드는 위치" help="조율 에이전트의 계획안에 든 새 저장소가 이 아래에 프로젝트 이름으로 만들어집니다. 비워 두면 기본 위치(~/dure/repos)입니다. 이미 만든 저장소는 옮기지 않습니다." {...row('repoRoot')}>
            <TextInput wide value={s.repoRoot} placeholder="~/dure/repos" onCommit={(v) => save('repoRoot', v)} />
            <button className="btn" onClick={pick('repoRoot')}>고르기</button>
          </Row>
          <Row label="에이전트의 브라우저 사용" help="에이전트가 두레의 내장 브라우저로 자기가 만든 화면을 열어 확인할 수 있습니다. 로컬 주소(localhost, 127.0.0.1)와 아래에 적은 주소만 됩니다. '묻기' 로 두면 처음 여는 주소(호스트와 포트)마다 허용을 받습니다: 이 PC 에 떠 있는 다른 프로그램의 화면을 에이전트가 건드리지 않게 합니다. 에이전트가 본 페이지의 내용은 그 에이전트의 대화에 들어갑니다." {...row('agentBrowser')}>
            <select value={s.agentBrowser} onChange={(e) => save('agentBrowser', e.target.value as 'ask' | 'local' | 'off')}>
              <option value="ask">처음 여는 주소마다 묻기</option>
              <option value="local">묻지 않기 (로컬 주소와 허용한 주소)</option>
              <option value="off">쓰지 못하게</option>
            </select>
          </Row>
          <Row label="에이전트에게 허용할 바깥 주소" help="호스트 이름을 쉼표나 공백으로 나눠 적습니다 (예: staging.example.com). 하위 도메인도 함께 허용됩니다. 로그인된 사이트를 적으면 에이전트가 그 내용을 볼 수 있으니 필요한 것만 적으세요." {...row('agentBrowserHosts')}>
            <TextInput wide value={s.agentBrowserHosts} placeholder="비워 두면 로컬 주소만" onCommit={(v) => save('agentBrowserHosts', v)} />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Claude Code</h2></div>
        <div className="set-box">
          <Row
            label="모델" {...row('claudeModel')}
            error={errors.claudeModel ?? (modelsError ? `모델 목록을 받아오지 못했습니다: ${modelsError}` : undefined)}
            help='다음에 시작하는 에이전트부터 적용됩니다. "Claude Code 의 기본" 은 Claude Code 에 정해 둔 모델을 그대로 씁니다.'
          >
            <select className="set-select" value={s.claudeModel} disabled={modelsLoading && models.length === 0} onChange={(e) => save('claudeModel', e.target.value)}>
              <option value="">{modelsLoading && models.length === 0 ? '목록을 받아오는 중…' : 'Claude Code 의 기본'}</option>
              {/* Claude Code 가 알려 준 목록에는 연결된 다른 회사의 모델도 들어 있을 수 있다. 헷갈리지 않게 묶어 보인다 */}
              {claudeModels.length > 0 && <optgroup label="Claude">{claudeModels.map(modelOption)}</optgroup>}
              {otherModels.length > 0 && <optgroup label="그 밖의 모델 (이 PC 의 Claude Code 에 연결된 것)">{otherModels.map(modelOption)}</optgroup>}
              {/* 저장된 모델이 목록에 없으면(목록이 바뀜) 그대로 보여 준다 */}
              {!modelKnown && <option value={s.claudeModel}>{s.claudeModel}</option>}
            </select>
            <button className="btn ghost" disabled={modelsLoading} onClick={() => loadModels(true)} title="Claude Code 에게 목록을 다시 묻습니다">{modelsLoading ? '받는 중…' : '새로 고침'}</button>
          </Row>
          <Row
            label="effort (생각하는 정도)" {...row('claudeEffort')}
            help={effortUnsupported
              ? <span className="set-warn">고른 모델은 이 단계를 받지 않습니다. 다른 단계를 고르세요.</span>
              : '높을수록 더 깊이 생각하고 더 오래 걸립니다. 다음에 시작하는 에이전트부터 적용됩니다.'}
          >
            <select className="set-select" value={s.claudeEffort} onChange={(e) => save('claudeEffort', e.target.value as ClaudeEffort)}>
              <option value="">Claude Code 의 기본</option>
              {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
              {effortUnsupported && <option value={s.claudeEffort}>{EFFORT_LABEL[s.claudeEffort] ?? s.claudeEffort} (이 모델은 받지 않음)</option>}
            </select>
          </Row>
          <Row label="추가 인자" help="에이전트를 띄울 때 더 줄 인자입니다. 예: --add-dir /다른/폴더. 두레가 직접 정하는 것(권한 모드, 연결 설정, 입출력 방식, 모델, effort)은 넣을 수 없습니다." {...row('claudeArgs')}>
            <TextInput wide value={s.claudeArgs} placeholder="--add-dir /다른/폴더" onCommit={(v) => save('claudeArgs', v)} />
          </Row>
          <Row label="실행 파일" help="비워 두면 PATH 에서 claude 를 찾습니다." {...row('claudePath')}>
            <TextInput wide value={s.claudePath} placeholder="/전체/경로/claude" onCommit={(v) => save('claudePath', v)} />
          </Row>
          <Row label="폴더 신뢰 창에 대신 답하기" help='터미널 방식에서, 처음 보는 작업 폴더에서 Claude Code 가 묻는 "이 폴더를 신뢰하는가" 에 두레가 "신뢰함" 으로 답합니다. 채팅 방식에는 이 창이 없습니다.' {...row('autoTrust')}>
            <Toggle on={s.autoTrust} onChange={(v) => save('autoTrust', v)} label="폴더 신뢰 창에 대신 답하기" />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Codex</h2></div>
        <div className="set-box">
          <Row label="추가 인자" help="두레가 직접 정하는 것(샌드박스, 승인 방식, 설정 덮어쓰기)은 넣을 수 없습니다." {...row('codexArgs')}>
            <TextInput wide value={s.codexArgs} onCommit={(v) => save('codexArgs', v)} />
          </Row>
          <Row label="실행 파일" help="비워 두면 PATH 에서 codex 를 찾습니다." {...row('codexPath')}>
            <TextInput wide value={s.codexPath} placeholder="/전체/경로/codex" onCommit={(v) => save('codexPath', v)} />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>다른 사람과 연결</h2></div>
        <div className="set-box">
          <Row label="다른 사람과 연결" help="켜면 같은 네트워크(같은 사무실, 같은 VPN)의 다른 두레가 나를 찾고 연결을 요청할 수 있습니다. 연결은 내가 수락해야 되고, 내 워크스페이스는 공개하기 전에는 보이지 않습니다. 처음 켤 때 macOS 가 '들어오는 연결을 허용할지' 물을 수 있습니다." {...row('peersEnabled')}>
            <Toggle on={s.peersEnabled} onChange={(v) => save('peersEnabled', v)} label="다른 사람과 연결" />
          </Row>
          <Row label="내 이름" help="다른 사람에게 보이는 이름입니다. 비워 두면 이 PC 의 사용자 이름을 씁니다. 상대의 에이전트는 내 워크스페이스를 '워크스페이스@이 이름' 으로 가리킵니다." {...row('peerName')}>
            <TextInput value={s.peerName} placeholder="이 PC 의 사용자 이름" onCommit={(v) => save('peerName', v)} />
          </Row>
          <Row label="연결 포트" help="다른 두레의 연결을 받는 포트입니다. 다른 프로그램과 겹치면 바꾸세요. 주소로 직접 연결할 때 상대에게 이 번호를 알려 줍니다." {...row('peerPort')}>
            <TextInput numeric value={String(s.peerPort)} onCommit={number('peerPort')} />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>알림</h2></div>
        <div className="set-box">
          <Row label="macOS 알림" help='에이전트가 권한을 묻거나, 계획안이 승인을 기다리거나, 다른 사람이 메시지를 보냈을 때 macOS 알림으로 알려 줍니다. 두레를 보고 있을 때는 띄우지 않습니다. 꺼도 왼쪽 위의 "확인할 것" 과 Dock 아이콘의 숫자는 그대로 보입니다. 처음에는 macOS 가 알림을 허용할지 묻습니다.' {...row('notifications')}>
            <Toggle on={s.notifications} onChange={(v) => save('notifications', v)} label="macOS 알림" />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>근무시간</h2></div>
        <div className="set-box">
          <Row label="근무시간 재기" help='켜면 근무지의 와이파이에 붙어 있는 동안을 근무시간으로 재서 "근무시간" 달력에 적습니다. 두레가 켜져 있을 때만 잽니다. 기록은 이 PC 에만 남습니다.' {...row('workTimeEnabled')}>
            <Toggle on={s.workTimeEnabled} onChange={(v) => save('workTimeEnabled', v)} label="근무시간 재기" />
          </Row>
          <Row label="세는 방식" help='"출퇴근 기록" 은 근무지의 와이파이에 붙으면 그날의 출근을 적고, 퇴근은 "근무시간" 화면의 퇴근 단추를 눌러 적습니다. 시각은 30분 단위로 올려 적습니다 (09:14 출근 → 09:30, 15:20 퇴근 → 15:30). "붙어 있던 시간 그대로" 는 와이파이에 붙어 있던 시간을 분 단위로 세고, 끊기면 멈춥니다.' {...row('workTimeUnit')}>
            <select className="set-select" value={s.workTimeUnit} onChange={(e) => save('workTimeUnit', e.target.value as 'minute' | 'half')}>
              <option value="half">출퇴근 기록 (30분 단위, 퇴근은 단추로)</option>
              <option value="minute">붙어 있던 시간 그대로 (분 단위)</option>
            </select>
          </Row>
          <Row label="근무지의 와이파이 이름" help='이 이름의 와이파이에 붙으면 그때부터 셉니다 (대소문자는 가리지 않습니다). macOS 가 와이파이 이름을 알려 주지 않으면 이름으로는 알아볼 수 없습니다: 그때는 "근무시간" 화면에서 "지금 네트워크를 근무지로 기억" 을 누르세요.' {...row('workWifi')}>
            <TextInput value={s.workWifi} placeholder="와이파이 이름" onCommit={(v) => save('workWifi', v)} />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>메모</h2></div>
        <div className="set-box">
          <Row label="에이전트가 메모 읽기" help="켜면 에이전트가 내 메모장에서 메모를 찾아 읽을 수 있습니다 (읽기만 하고 고치지 못합니다). 모든 프로젝트의 에이전트가 모든 메모를 읽을 수 있으니, 비밀번호 같은 것을 메모에 적어 두었다면 켜지 마세요." {...row('notesForAgents')}>
            <Toggle on={s.notesForAgents} onChange={(v) => save('notesForAgents', v)} label="에이전트가 메모 읽기" />
          </Row>
          <Row label="에이전트가 메모 쓰기" help='켜면 에이전트에게 "이거 메모해 줘" 라고 시킬 수 있습니다. 에이전트는 새 메모를 만들거나 있는 메모의 끝에 덧붙이기만 합니다: 적힌 글을 고치거나 메모를 지우지 못합니다. 에이전트가 적은 글에는 어느 프로젝트의 어느 에이전트가 언제 적었는지 남습니다. 읽기를 꺼 두어도 쓰기만 켤 수 있습니다.' {...row('notesWriteForAgents')}>
            <Toggle on={s.notesWriteForAgents} onChange={(v) => save('notesWriteForAgents', v)} label="에이전트가 메모 쓰기" />
          </Row>
        </div>
      </div>

      <SlackSettings />
      <UpdateSettings />

      <div className="section">
        <div className="section-head"><h2>에이전트끼리의 대화</h2></div>
        <div className="set-box">
          <Row label="대화 하나의 상한" help="사람이 끼어들지 않고 에이전트끼리 한 대화에서 이만큼 주고받으면 전달을 멈추고 사용자에게 묻습니다. 다음 메시지부터 적용됩니다." {...row('threadCap')}>
            <TextInput numeric value={String(s.threadCap)} onCommit={number('threadCap')} /><span className="set-unit">번</span>
          </Row>
          <Row label="프로젝트 전체의 상한" help="프로젝트 안의 모든 대화를 합친 횟수입니다." {...row('projectCap')}>
            <TextInput numeric value={String(s.projectCap)} onCommit={number('projectCap')} /><span className="set-unit">번</span>
          </Row>
          <Row label="메시지가 오면 꺼진 에이전트를 띄우기" help="끄면, 꺼져 있는 워크스페이스에 온 메시지는 그 에이전트를 직접 시작할 때까지 기다립니다." {...row('autoStartOnMessage')}>
            <Toggle on={s.autoStartOnMessage} onChange={(v) => save('autoStartOnMessage', v)} label="메시지가 오면 꺼진 에이전트를 띄우기" />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>커밋</h2></div>
        <div className="set-box">
          <Row label="커밋·push 뒤 에이전트에게 알리기" help="커밋 창에서 커밋하거나 push 하면 켜져 있는 에이전트에게 알려, 관련 할 일을 정리하게 합니다." {...row('notifyAgentOnCommit')}>
            <Toggle on={s.notifyAgentOnCommit} onChange={(v) => save('notifyAgentOnCommit', v)} label="커밋·push 뒤 에이전트에게 알리기" />
          </Row>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>화면</h2></div>
        <div className="set-box">
          <Row label="채팅 글자 크기" {...row('chatFontSize')}>
            <TextInput numeric value={String(s.chatFontSize)} onCommit={number('chatFontSize')} /><span className="set-unit">px</span>
          </Row>
          <Row label="터미널 글자 크기" help="다음에 여는 터미널부터 적용됩니다." {...row('terminalFontSize')}>
            <TextInput numeric value={String(s.terminalFontSize)} onCommit={number('terminalFontSize')} /><span className="set-unit">px</span>
          </Row>
        </div>
      </div>

      <div className="set-foot">
        에이전트의 커밋·push 를 막는 것은 설정으로 풀 수 없습니다(커밋과 push 는 사용자가 합니다). DB 연결은 프로젝트마다 따로 정합니다.
      </div>
    </div>
  );
}
