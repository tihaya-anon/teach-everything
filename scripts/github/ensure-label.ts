#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { GhApiError, ghApi, parseRepository, repositoryEndpoint, type GhApi } from "./gh-api.ts";

const USAGE = `Usage:
  pnpm github:label:ensure -- [--repo <owner/repo>] --name <name> --color <RRGGBB> [--description <text>]`;

type LabelOptions = {
  name: string;
  color: string;
  description: string;
  repository?: string;
};

export const parseEnsureLabelArguments = (args: string[]): LabelOptions | { help: true } => {
  let name: string | undefined;
  let color: string | undefined;
  let description = "";
  let repository: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === "--") continue;
    if (argument === "--help") return { help: true };
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }

    if (argument === "--name") name = value;
    else if (argument === "--color") color = value;
    else if (argument === "--description") description = value;
    else if (argument === "--repo") repository = parseRepository(value);
    else throw new Error(`Unknown argument: ${argument}`);

    index += 1;
  }

  if (name === undefined || name.trim() === "") throw new Error("--name is required");
  if (color === undefined || !/^[0-9a-fA-F]{6}$/.test(color)) {
    throw new Error("--color must be a six-digit hexadecimal value without #");
  }
  const options: LabelOptions = {
    name,
    color,
    description,
  };
  if (repository !== undefined) options.repository = repository;

  return options;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const matchesConfiguration = (label: unknown, options: LabelOptions) =>
  isRecord(label) &&
  label.name === options.name &&
  typeof label.color === "string" &&
  label.color.toLowerCase() === options.color.toLowerCase() &&
  (label.description ?? "") === options.description;

const validateLabel = (label: unknown, options: LabelOptions) => {
  if (!matchesConfiguration(label, options)) {
    throw new Error(`GitHub did not apply the requested configuration for label: ${options.name}`);
  }
  return options.name;
};

export const ensureLabel = async (options: LabelOptions, api: GhApi = ghApi) => {
  const endpoint = (path: string) => repositoryEndpoint(options.repository, path);

  try {
    // Prefer a no-op, then update, and only create after GitHub confirms the label is missing.
    const label = await api(endpoint(`/labels/${encodeURIComponent(options.name)}`), {
      method: "GET",
    });
    if (matchesConfiguration(label, options)) return options.name;

    const updatedLabel = await api(endpoint(`/labels/${encodeURIComponent(options.name)}`), {
      method: "PATCH",
      body: {
        new_name: options.name,
        color: options.color,
        description: options.description,
      },
    });
    return validateLabel(updatedLabel, options);
  } catch (error) {
    if (!(error instanceof GhApiError) || error.statusCode !== 404) throw error;
  }

  const label = await api(endpoint("/labels"), {
    method: "POST",
    body: {
      name: options.name,
      color: options.color,
      description: options.description,
    },
  });
  return validateLabel(label, options);
};

const run = async () => {
  const options = parseEnsureLabelArguments(process.argv.slice(2));
  if ("help" in options) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  process.stdout.write(`${await ensureLabel(options)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ensure-label: ${message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  });
}
