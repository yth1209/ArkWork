import type { Run, AgentStatus, Specification } from "./factory";
export const agentBusy = (run: Run) =>
  !!run.agentTask &&
  ["pending", "running", "cancelling"].includes(run.agentTask.status);
const statusNames: Record<string, string> = {
  pending: "호출 대기",
  running: "Codex 작성 중",
  cancelling: "중단 확인 중",
  cancelled: "호출 취소됨",
  failed: "호출 실패",
  succeeded: "작성 완료",
};
export function CodexPanel({
  run,
  connection,
  pending,
  generate,
  cancel,
}: {
  run: Run;
  connection: AgentStatus | null;
  pending: boolean;
  generate: (phase: string) => void;
  cancel: () => void;
}) {
  if (!run.humanWorkflow) return null;
  const phase =
    run.status === "awaiting_input"
      ? "questions"
      : run.status === "awaiting_approval"
        ? "specification"
        : null;
  if (!phase && !agentBusy(run)) return null;
  const hasResult =
    phase === "questions" ? !!run.agentQuestions : !!run.agentSpecification;
  return (
    <section className="panel codex-panel" aria-label="Codex 구독 연결">
      <span className="eyebrow">CODEX · CHATGPT SUBSCRIPTION</span>
      <h2>Codex로 {phase === "questions" ? "질문" : "명세"} 작성</h2>
      <p>{connection?.message ?? "구독 연결 상태를 확인하고 있습니다."}</p>
      <p className="muted">
        버튼을 누르면 ChatGPT 구독 사용량으로 1회 호출합니다. 최대 2분, 같은
        회차·종류는 2회까지이며 자동 재호출하지 않습니다. 이 단계에서 코드를
        작성하거나 실행하지 않습니다.
      </p>
      {run.agentTask && (
        <p role="status">
          {run.agentTask.phase === "questions" ? "질문" : "명세"} ·{" "}
          {statusNames[run.agentTask.status] ?? run.agentTask.status}
          {run.agentTask.status === "failed" &&
            " · 로그인·구독 한도·네트워크를 확인한 뒤 직접 재시도하세요."}
        </p>
      )}
      {agentBusy(run) ? (
        <button
          className="secondary"
          disabled={pending || run.agentTask?.status === "cancelling"}
          onClick={cancel}
        >
          Codex 호출 중단
        </button>
      ) : (
        phase && (
          <button
            className="primary"
            disabled={pending || !connection?.authenticated || hasResult}
            onClick={() => generate(phase)}
          >
            {hasResult
              ? "현재 회차의 Codex 작성 완료"
              : phase === "questions"
                ? "구독 사용 · Codex 질문 작성"
                : "구독 사용 · Codex 명세 작성"}
          </button>
        )
      )}
    </section>
  );
}
export function CodexSpecification({
  specification,
}: {
  specification: Specification;
}) {
  return (
    <div className="plan-inputs codex-specification">
      <h3>Codex 명세 초안 · 사람 검토 필요</h3>
      <p>{specification.summary}</p>
      <h4>완료 조건</h4>
      <ul>
        {specification.acceptanceCriteria.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      <h4>제외 범위</h4>
      {specification.excludedScope.length ? (
        <ul>
          {specification.excludedScope.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>명시된 제외 항목 없음</p>
      )}
    </div>
  );
}
