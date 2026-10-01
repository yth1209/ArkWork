import { useEffect, useRef, useState } from "react";
import { HumanCheckpoint, HumanHistory } from "./HumanCheckpoint";
import { useFactory } from "./useFactory";
import type { Mode } from "./repositories";
import { stages, type Run } from "./factory";

const examples = [
  {
    icon: "◈",
    title: "팀을 위한 업무 관리",
    prompt:
      "작은 팀을 위한 업무 관리 앱을 만들어 주세요. 작업 생성, 담당자 지정, 상태별 보드와 마감일 알림이 필요합니다.",
  },
  {
    icon: "▤",
    title: "고객 문의 대시보드",
    prompt:
      "고객 문의를 한곳에서 관리하는 대시보드를 만들어 주세요. 문의 검색, 우선순위 지정, 답변 상태 필터가 필요합니다.",
  },
  {
    icon: "↗",
    title: "아이디어 검증용 랜딩 페이지",
    prompt:
      "새로운 서비스의 랜딩 페이지를 만들어 주세요. 서비스 소개, 주요 기능, 요금 비교와 사전 신청 폼이 필요합니다.",
  },
];
const demoStatusText = {
  running: "데모 진행 중",
  review: "검토 대기",
  cancelled: "취소됨",
  awaiting_approval: "실행 승인 대기",
  queued: "실행 큐 대기",
  cancelling: "중단 확인 중",
  failed: "실행 중단 · 확인 필요",
  awaiting_input: "답변 대기",
  awaiting_decision: "사용자 결정 대기",
  completed: "사용자 검토 완료",
};

