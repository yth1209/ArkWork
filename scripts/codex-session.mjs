import { mkdir, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const command = process.argv[2] || "status";
if (!["login", "status", "logout"].includes(command))
  throw new Error("Use login, status or logout");
const authDirectory = resolve(
  process.env.ARKWORK_CODEX_HOME || ".runtime/codex-subscription",
);
await mkdir(authDirectory, { recursive: true, mode: 0o700 });
await chmod(authDirectory, 0o700);
// Do not borrow this chat's Codex credentials or inherit API keys.
const env = { CODEX_HOME: authDirectory };
for (const key of [
  "PATH",
  "LANG",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
])
  if (process.env[key]) env[key] = process.env[key];
const cli = resolve("node_modules/@openai/codex/bin/codex.js");
const args =
  command === "logout"
    ? ["logout"]
    : ["login", ...(command === "login" ? ["--device-auth"] : ["status"])];
const child = spawn(
  process.execPath,
  [
    cli,
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'cli_auth_credentials_store="file"',
    ...args,
  ],
  { env, stdio: "inherit" },
);
child.once("error", () => {
  console.error("Codex CLI를 실행하지 못했습니다. npm ci를 확인하세요.");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
