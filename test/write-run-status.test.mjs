import assert from "node:assert/strict";
import test from "node:test";
import { buildRunStatus } from "../scripts/write-run-status.mjs";

test("operational status records the attempted regions and workflow outcome", () => {
  assert.deepEqual(
    buildRunStatus({
      attemptedAt: "2026-08-26T12:00:00.000Z",
      regions: ["eu", "ru"],
      result: "success",
      runId: "123",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
    }),
    {
      schemaVersion: 1,
      workflow: "update-market-history",
      attemptedAt: "2026-08-26T12:00:00.000Z",
      result: "success",
      regions: ["eu", "ru"],
      runId: "123",
      runUrl: "https://github.com/owner/repo/actions/runs/123",
    },
  );
});