export default function App() {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return sessionStorage.getItem("arkwork.mode") === "demo" ? "demo" : "api";
    } catch {
      return "api";
    }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"create" | "history">("create");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [approvalAccepted, setApprovalAccepted] = useState(false);
  const pending = useRef<{ prompt: string; key: string } | null>(null);
  const factory = useFactory(mode, selectedId);
  const { runs, issue, loading, maxLength } = factory;
  const selected = runs.find((run) => run.id === selectedId);
  const label = mode === "api" ? "서버 모의" : "데모";
  const statusText = {
    ...demoStatusText,
    running: mode === "api" ? "서버 모의 진행 중" : demoStatusText.running,
  };

  useEffect(() => {
    setApprovalAccepted(false);
  }, [selectedId, selected?.planHash]);
  const titles: Record<Run["status"], string> = {
    awaiting_approval: "계획을 확인하고 실행을 승인해 주세요",
    queued: "승인한 작업이 실행을 기다리고 있습니다",
    running: "아이디어를 구체화하고 있습니다",
    review: "결과를 검토할 차례입니다",
    cancelling: "실행 중단을 확인하고 있습니다",
    cancelled: "작업이 취소되었습니다",
    failed: "작업을 진행하지 못했습니다",
    awaiting_input: "요구사항에 대한 답변을 기다리고 있습니다",
    awaiting_decision: "결정이 필요해 진행을 멈췄습니다",
    completed: "검토를 마치고 작업을 완료했습니다",
  };

  function changeMode(next: Mode) {
    setMode(next);
    setSelectedId(null);
    setError("");
    pending.current = null;
    try {
      sessionStorage.setItem("arkwork.mode", next);
    } catch {
      /* Mode still works in memory. */
    }
  }

  async function start() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const value = prompt.trim();
      if (!pending.current || pending.current.prompt !== value)
        pending.current = { prompt: value, key: crypto.randomUUID() };
      const run = await factory.create(value, pending.current.key);
      setSelectedId(run.id);
      setPrompt("");
      setError("");
      pending.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "작업을 시작하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(run: Run) {
    if (actionPending) return;
    setActionPending(true);
    try {
      await factory.cancel(run);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "작업을 취소하지 못했습니다.");
    } finally {
      setActionPending(false);
    }
  }

  async function approve(run: Run) {
    if (!approvalAccepted || actionPending) return;
    setActionPending(true);
    try {
      await factory.approve(run);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "실행을 승인하지 못했습니다.");
    } finally {
      setActionPending(false);
    }
  }

  const responseRequest = useRef<{ signature: string; key: string } | null>(
    null,
  );
  async function respond(run: Run, action: string, text: string) {
    if (actionPending) return;
    setActionPending(true);
    const signature = JSON.stringify([run.id, run.version, action, text]);
    if (responseRequest.current?.signature !== signature)
      responseRequest.current = { signature, key: crypto.randomUUID() };
    try {
      await factory.respond(run, action, text, responseRequest.current.key);
      responseRequest.current = null;
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "응답을 저장하지 못했습니다.");
    } finally {
      setActionPending(false);
    }
  }

  function newWork() {
    setSelectedId(null);
    setView("create");
    setError("");
  }

  function download(run: Run) {
    const content = `# ArkWork ${label} 작업\n\n> 실제 코드 생성, 테스트 또는 PR 생성은 실행되지 않았습니다.\n\n## 요구사항\n${run.prompt}\n\n## 상태\n${statusText[run.status]}\n\n## 다음 단계\n- 요구사항의 수용 기준 정의\n- 저장소와 실행 환경 연결\n- AI 실행 및 실제 검증 연결\n- 변경 내용을 PR로 검토\n`;
    const humanContent = run.humanWorkflow
      ? `\n## 사용자 입력\n${run.clarification}\n\n## 수정 의견 · ${run.revision ?? 0}회차\n${run.feedback || "없음"}\n\n## 구현 전 결정\n${run.decision || "결정 대기"}\n\n## 답변과 결정 기록\n${(run.humanHistory ?? []).map((item) => `- ${item.at} · ${item.action}: ${item.text}`).join("\n")}\n`
      : "";
    const url = URL.createObjectURL(
      new Blob([content + humanContent], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `arkwork-${run.id.slice(0, 8)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={newWork} aria-label="ArkWork 홈">
          <span className="brand-mark">A</span>ArkWork
          <span className="beta">BETA</span>
        </button>
        <div className="workspace">
          <span className="workspace-icon">W</span>
          <div>
            <strong>내 워크스페이스</strong>
            <small>Personal workspace</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="주 메뉴">
          <button
            className={
              view === "create" && !selected ? "nav-item active" : "nav-item"
            }
            onClick={newWork}
          >
            <span>＋</span>새 작업
          </button>
          <button
            className={
              view === "history" || selected ? "nav-item active" : "nav-item"
            }
            onClick={() => {
              setView("history");
              setSelectedId(null);
            }}
          >
            <span>▤</span>작업 기록<span className="count">{runs.length}</span>
          </button>
        </nav>
        <p className="nav-label recent-label">RECENT WORK</p>
        <div className="recent-list">
          {runs.slice(0, 5).map((run) => (
            <button
              key={run.id}
              onClick={() => {
                setSelectedId(run.id);
                setView("history");
              }}
            >
              <span className={`dot ${run.status}`} />
              <span>{run.prompt}</span>
            </button>
          ))}
          {!runs.length && (
            <p className="muted small">첫 작업을 시작해 보세요.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="demo-indicator">
            <span className="dot review" />
            {mode === "api" ? "서버 모의 실행 환경" : "UI 데모 환경"}
          </div>
          <p>실제 AI 실행은 아직 연결되지 않았습니다.</p>
          <div className="profile">
            <span className="avatar">Y</span>
            <div>
              <strong>내 계정</strong>
              <small>
                {mode === "api" ? "개발 세션 · 운영 인증 아님" : "로컬 데모"}
              </small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="muted">워크스페이스</span>
            <span className="slash">/</span>
            {selected
              ? "작업 상세"
              : view === "history"
                ? "작업 기록"
                : "새 작업"}
          </div>
          <div className="mode-switch" aria-label="실행 모드">
            <button
              aria-pressed={mode === "demo"}
              onClick={() => changeMode("demo")}
              disabled={submitting || actionPending}
            >
              로컬 데모
            </button>
            <button
              aria-pressed={mode === "api"}
              onClick={() => changeMode("api")}
              disabled={submitting || actionPending}
            >
              서버 모의 실행
            </button>
          </div>
        </header>
        <main>
          {mode === "api" && (
            <p className="notice">
              로컬 개발 API · PostgreSQL 엔진에 기록 저장 · 서버 측 모의
              진행입니다. 실제 AI 실행과 운영용 인증은 아직 연결하지 않았습니다.
            </p>
          )}
          {issue && (
            <p className="notice" role="alert">
              {issue}
            </p>
          )}
          {loading && (
            <p className="muted" role="status">
              작업을 불러오고 있습니다…
            </p>
          )}
          {!selected && view === "create" && (
            <>
              <div className="hero">
                <span className="eyebrow">
                  <span className="spark">✦</span> YOUR SOFTWARE FACTORY
                </span>
                <h1>
                  아이디어를 건네세요.
                  <br />
                  <span>만드는 과정은 ArkWork에.</span>
                </h1>
                <p>
                  무엇을 만들고 싶은지 설명해 주세요.
                  <br />
                  요구사항부터 결과 검토까지, 하나의 작업으로 이어집니다.
                </p>
              </div>
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void start();
                }}
              >
                <label htmlFor="requirements">
                  어떤 소프트웨어를 만들까요?
                </label>
                <textarea
                  id="requirements"
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setError("");
                  }}
                  maxLength={maxLength}
                  placeholder="예: 작은 팀을 위한 업무 관리 앱을 만들어 주세요. 담당자를 지정하고, 작업 상태를 보드에서 관리하고 싶어요."
                  aria-describedby="input-help input-error"
                />
                <div className="composer-footer">
                  <span id="input-help">
                    <span className="tiny-square">▧</span> {label} 워크플로 ·
                    실제 코드 생성 없음
                  </span>
                  <div>
                    <span className="char-count">
                      {prompt.length}/{maxLength.toLocaleString()}
                    </span>
                    <button
                      className="primary"
                      type="submit"
                      disabled={submitting || loading}
                    >
                      {submitting
                        ? "저장 중…"
                        : mode === "api"
                          ? "요구사항 저장"
                          : `${label} 작업 시작`}{" "}
                      <span>↗</span>
                    </button>
                  </div>
                </div>
                {error && (
                  <p id="input-error" className="error" role="alert">
                    {error}
                  </p>
                )}
              </form>
              <section className="examples">
                <div className="section-heading">
                  <h2>이런 작업부터 시작해 보세요</h2>
                  <span>선택하면 요구사항이 입력됩니다</span>
                </div>
                <div className="example-grid">
                  {examples.map((example) => (
                    <button
                      className="example-card"
                      key={example.title}
                      onClick={() => {
                        setPrompt(example.prompt);
                        document.getElementById("requirements")?.focus();
                      }}
                    >
                      <span className="example-icon">{example.icon}</span>
                      <strong>{example.title}</strong>
                      <p>{example.prompt}</p>
                      <span className="card-arrow">↗</span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="flow">
                <div>
                  <span className="eyebrow">FROM IDEA TO REVIEW</span>
                  <h2>한 번의 요청, 연결된 과정</h2>
                </div>
                <ol>
                  {stages.map((stage, index) => (
                    <li key={stage}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      {stage}
                    </li>
                  ))}
                </ol>
                <p>
                  현재는 진행 흐름을 시뮬레이션합니다. AI 실행과 저장소 연결은
                  다음 단계에서 제공합니다.
                </p>
              </section>
            </>
          )}
          {!selected && view === "history" && (
            <section className="history">
              <span className="eyebrow">WORK HISTORY</span>
              <h1>작업 기록</h1>
              <p className="muted">
                {mode === "api"
                  ? "최근 100개 작업을 서버에서 조회합니다. 같은 개발 계정의 다른 브라우저에서도 확인할 수 있습니다."
                  : "최근 20개 작업을 이 브라우저에 저장합니다."}
              </p>
              {!runs.length ? (
                <div className="empty">
                  <span>▤</span>
                  <h2>아직 작업이 없습니다</h2>
                  <p>아이디어를 입력해 첫 데모 작업을 시작하세요.</p>
                  <button className="primary" onClick={newWork}>
                    새 작업 시작
                  </button>
                </div>
              ) : (
                <div className="history-list">
                  {runs.map((run) => (
                    <button key={run.id} onClick={() => setSelectedId(run.id)}>
                      <div>
                        <strong>{run.prompt}</strong>
                        <small>
                          {new Date(run.createdAt).toLocaleString("ko-KR")}
                        </small>
                      </div>
                      <span className={`status ${run.status}`}>
                        {statusText[run.status]}
                      </span>
                      <span>→</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {selected && (
            <section className="detail">
              <button
                className="back"
                onClick={() => {
                  setSelectedId(null);
                  setView("history");
                }}
              >
                ← 작업 기록
              </button>
              <div className="detail-heading">
                <div>
                  <span className="eyebrow">
                    WORK / {selected.id.slice(0, 8)}
                  </span>
                  <h1>{titles[selected.status]}</h1>
                </div>
                <span className={`status ${selected.status}`}>
                  {statusText[selected.status]}
                </span>
              </div>
              <p className="notice">
                {label} 시뮬레이션입니다. 실제 AI 호출, 코드 생성, 테스트 및 PR
                생성은 수행하지 않습니다.
              </p>
              <HumanCheckpoint
                key={`${selected.id}-${selected.version}`}
                run={selected}
                pending={actionPending}
                respond={(action, text) => respond(selected, action, text)}
              />
              {selected.status === "awaiting_approval" && selected.plan && (
                <div className="panel approval-panel">
                  <span className="eyebrow">EXECUTION APPROVAL</span>
                  <h2>실행 계획</h2>
                  <p>{selected.plan.scope}</p>
                  {selected.plan.human && (
                    <div className="plan-inputs">
                      <h3>이번 계획에 반영된 사용자 입력</h3>
                      <p>
                        <strong>요구사항 확인 답변</strong>
                        <br />
                        {selected.plan.human.clarification || "답변 대기"}
                      </p>
                      {selected.plan.human.feedback && (
                        <p>
                          <strong>
                            수정 의견 · {selected.plan.human.revision}회차
                          </strong>
                          <br />
                          {selected.plan.human.feedback}
                        </p>
                      )}
                      <p className="muted">
                        답변과 수정 의견을 계획에 고정해 저장합니다. 실제 명세
                        생성·코드 수정은 아직 수행하지 않습니다.
                      </p>
                    </div>
                  )}
                  <ol>
                    {selected.plan.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <dl>
                    <div>
                      <dt>단계 진행 상한</dt>
                      <dd>{selected.plan.limits.maxSteps}회</dd>
                    </div>
                    <div>
                      <dt>자동 실행 시도 상한</dt>
                      <dd>{selected.plan.limits.maxAttempts}회</dd>
                    </div>
                    <div>
                      <dt>유료 AI 호출</dt>
                      <dd>없음 · 모의 실행 전용</dd>
                    </div>
                  </dl>
                  <p className="plan-reference">
                    계획: {selected.planHash}
                    <br />
                    정책: {selected.policyVersion}
                  </p>
                  <label className="approval-confirm">
                    <input
                      type="checkbox"
                      checked={approvalAccepted}
                      onChange={(e) => setApprovalAccepted(e.target.checked)}
                      disabled={actionPending}
                    />
                    위 범위와 제한을 확인했으며 서버 모의 실행을 승인합니다.
                  </label>
                  <button
                    className="primary"
                    disabled={!approvalAccepted || actionPending}
                    onClick={() => {
                      void approve(selected);
                    }}
                  >
                    {actionPending ? "승인 저장 중…" : "계획 승인 후 모의 실행"}
                  </button>
                </div>
              )}
              {selected.failureReason && (
                <p className="notice" role="alert">
                  {selected.failureReason}
                </p>
              )}
              <div className="detail-grid">
                <div className="panel">
                  <h2>요구사항</h2>
                  <p className="requirement-text">{selected.prompt}</p>
                  <small className="muted">
                    {new Date(selected.createdAt).toLocaleString("ko-KR")}
                  </small>
                </div>
                <div className="panel">
                  <h2>진행 과정</h2>
                  <ol className="timeline">
                    {stages.map((stage, index) => (
                      <li
                        key={stage}
                        className={
                          index < selected.stage
                            ? "done"
                            : index === selected.stage
                              ? "current"
                              : ""
                        }
                      >
                        <span>{index < selected.stage ? "✓" : index + 1}</span>
                        <div>
                          <strong>{stage}</strong>
                          <small>
                            {index < selected.stage
                              ? `${label} 단계 완료`
                              : index === selected.stage
                                ? selected.status === "review"
                                  ? "모의 결과 검토 대기"
                                  : selected.status === "cancelled"
                                    ? "진행 중단"
                                    : selected.status === "running"
                                      ? `${label} 단계 진행 중`
                                      : statusText[selected.status]
                                : "대기 중"}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
              <div aria-live="polite" className="progress-message">
                {selected.status === "running"
                  ? `현재 단계: ${stages[selected.stage]}. 잠시 후 다음 모의 단계로 이동합니다.`
                  : selected.status === "review"
                    ? "모의 진행이 완료되었습니다. 아래에서 작업 요약을 확인하세요."
                    : selected.status === "awaiting_approval"
                      ? "승인 전에는 실행 큐나 모의 진행이 시작되지 않습니다."
                      : selected.status === "awaiting_input" ||
                          selected.status === "awaiting_decision"
                        ? "당신의 응답을 기다리고 있습니다. 자동으로 다음 단계로 넘어가지 않습니다."
                        : selected.status === "completed"
                          ? "사용자가 결과를 확인하고 완료한 작업입니다."
                          : selected.status === "queued"
                            ? "서버 실행 큐에서 차례를 기다리고 있습니다."
                            : selected.status === "cancelling"
                              ? "서버가 실행 중단을 확인한 뒤 취소 완료로 표시합니다."
                              : "이 작업은 더 이상 진행되지 않습니다."}
              </div>
              {["review", "completed"].includes(selected.status) && (
                <div className="panel result">
                  <span className="eyebrow">REVIEW HANDOFF</span>
                  <h2>실제 구현 전에 확인할 항목</h2>
                  {selected.humanWorkflow && (
                    <div className="plan-inputs">
                      <p>
                        <strong>사용자 답변</strong>
                        <br />
                        {selected.clarification}
                      </p>
                      {selected.feedback && (
                        <p>
                          <strong>
                            반영할 수정 의견 · {selected.revision}회차
                          </strong>
                          <br />
                          {selected.feedback}
                        </p>
                      )}
                      <p>
                        <strong>구현 전 결정</strong>
                        <br />
                        {selected.decision}
                      </p>
                    </div>
                  )}
                  <p>
                    입력한 요구사항은 저장되었습니다. 다음 항목은 실제 Software
                    Factory 연결을 위한 검토 목록입니다.
                  </p>
                  <ul>
                    <li>사용자와 핵심 사용 시나리오 정의</li>
                    <li>기능별 완료 조건과 테스트 기준 합의</li>
                    <li>저장소, 실행 환경 및 AI 제공자 연결</li>
                    <li>구현 결과를 별도 브랜치와 PR로 검토</li>
                  </ul>
                  <button
                    className="primary"
                    onClick={() => download(selected)}
                  >
                    작업 요약 다운로드 ↓
                  </button>
                  <span className="download-note">
                    Markdown · 데모 표시 포함
                  </span>
                </div>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <HumanHistory run={selected} />
              <div className="detail-actions">
                {[
                  "running",
                  "queued",
                  "awaiting_approval",
                  "awaiting_input",
                  "awaiting_decision",
                ].includes(selected.status) && (
                  <button
                    className="secondary"
                    disabled={actionPending}
                    onClick={() => {
                      void cancel(selected);
                    }}
                  >
                    {label} 작업 취소
                  </button>
                )}
                <button className="secondary" onClick={newWork}>
                  새 작업 만들기 ＋
                </button>
              </div>
            </section>
          )}
          <footer>
            ArkWork<span>아이디어에서 소프트웨어까지.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
