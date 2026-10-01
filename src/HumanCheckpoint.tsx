import { useState } from "react";
import type { Run } from "./factory";

export function HumanCheckpoint({
  run,
  pending,
  respond,
}: {
  run: Run;
  pending: boolean;
  respond: (action: string, text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const ready = text.trim().length >= 10 && text.trim().length <= 2000;
  const revise = () => {
    void respond("revise", text);
  };
  if (
    run.pullRequest ||
    !run.humanWorkflow ||
    ![
      "awaiting_input",
      "awaiting_approval",
      "awaiting_decision",
      "review",
    ].includes(run.status)
  )
    return null;
  return (
    <section className="panel human-checkpoint" aria-label="사용자 확인">
      <span className="eyebrow">YOUR INPUT MATTERS</span>
      {run.status === "awaiting_input" ? (
        <>
          <h2>먼저 요구사항을 함께 확인해요</h2>
          <p>
            아래 질문에 답하면 답변을 포함한 실행 계획을 검토할 수 있습니다.
          </p>
          <ol>
            {(
              run.agentQuestions ?? [
                "누가 사용하며 가장 중요한 사용 시나리오는 무엇인가요?",
                "어떤 동작을 확인하면 이번 작업이 완료됐다고 판단하나요?",
                "이번 작업에서 제외할 기능이나 제약은 무엇인가요?",
              ]
            ).map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ol>
          <p className="muted">
            {run.agentQuestions
              ? "Codex가 작성한 질문입니다. 답변과 계획은 사람이 검토합니다."
              : "현재는 데모용 공통 질문입니다. 위 Codex 버튼으로 실제 질문을 작성할 수 있습니다."}
          </p>
        </>
      ) : run.status === "awaiting_decision" ? (
        <>
          <h2>구현 전에 당신의 결정이 필요합니다</h2>
          <p>
            승인한 범위를 유지하고 모의 구현을 진행할까요? 범위를 바꾸려면 수정
            의견을 제출하고 새 계획을 승인해 주세요.
          </p>
          <p className="muted">
            데모에서는 모든 새 작업이 이 지점에서 멈춥니다. 답변을 기다리는 동안
            실행하지 않습니다.
          </p>
          <button
            className="primary"
            disabled={pending}
            onClick={() => {
              void respond("continue", "");
            }}
          >
            승인한 범위로 계속 진행
          </button>
        </>
      ) : run.status === "review" ? (
        <>
          <h2>결과를 승인하거나 수정 의견을 주세요</h2>
          <p>
            현재 결과는 모의 진행 요약입니다. 아래 입력을 확인하고 완료하거나,
            수정 의견을 제출해 새 계획부터 다시 검토할 수 있습니다.
          </p>
          <button
            className="primary"
            disabled={pending}
            onClick={() => {
              void respond("accept", "");
            }}
          >
            결과 승인 · 작업 완료
          </button>
        </>
      ) : (
        <>
          <h2>계획에 수정할 내용이 있나요?</h2>
          <p>
            수정 의견을 제출하면 계획과 승인 대상이 갱신됩니다. 아래에서 새
            계획을 확인한 뒤 실행을 승인하세요.
          </p>
        </>
      )}
      <label className="human-input">
        {run.status === "awaiting_input" ? "요구사항 확인 답변" : "수정 의견"}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          rows={4}
          disabled={pending}
          placeholder={
            run.status === "awaiting_input"
              ? "사용자, 완료 조건, 제외 범위를 함께 적어 주세요."
              : "변경할 내용과 이유를 적어 주세요. 새 계획을 다시 승인해야 합니다."
          }
        />
      </label>
      <div className="human-form-footer">
        <small className="muted">
          10~2,000자 · 수정 회차 {run.revision ?? 0}/3
        </small>
        <button
          className="secondary"
          disabled={
            pending ||
            !ready ||
            (run.status !== "awaiting_input" && (run.revision ?? 0) >= 3)
          }
          onClick={
            run.status === "awaiting_input"
              ? () => {
                  void respond("answer", text);
                }
              : revise
          }
        >
          {pending
            ? "응답 저장 중…"
            : run.status === "awaiting_input"
              ? "답변 저장 · 계획 확인"
              : "수정 의견 제출 · 계획 다시 검토"}
        </button>
      </div>
    </section>
  );
}

const actionNames: Record<string, string> = {
  approve_pr: "PR 결과 승인",
  request_pr_changes: "PR 수정 요청",
  answer: "요구사항 답변",
  revise: "수정 요청",
  continue: "진행 결정",
  accept: "결과 승인",
  approve_plan: "계획 승인",
};
export function HumanHistory({ run }: { run: Run }) {
  if (!run.humanWorkflow || !run.humanHistory?.length) return null;
  return (
    <section className="panel human-history">
      <h2>답변과 결정 기록</h2>
      <ol>
        {run.humanHistory.map((item, index) => (
          <li key={index}>
            <strong>{actionNames[item.action] ?? item.action}</strong>
            <small className="muted">
              {new Date(item.at).toLocaleString("ko-KR")}
            </small>
            <p>{item.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
