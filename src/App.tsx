import { useEffect, useState } from 'react';
import { advanceRun, createRun, readRuns, stages, storageKey, type Run } from './factory';

const examples = [
  { icon: '◈', title: '팀을 위한 업무 관리', prompt: '작은 팀을 위한 업무 관리 앱을 만들어 주세요. 작업 생성, 담당자 지정, 상태별 보드와 마감일 알림이 필요합니다.' },
  { icon: '▤', title: '고객 문의 대시보드', prompt: '고객 문의를 한곳에서 관리하는 대시보드를 만들어 주세요. 문의 검색, 우선순위 지정, 답변 상태 필터가 필요합니다.' },
  { icon: '↗', title: '아이디어 검증용 랜딩 페이지', prompt: '새로운 서비스의 랜딩 페이지를 만들어 주세요. 서비스 소개, 주요 기능, 요금 비교와 사전 신청 폼이 필요합니다.' },
];
const statusText = { running: '데모 진행 중', review: '검토 대기', cancelled: '취소됨' };

export default function App() {
  const [runs, setRuns] = useState<Run[]>(() => { try { return readRuns(localStorage.getItem(storageKey)); } catch { return []; } });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'create' | 'history'>('create');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const selected = runs.find(run => run.id === selectedId);
  const runningCount = runs.filter(run => run.status === 'running').length;

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(runs)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [runs]);

  useEffect(() => {
    if (!runningCount) return;
    const timer = window.setInterval(() => setRuns(current => current.map(advanceRun)), 1800);
    return () => window.clearInterval(timer);
  }, [runningCount]);

  function start() {
    try {
      const run = createRun(prompt);
      if (runningCount >= 3) { setError('동시에 진행할 수 있는 데모 작업은 3개입니다. 기존 작업 완료 후 다시 시작해 주세요.'); return; }
      setRuns(current => [run, ...current].slice(0, 20));
      setSelectedId(run.id); setPrompt(''); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '작업을 시작하지 못했습니다.'); }
  }

  function newWork() { setSelectedId(null); setView('create'); setError(''); }

  function download(run: Run) {
    const content = `# ArkWork 데모 작업\n\n> 실제 코드 생성, 테스트 또는 PR 생성은 실행되지 않았습니다.\n\n## 요구사항\n${run.prompt}\n\n## 상태\n${statusText[run.status]}\n\n## 다음 단계\n- 요구사항의 수용 기준 정의\n- 저장소와 실행 환경 연결\n- AI 실행 및 실제 검증 연결\n- 변경 내용을 PR로 검토\n`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `arkwork-${run.id.slice(0, 8)}.md`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={newWork} aria-label="ArkWork 홈"><span className="brand-mark">A</span>ArkWork<span className="beta">BETA</span></button>
      <div className="workspace"><span className="workspace-icon">W</span><div><strong>내 워크스페이스</strong><small>Personal workspace</small></div></div>
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="주 메뉴">
        <button className={view === 'create' && !selected ? 'nav-item active' : 'nav-item'} onClick={newWork}><span>＋</span>새 작업</button>
        <button className={view === 'history' || selected ? 'nav-item active' : 'nav-item'} onClick={() => { setView('history'); setSelectedId(null); }}><span>▤</span>작업 기록<span className="count">{runs.length}</span></button>
      </nav>
      <p className="nav-label recent-label">RECENT WORK</p>
      <div className="recent-list">{runs.slice(0, 5).map(run => <button key={run.id} onClick={() => { setSelectedId(run.id); setView('history'); }}><span className={`dot ${run.status}`} /><span>{run.prompt}</span></button>)}{!runs.length && <p className="muted small">첫 작업을 시작해 보세요.</p>}</div>
      <div className="sidebar-bottom"><div className="demo-indicator"><span className="dot review" />UI 데모 환경</div><p>실제 AI 실행은 아직 연결되지 않았습니다.</p><div className="profile"><span className="avatar">Y</span><div><strong>내 계정</strong><small>로컬 데모</small></div></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div><span className="muted">워크스페이스</span><span className="slash">/</span>{selected ? '작업 상세' : view === 'history' ? '작업 기록' : '새 작업'}</div><span className="demo-badge">DEMO MODE</span></header>
      <main>
        {storageError && <p className="notice" role="alert">브라우저 저장 공간을 사용할 수 없습니다. 현재 작업은 새로고침하면 사라질 수 있습니다.</p>}
        {!selected && view === 'create' && <>
          <div className="hero"><span className="eyebrow"><span className="spark">✦</span> YOUR SOFTWARE FACTORY</span><h1>아이디어를 건네세요.<br /><span>만드는 과정은 ArkWork에.</span></h1><p>무엇을 만들고 싶은지 설명해 주세요.<br />요구사항부터 결과 검토까지, 하나의 작업으로 이어집니다.</p></div>
          <form className="composer" onSubmit={event => { event.preventDefault(); start(); }}>
            <label htmlFor="requirements">어떤 소프트웨어를 만들까요?</label>
            <textarea id="requirements" value={prompt} onChange={event => { setPrompt(event.target.value); setError(''); }} maxLength={2000} placeholder="예: 작은 팀을 위한 업무 관리 앱을 만들어 주세요. 담당자를 지정하고, 작업 상태를 보드에서 관리하고 싶어요." aria-describedby="input-help input-error" />
            <div className="composer-footer"><span id="input-help"><span className="tiny-square">▧</span> 데모 워크플로 · 실제 코드 생성 없음</span><div><span className="char-count">{prompt.length}/2,000</span><button className="primary" type="submit">데모 작업 시작 <span>↗</span></button></div></div>
            {error && <p id="input-error" className="error" role="alert">{error}</p>}
          </form>
          <section className="examples"><div className="section-heading"><h2>이런 작업부터 시작해 보세요</h2><span>선택하면 요구사항이 입력됩니다</span></div><div className="example-grid">{examples.map(example => <button className="example-card" key={example.title} onClick={() => { setPrompt(example.prompt); document.getElementById('requirements')?.focus(); }}><span className="example-icon">{example.icon}</span><strong>{example.title}</strong><p>{example.prompt}</p><span className="card-arrow">↗</span></button>)}</div></section>
          <section className="flow"><div><span className="eyebrow">FROM IDEA TO REVIEW</span><h2>한 번의 요청, 연결된 과정</h2></div><ol>{stages.map((stage, index) => <li key={stage}><span>{String(index + 1).padStart(2, '0')}</span>{stage}</li>)}</ol><p>현재는 진행 흐름을 시뮬레이션합니다. AI 실행과 저장소 연결은 다음 단계에서 제공합니다.</p></section>
        </>}
        {!selected && view === 'history' && <section className="history"><span className="eyebrow">WORK HISTORY</span><h1>작업 기록</h1><p className="muted">최근 20개 작업을 이 브라우저에 저장합니다.</p>{!runs.length ? <div className="empty"><span>▤</span><h2>아직 작업이 없습니다</h2><p>아이디어를 입력해 첫 데모 작업을 시작하세요.</p><button className="primary" onClick={newWork}>새 작업 시작</button></div> : <div className="history-list">{runs.map(run => <button key={run.id} onClick={() => setSelectedId(run.id)}><div><strong>{run.prompt}</strong><small>{new Date(run.createdAt).toLocaleString('ko-KR')}</small></div><span className={`status ${run.status}`}>{statusText[run.status]}</span><span>→</span></button>)}</div>}</section>}
        {selected && <section className="detail"><button className="back" onClick={() => { setSelectedId(null); setView('history'); }}>← 작업 기록</button><div className="detail-heading"><div><span className="eyebrow">WORK / {selected.id.slice(0, 8)}</span><h1>{selected.status === 'review' ? '결과를 검토할 차례입니다' : selected.status === 'cancelled' ? '작업이 취소되었습니다' : '아이디어를 구체화하고 있습니다'}</h1></div><span className={`status ${selected.status}`}>{statusText[selected.status]}</span></div><p className="notice">데모 시뮬레이션입니다. 실제 AI 호출, 코드 생성, 테스트 및 PR 생성은 수행하지 않습니다.</p><div className="detail-grid"><div className="panel"><h2>요구사항</h2><p className="requirement-text">{selected.prompt}</p><small className="muted">{new Date(selected.createdAt).toLocaleString('ko-KR')}</small></div><div className="panel"><h2>진행 과정</h2><ol className="timeline">{stages.map((stage, index) => <li key={stage} className={index < selected.stage ? 'done' : index === selected.stage ? 'current' : ''}><span>{index < selected.stage ? '✓' : index + 1}</span><div><strong>{stage}</strong><small>{index < selected.stage ? '데모 단계 완료' : index === selected.stage ? selected.status === 'review' ? '사용자 검토 대기' : selected.status === 'cancelled' ? '진행 중단' : '데모 단계 진행 중' : '대기 중'}</small></div></li>)}</ol></div></div>
          <div aria-live="polite" className="progress-message">{selected.status === 'running' ? `현재 단계: ${stages[selected.stage]}. 잠시 후 다음 데모 단계로 이동합니다.` : selected.status === 'review' ? '데모 진행이 완료되었습니다. 아래에서 작업 요약을 확인하세요.' : '이 작업은 더 이상 진행되지 않습니다.'}</div>
          {selected.status === 'review' && <div className="panel result"><span className="eyebrow">REVIEW HANDOFF</span><h2>실제 구현 전에 확인할 항목</h2><p>입력한 요구사항은 저장되었습니다. 다음 항목은 실제 Software Factory 연결을 위한 검토 목록입니다.</p><ul><li>사용자와 핵심 사용 시나리오 정의</li><li>기능별 완료 조건과 테스트 기준 합의</li><li>저장소, 실행 환경 및 AI 제공자 연결</li><li>구현 결과를 별도 브랜치와 PR로 검토</li></ul><button className="primary" onClick={() => download(selected)}>작업 요약 다운로드 ↓</button><span className="download-note">Markdown · 데모 표시 포함</span></div>}
          <div className="detail-actions">{selected.status === 'running' && <button className="secondary" onClick={() => setRuns(current => current.map(run => run.id === selected.id ? { ...run, status: 'cancelled' } : run))}>데모 작업 취소</button>}<button className="secondary" onClick={newWork}>새 작업 만들기 ＋</button></div>
        </section>}
        <footer>ArkWork<span>아이디어에서 소프트웨어까지.</span></footer>
      </main>
    </div>
  </div>;
}
