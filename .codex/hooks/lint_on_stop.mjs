import { spawnSync } from "node:child_process";
import { findRepositoryRoot, readHookInput, writeHookOutput } from "./hook-runtime.mjs";

const maxFailureOutputLength = 4000;
const maxLintOutputBuffer = 8 * 1024 * 1024;

const getFailureReason = (result) => {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const detail = output.slice(-maxFailureOutputLength);

  return detail.length > 0
    ? `ESLint failed. Fix the reported issues before stopping.\n\n${detail}`
    : "ESLint failed without output. Run pnpm lint and fix the reported issues before stopping.";
};

const main = async () => {
  const input = await readHookInput();

  if (input.hook_event_name !== "Stop" || input.stop_hook_active === true) {
    writeHookOutput({});
    return;
  }

  const repositoryRoot = findRepositoryRoot(
    typeof input.cwd === "string" ? input.cwd : process.cwd(),
  );
  const result = spawnSync(
    "pnpm",
    ["exec", "eslint", ".", "--cache", "--cache-location", "node_modules/.cache/eslint/"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: maxLintOutputBuffer,
    },
  );

  if (!result.error && result.status === 0) {
    writeHookOutput({});
    return;
  }

  writeHookOutput({
    decision: "block",
    reason: result.error
      ? `Unable to complete ESLint: ${result.error.message}\n\n${getFailureReason(result)}`
      : getFailureReason(result),
  });
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  writeHookOutput({
    decision: "block",
    reason: `Unable to run ESLint before stopping: ${message}`,
  });
});
