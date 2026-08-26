import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputFile = path.resolve(process.argv[2] ?? "status/last-run.json");
  const status = buildRunStatus({
    attemptedAt: new Date().toISOString(),
    regions: JSON.parse(process.env.MARKET_REGIONS ?? "[]"),
    result: process.env.MARKET_RUN_RESULT ?? "unknown",
    runId: process.env.GITHUB_RUN_ID ?? null,
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
  });
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(status, null, 2)}\n`);
}

export function buildRunStatus({ attemptedAt, regions, result, runId, runUrl }) {
  if (!Number.isFinite(Date.parse(attemptedAt))) throw new Error("Run status requires a valid attemptedAt timestamp.");
  if (!Array.isArray(regions) || regions.some((region) => typeof region !== "string")) {
    throw new Error("Run status regions must be an array of strings.");
  }
  return {
    schemaVersion: 1,
    workflow: "update-market-history",
    attemptedAt,
    result,
    regions,
    runId,
    runUrl,
  };
}
