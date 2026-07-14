import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createIssue } from "./create-issue.ts";
import type { GhApi, GhApiOptions } from "./gh-api.ts";

test("creates an issue and repairs labels omitted by GitHub", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "teach-everything-gh-test-"));
  const bodyPath = join(directory, "issue.md");
  const calls: Array<{ endpoint: string } & GhApiOptions> = [];
  let issue: { number: number; html_url: string; labels: Array<{ name: string }> } = {
    number: 42,
    html_url: "https://github.com/example/project/issues/42",
    labels: [],
  };
  await writeFile(bodyPath, "## Problem Statement\n\nDiagnose one Agent Run.\n");
  const api: GhApi = async (endpoint, options = {}) => {
    calls.push({ endpoint, ...options });
    if (endpoint.endsWith("/labels")) {
      const body = options.body as { labels: string[] };
      issue = { ...issue, labels: body.labels.map((name) => ({ name })) };
      return issue.labels;
    }
    return issue;
  };

  // When
  const url = await createIssue(
    {
      title: "Agent Run Diagnosis v1",
      bodyFile: bodyPath,
      labels: ["ready-for-agent"],
    },
    api,
  );

  // Then
  assert.equal(url, "https://github.com/example/project/issues/42");
  assert.deepEqual(calls, [
    {
      endpoint: "repos/{owner}/{repo}/issues",
      method: "POST",
      body: {
        title: "Agent Run Diagnosis v1",
        body: "## Problem Statement\n\nDiagnose one Agent Run.\n",
        labels: ["ready-for-agent"],
      },
    },
    {
      endpoint: "repos/{owner}/{repo}/issues/42/labels",
      method: "POST",
      body: { labels: ["ready-for-agent"] },
    },
    {
      endpoint: "repos/{owner}/{repo}/issues/42",
      method: "GET",
    },
  ]);
});

test("reports the created issue URL when label repair fails", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "teach-everything-gh-test-"));
  const bodyPath = join(directory, "issue.md");
  await writeFile(bodyPath, "Issue body\n");
  const api: GhApi = async (endpoint) => {
    if (endpoint.endsWith("/labels")) throw new Error("permission denied");
    return {
      number: 42,
      html_url: "https://github.com/example/project/issues/42",
      labels: [],
    };
  };

  // When
  const result = createIssue(
    {
      title: "Agent Run Diagnosis v1",
      bodyFile: bodyPath,
      labels: ["ready-for-agent"],
    },
    api,
  );

  // Then
  await assert.rejects(
    result,
    new Error(
      "Issue created at https://github.com/example/project/issues/42, but label repair failed: permission denied",
    ),
  );
});
