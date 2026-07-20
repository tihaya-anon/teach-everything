import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_PYTHON_WORKER_COMMAND = [
  "python3",
  "-m",
  "agent_runtime_python.worker",
] as const;

export type PythonWorkerDiscoveryEnvironment = {
  readonly AGENT_RUN_PYTHON_WORKER_COMMAND?: string;
  readonly AGENT_RUN_PYTHON_WORKER_REPO_PATH?: string;
};

export type PythonWorkerDiscoveryConfig = {
  readonly command: readonly [string, ...string[]];
  readonly environment: {
    readonly PYTHONPATH: string;
  };
  readonly workerRepoPath: string;
};

export class PythonWorkerDiscoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonWorkerDiscoveryConfigError";
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const parseWorkerCommand = (command: string | undefined): readonly [string, ...string[]] => {
  if (command === undefined) return DEFAULT_PYTHON_WORKER_COMMAND;

  let parsedCommand: unknown;
  try {
    parsedCommand = JSON.parse(command) as unknown;
  } catch (error) {
    throw new PythonWorkerDiscoveryConfigError(
      "AGENT_RUN_PYTHON_WORKER_COMMAND must be a JSON array of command arguments",
    );
  }

  if (
    !Array.isArray(parsedCommand) ||
    parsedCommand.length === 0 ||
    !parsedCommand.every(isNonEmptyString)
  ) {
    throw new PythonWorkerDiscoveryConfigError(
      "AGENT_RUN_PYTHON_WORKER_COMMAND must contain at least one non-empty argument",
    );
  }

  return parsedCommand as [string, ...string[]];
};

const resolveWorkerRepoPath = (workerRepoPath: string | undefined, cwd: string) => {
  if (workerRepoPath === undefined) return undefined;
  if (workerRepoPath.trim().length === 0) {
    throw new PythonWorkerDiscoveryConfigError(
      "AGENT_RUN_PYTHON_WORKER_REPO_PATH must not be empty",
    );
  }

  const resolvedWorkerRepoPath = resolve(cwd, workerRepoPath);
  if (!existsSync(resolvedWorkerRepoPath) || !statSync(resolvedWorkerRepoPath).isDirectory()) {
    throw new PythonWorkerDiscoveryConfigError(
      "AGENT_RUN_PYTHON_WORKER_REPO_PATH must point to a directory",
    );
  }

  return resolvedWorkerRepoPath;
};

export const loadPythonWorkerDiscoveryForStartup = (
  environment: PythonWorkerDiscoveryEnvironment = process.env,
  cwd = process.cwd(),
): PythonWorkerDiscoveryConfig | undefined => {
  const workerRepoPath = resolveWorkerRepoPath(environment.AGENT_RUN_PYTHON_WORKER_REPO_PATH, cwd);
  if (workerRepoPath === undefined) return undefined;

  return {
    command: parseWorkerCommand(environment.AGENT_RUN_PYTHON_WORKER_COMMAND),
    environment: {
      PYTHONPATH: resolve(workerRepoPath, "src"),
    },
    workerRepoPath,
  };
};
