export const stages = [
  "요구사항 분석",
  "구현 계획",
  "구현",
  "검증",
  "결과 검토",
] as const;
export type Run = {
  id: string;
  prompt: string;
  createdAt: string;
  stage: number;
  status: "running" | "review" | "cancelled";
  version?: number;
  state?: string;
};
export const storageKey = "arkwork.demo.runs.v1";

export function createRun(prompt: string): Run {
  const value = prompt.trim();
  if (value.length < 10 || value.length > 2000)
    throw new Error("요구사항을 10~2,000자로 입력해 주세요.");
  return {
    id: crypto.randomUUID(),
    prompt: value,
    createdAt: new Date().toISOString(),
    stage: 0,
    status: "running",
  };
}

export function advanceRun(run: Run): Run {
  if (run.status !== "running") return run;
  const stage = Math.min(run.stage + 1, stages.length - 1);
  return {
    ...run,
    stage,
    status: stage === stages.length - 1 ? "review" : "running",
  };
}

export function readRuns(value: string | null): Run[] {
  try {
    const data: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(data)) return [];
    return data
      .filter((item): item is Run => {
        if (!item || typeof item !== "object") return false;
        const r = item as Record<string, unknown>;
        return (
          typeof r.id === "string" &&
          typeof r.prompt === "string" &&
          r.prompt.length <= 2000 &&
          typeof r.createdAt === "string" &&
          Number.isFinite(Date.parse(r.createdAt)) &&
          Number.isInteger(r.stage) &&
          Number(r.stage) >= 0 &&
          Number(r.stage) < stages.length &&
          ["running", "review", "cancelled"].includes(String(r.status))
        );
      })
      .slice(0, 20);
  } catch {
    return [];
  }
}
