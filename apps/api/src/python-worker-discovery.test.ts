import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PYTHON_WORKER_COMMAND,
  loadPythonWorkerDiscoveryForStartup,
  PythonWorkerDiscoveryConfigError,
} from "./python-worker-discovery";

const createTemporaryWorkerRepo = () => mkdtempSync(join(tmpdir(), "python-worker-repo-"));

describe("loadPythonWorkerDiscoveryForStartup", () => {
  it("leaves the Python worker unconfigured when no repo path is selected", () => {
    // Given
    const environment = {};

    // When
    const config = loadPythonWorkerDiscoveryForStartup(environment);

    // Then
    expect(config).toBeUndefined();
  });

  it("loads a checked-out Python worker repo path with the default worker command", () => {
    // Given
    const workerRepoPath = createTemporaryWorkerRepo();

    // When
    const config = loadPythonWorkerDiscoveryForStartup({
      AGENT_RUN_PYTHON_WORKER_REPO_PATH: workerRepoPath,
    });

    // Then
    expect(config).toEqual({
      command: DEFAULT_PYTHON_WORKER_COMMAND,
      environment: { PYTHONPATH: join(workerRepoPath, "src") },
      workerRepoPath,
    });
  });

  it("resolves a relative Python worker repo path from the startup working directory", () => {
    // Given
    const parentDirectory = createTemporaryWorkerRepo();
    const workerRepoPath = mkdtempSync(join(parentDirectory, "runtime-"));
    const relativeWorkerRepoPath = workerRepoPath.slice(parentDirectory.length + 1);

    // When
    const config = loadPythonWorkerDiscoveryForStartup(
      {
        AGENT_RUN_PYTHON_WORKER_REPO_PATH: relativeWorkerRepoPath,
      },
      parentDirectory,
    );

    // Then
    expect(config?.workerRepoPath).toBe(workerRepoPath);
  });

  it("loads a custom Python worker command as command arguments", () => {
    // Given
    const workerRepoPath = createTemporaryWorkerRepo();
    const command = ["uv", "run", "agent-runtime-python-worker"] as const;

    // When
    const config = loadPythonWorkerDiscoveryForStartup({
      AGENT_RUN_PYTHON_WORKER_COMMAND: JSON.stringify(command),
      AGENT_RUN_PYTHON_WORKER_REPO_PATH: workerRepoPath,
    });

    // Then
    expect(config?.command).toEqual(command);
  });

  it.each([
    { AGENT_RUN_PYTHON_WORKER_REPO_PATH: "" },
    { AGENT_RUN_PYTHON_WORKER_REPO_PATH: "/path/that/does/not/exist" },
    {
      AGENT_RUN_PYTHON_WORKER_COMMAND: "python3 -m agent_runtime_python.worker",
      AGENT_RUN_PYTHON_WORKER_REPO_PATH: createTemporaryWorkerRepo(),
    },
    {
      AGENT_RUN_PYTHON_WORKER_COMMAND: JSON.stringify([]),
      AGENT_RUN_PYTHON_WORKER_REPO_PATH: createTemporaryWorkerRepo(),
    },
    {
      AGENT_RUN_PYTHON_WORKER_COMMAND: JSON.stringify([""]),
      AGENT_RUN_PYTHON_WORKER_REPO_PATH: createTemporaryWorkerRepo(),
    },
    {
      AGENT_RUN_PYTHON_WORKER_COMMAND: JSON.stringify(["python3", 42]),
      AGENT_RUN_PYTHON_WORKER_REPO_PATH: createTemporaryWorkerRepo(),
    },
  ])("rejects malformed Python worker discovery settings: %j", (environment) => {
    // Given
    const malformedEnvironment = environment;

    // When
    const loadConfig = () => loadPythonWorkerDiscoveryForStartup(malformedEnvironment);

    // Then
    expect(loadConfig).toThrow(PythonWorkerDiscoveryConfigError);
  });

  it("rejects a Python worker repo path that points to a file", () => {
    // Given
    const workerRepoDirectory = createTemporaryWorkerRepo();
    const filePath = join(workerRepoDirectory, "not-a-directory");
    writeFileSync(filePath, "");

    // When
    const loadConfig = () =>
      loadPythonWorkerDiscoveryForStartup({
        AGENT_RUN_PYTHON_WORKER_REPO_PATH: filePath,
      });

    // Then
    expect(loadConfig).toThrow(PythonWorkerDiscoveryConfigError);
  });
});
