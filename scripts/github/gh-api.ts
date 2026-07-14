import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GhApiOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
};

export type GhApi = (endpoint: string, options?: GhApiOptions) => Promise<unknown>;

export class GhApiError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode: number | undefined) {
    super(message);
    this.name = "GhApiError";
    this.statusCode = statusCode;
  }
}

export const ghApi: GhApi = async (endpoint, options = {}) => {
  const method = options.method ?? "GET";
  const args = ["api", endpoint, "-X", method];
  const directory =
    options.body === undefined ? undefined : await mkdtemp(join(tmpdir(), "teach-everything-gh-"));

  try {
    if (directory !== undefined) {
      const inputPath = join(directory, "request.json");
      await writeFile(inputPath, JSON.stringify(options.body));
      args.push("--input", inputPath);
    }

    let result;
    try {
      result = await execFileAsync("gh", args, { encoding: "utf8", env: process.env });
    } catch (error) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr).trim()
          : "";
      const message = stderr || (error instanceof Error ? error.message : String(error));
      const statusMatch = message.match(/HTTP (\d{3})/);
      throw new GhApiError(message, statusMatch === null ? undefined : Number(statusMatch[1]));
    }

    try {
      return result.stdout === "" ? undefined : JSON.parse(result.stdout as string);
    } catch {
      throw new Error("gh api returned invalid JSON");
    }
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
};
