import { useEffect, useRef, useState } from "react";
import type { PublisherStatus, Run } from "./factory";

export function PullRequestPanel({
  run,
  connection,
  publish,
  refresh,
  assess,
}: {
  run: Run;
  connection: PublisherStatus | null;
  publish: (target: {
    repository: string;
    base: string;
    branch: string;
  }) => Promise<void>;
  refresh: () => Promise<void>;
  assess: (decision: string, text: string, key: string) => Promise<void>;
}) {
  const [repository, setRepository] = useState(
    run.pullRequest?.repository ?? connection?.repositories[0] ?? "",
  );
  const [base, setBase] = useState(run.pullRequest?.base ?? "main");
  const [branch, setBranch] = useState(run.pullRequest?.branch ?? "");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    if (!repository && connection?.repositories[0])
      setRepository(connection.repositories[0]);
  }, [connection, repository]);
  const pr = run.pullRequest;
  async function perform(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "PR 요청을 처리하지 못했습니다.",
      );
    } finally {
      setPending(false);
    }
  }
  async function review(decision: string) {
    const signature = JSON.stringify([
      run.id,
      run.version,
      pr?.headSha,
      decision,
      text,
    ]);
    if (request.current?.signature !== signature)
      request.current = { signature, key: crypto.randomUUID() };
    await assess(decision, text, request.current.key);
    request.current = null;
    setText("");
  }
  const ready = text.trim().length >= 10 && !pending;
  return (
    <section className="panel pr-panel" aria-label="PR 제출과 사람 평가">
      <span className="eyebrow">PULL REQUEST · HUMAN REVIEW</span>
      <h2>구현 결과를 PR로 제출하고 평가하기</h2>
      <p>
        실제 구현 커밋을 푸시한 브랜치를 제출하면 GitHub PR을 생성합니다. 현재
        Codex는 질문·명세만 작성하므로 구현 브랜치는 별도로 준비해야 합니다.
      </p>
      {!connection?.enabled && (
        <p className="notice">
          GitHub 연결이 비활성 상태입니다. 서버 설정과 허용 저장소가 필요합니다.
          모의 결과는 실제 PR로 제출되지 않습니다.
        </p>
      )}
      {(!pr || pr.status === "publishing") && (
        <>
          <div className="pr-target">
            <label>
              허용 저장소
              <select
                aria-label="PR 저장소"
                value={pr?.repository ?? repository}
                disabled={pending || Boolean(pr)}
                onChange={(e) => setRepository(e.target.value)}
              >
                <option value="">저장소 선택</option>
                {connection?.repositories.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </select>
            </label>
            <label>
              기준 브랜치
              <input
                value={pr?.base ?? base}
                disabled={pending || Boolean(pr)}
                onChange={(e) => setBase(e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              구현 브랜치
              <input
                value={pr?.branch ?? branch}
                disabled={pending || Boolean(pr)}
                onChange={(e) => setBranch(e.target.value)}
                maxLength={200}
                placeholder="factory/작업-번호"
              />
            </label>
          </div>
          {pr && (
            <p className="notice">
              PR 생성 결과를 확인 중입니다. 실패한 요청은 같은 브랜치로 다시
              확인해 중복 생성을 방지합니다.
            </p>
          )}
          <button
            className="primary"
            disabled={
              pending ||
              !connection?.enabled ||
              !(pr?.repository ?? repository) ||
              !(pr?.branch ?? branch) ||
              !(pr?.base ?? base)
            }
            onClick={() =>
              void perform(() =>
                publish({
                  repository: pr?.repository ?? repository,
                  base: pr?.base ?? base,
                  branch: pr?.branch ?? branch,
                }),
              )
            }
          >
            {pending
              ? "GitHub 확인 중…"
              : pr
                ? "PR 생성 결과 재확인"
                : "실제 브랜치로 PR 생성"}
          </button>
        </>
      )}
      {pr?.status === "ready" && (
        <>
          <p>
            <a href={pr.url} target="_blank" rel="noreferrer">
              GitHub PR #{pr.number} 열기 ↗
            </a>{" "}
            ·{" "}
            <a href={`${pr.url}/files`} target="_blank" rel="noreferrer">
              전체 변경 내용 ↗
            </a>
          </p>
          <p className="pr-sha">검토 커밋: {pr.headSha}</p>
          <p>
            {pr.open ? "열린 PR" : "닫힌 PR"}
            {pr.draft ? " · 초안" : ""} · CI:{" "}
            {
              (
                {
                  passed: "통과",
                  pending: "진행 중",
                  failed: "실패",
                  unreported: "보고된 검사 없음",
                } as const
              )[pr.checks ?? "unreported"]
            }
          </p>
          <p className="muted">
            마지막 확인:{" "}
            {pr.updatedAt && new Date(pr.updatedAt).toLocaleString("ko-KR")} ·
            평가 제출 시 GitHub 상태를 다시 확인합니다.
          </p>
          <ul className="pr-files">
            {pr.files?.map((file) => (
              <li key={file.path}>
                <span>{file.path}</span>{" "}
                <small>
                  +{file.additions} / −{file.deletions}
                </small>
              </li>
            ))}
          </ul>
          {pr.filesTruncated && (
            <p>
              첫 100개 파일을 표시합니다. GitHub에서 전체 변경을 확인하세요.
            </p>
          )}
          {pr.assessment && (
            <p className="notice">
              {pr.assessment.decision === "approve"
                ? "사람이 이 커밋을 승인했습니다."
                : "수정 요청이 있습니다. 구현 브랜치에 수정 커밋을 올리고 상태를 갱신하세요."}
              <br />
              {pr.assessment.text}
            </p>
          )}
          <button
            className="secondary"
            disabled={pending || !connection?.enabled}
            onClick={() => void perform(refresh)}
          >
            PR·CI 상태 새로 확인
          </button>
          {run.status === "review" && (
            <>
              <label className="human-input">
                평가 사유 / 수정 요청
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  disabled={pending}
                  placeholder="완료 조건과 변경 내용을 비교해 평가 사유를 남겨 주세요. 10~2,000자"
                />
              </label>
              <p className="muted">
                ArkWork 내부 평가로 기록됩니다. GitHub Review 제출·댓글
                등록·병합은 수행하지 않습니다. 보고된 검사가 없으면 테스트
                완료를 의미하지 않습니다.
              </p>
              <div className="pr-actions">
                <button
                  className="secondary"
                  disabled={
                    !ready || !connection?.enabled || !pr.open || pr.draft
                  }
                  onClick={() => void perform(() => review("changes"))}
                >
                  수정 요청 · 검토 유지
                </button>
                <button
                  className="primary"
                  disabled={
                    !ready ||
                    !connection?.enabled ||
                    !pr.open ||
                    pr.draft ||
                    ["pending", "failed"].includes(pr.checks ?? "")
                  }
                  onClick={() => void perform(() => review("approve"))}
                >
                  이 커밋 승인 · 작업 완료
                </button>
              </div>
            </>
          )}
          {Boolean(pr.reviews.length) && (
            <details>
              <summary>커밋별 평가 기록 ({pr.reviews.length})</summary>
              <ol>
                {pr.reviews.map((review, i) => (
                  <li key={i}>
                    <strong>
                      {review.decision === "approve" ? "승인" : "수정 요청"}
                    </strong>{" "}
                    · {review.actor} ·{" "}
                    {new Date(review.at).toLocaleString("ko-KR")}
                    <p className="pr-sha">{review.headSha}</p>
                    <p>{review.text}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </section>
  );
}
