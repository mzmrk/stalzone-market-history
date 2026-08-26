import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkflowReport } from "../scripts/workflow-report.mjs";

test("time-budget reporting clearly identifies a resumable checkpoint", () => {
  const report = formatWorkflowReport({
    artifactCount: 103,
    complete: false,
    completedArtifacts: 68,
    reason: "time-budget",
    region: "ru",
  });

  assert.match(report.annotation, /RU market history checkpointed/);
  assert.match(report.annotation, /68\/103 artifacts completed/);
  assert.match(report.annotation, /next run will resume/);
  assert.match(report.summary, /Checkpointed, will resume/);
  assert.match(report.summary, /No incomplete regional archive was published/);
});
