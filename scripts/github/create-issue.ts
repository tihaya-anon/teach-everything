#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ghApi, type GhApi } from "./gh-api.ts";

const usage = `Usage:
  pnpm github:issue:create -- --title <title> --body-file <path> [--label <name> ...]`;

type CreateIssueOptions = {
  title: string;
  bodyFile: string;
  labels: string[];
};

const parseArguments = (args: string[]): CreateIssueOptions | { help: true } => {
  let title: string | undefined;
  let bodyFile: string | undefined;
  const labels: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === "--") continue;
    if (argument === "--help") return { help: true };
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }

    if (argument === "--title") title = value;
    else if (argument === "--body-file") bodyFile = value;
    else if (argument === "--label") labels.push(value);
    else throw new Error(`Unknown argument: ${argument}`);

    index += 1;
  }

  if (title === undefined || title.trim() === "") throw new Error("--title is required");
  if (bodyFile === undefined) throw new Error("--body-file is required");

  return { title, bodyFile, labels };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getLabelNames = (issue: unknown) => {
  if (!isRecord(issue) || !Array.isArray(issue.labels)) return [];

  return issue.labels.flatMap((label) =>
    typeof label === "string"
      ? [label]
      : isRecord(label) && typeof label.name === "string"
        ? [label.name]
        : [],
  );
};

const getIssueIdentity = (issue: unknown) => {
  if (!isRecord(issue) || typeof issue.number !== "number" || typeof issue.html_url !== "string") {
    throw new Error("GitHub returned an invalid issue response");
  }

  return { number: issue.number, url: issue.html_url };
};

export const createIssue = async (options: CreateIssueOptions, api: GhApi = ghApi) => {
  const body = await readFile(options.bodyFile, "utf8");
  let issue = await api("repos/{owner}/{repo}/issues", {
    method: "POST",
    body: {
      title: options.title,
      body,
      labels: options.labels,
    },
  });
  const identity = getIssueIdentity(issue);

  try {
    const missingLabels = options.labels.filter((label) => !getLabelNames(issue).includes(label));
    if (missingLabels.length > 0) {
      await api(`repos/{owner}/{repo}/issues/${identity.number}/labels`, {
        method: "POST",
        body: { labels: missingLabels },
      });
      issue = await api(`repos/{owner}/{repo}/issues/${identity.number}`, { method: "GET" });
    }

    const finalLabels = getLabelNames(issue);
    const unappliedLabels = options.labels.filter((label) => !finalLabels.includes(label));
    if (unappliedLabels.length > 0) {
      throw new Error(`GitHub did not apply labels: ${unappliedLabels.join(", ")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Issue created at ${identity.url}, but label repair failed: ${message}`, {
      cause: error,
    });
  }

  return identity.url;
};

const run = async () => {
  const options = parseArguments(process.argv.slice(2));
  if ("help" in options) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  process.stdout.write(`${await createIssue(options)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`create-issue: ${message}\n\n${usage}\n`);
    process.exitCode = 1;
  });
}
