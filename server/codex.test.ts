import { expect, it } from "vitest";
import {
  planningOptions,
  subscriptionConfig,
  subscriptionEnvironment,
  validateOutput,
} from "./codex";
it("uses a separate subscription home, never passes API keys and disables planning tools", () => {
  const env = subscriptionEnvironment("/tmp/arkwork-codex-test", {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "private-api-secret",
    CODEX_API_KEY: "other-key",
    CODEX_HOME: "/existing-chat-session",
    DATABASE_URL: "private-db",
  });
  expect(env).toEqual({
    CODEX_HOME: "/tmp/arkwork-codex-test",
    PATH: "/usr/bin",
  });
  expect(subscriptionConfig).toMatchObject({
    forced_login_method: "chatgpt",
    model_provider: "openai",
    features: {
      shell_tool: false,
      unified_exec: false,
      apps: false,
      multi_agent: false,
    },
  });
  expect(planningOptions).toMatchObject({
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
  });
});
it("validates bounded structured questions and specifications before storage", () => {
  expect(
    validateOutput(
      "questions",
      JSON.stringify({ questions: ["사용자는 누구인가요?"] }),
    ),
  ).toEqual(["사용자는 누구인가요?"]);
  expect(
    validateOutput(
      "specification",
      JSON.stringify({
        summary: "팀 업무 관리",
        acceptanceCriteria: ["상태를 변경할 수 있다."],
        excludedScope: [],
      }),
    ),
  ).toMatchObject({ summary: "팀 업무 관리" });
  for (const raw of [
    "not-json",
    "[]",
    "null",
    '{"questions":[]}',
    '{"questions":[""],"secret":"x"}',
    JSON.stringify({ questions: Array(6).fill("질문") }),
  ])
    expect(() => validateOutput("questions", raw)).toThrow();
  expect(() =>
    validateOutput(
      "specification",
      JSON.stringify({
        summary: "",
        acceptanceCriteria: ["완료"],
        excludedScope: [],
      }),
    ),
  ).toThrow();
});
