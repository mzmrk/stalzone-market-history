export function formatWorkflowReport(result) {
  const region = String(result.region ?? "unknown").toUpperCase();
  const progress = `${result.completedArtifacts}/${result.artifactCount} artifacts`;

  if (result.complete) {
    return {
      annotation: null,
      summary: `### ${region} market history\n\n**Published:** ${progress} updated.\n\n`,
    };
  }

  if (result.reason === "time-budget") {
    return {
      annotation: `::warning title=${region} market history checkpointed::${progress} completed. The next run will resume from this checkpoint.`,
      summary:
        `### ${region} market history\n\n` +
        `**Checkpointed, will resume:** ${progress} completed before the runtime budget. ` +
        `No incomplete regional archive was published.\n\n`,
    };
  }

  return {
    annotation: `::error title=${region} market history stopped::${progress} completed; reason: ${result.reason ?? "unknown"}.`,
    summary:
      `### ${region} market history\n\n` +
      `**Stopped:** ${progress} completed; reason: ${result.reason ?? "unknown"}.\n\n`,
  };
}
