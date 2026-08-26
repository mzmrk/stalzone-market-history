# Operations

## Credentials

Collection uses `STALZONE_CLIENT_ID` and `STALZONE_CLIENT_SECRET`. The secret
belongs in GitHub Actions secrets or process environment only. It must not be
written to manifests, logs, fixtures, release assets, or Git history.

## Update lifecycle

A regional session has a fixed capture timestamp and 365-day retention cutoff.
An artifact without cached history initially fetches only the previous 30 days.
Later runs refresh through the newest cached sale plus an overlap page, allowing
coverage to accumulate naturally while pruning records older than 365 days. An
artifact whose history is lost therefore recovers from a bounded 30-day
bootstrap instead of downloading a full year. The default heartbeat is five
minutes and reports the current page, row, and acquisition-target progress.

After every artifact, the collector atomically writes local state and uploads
the artifact plus session manifest to the draft staging release. At completion
it validates and publishes the regional archive, then removes that region's
staging assets. [`scripts/collect-region.mjs`](../scripts/collect-region.mjs)
is the supported entry point; `.work/` is disposable local state after a
regional archive has been published.

## Recovery

Restart the same region after interruption. The collector restores the latest
published region through its `latest-<region>.json` pointer, verifies the
archive digest, then restores the unfinished session. It skips session-complete
artifacts and restarts only the incomplete artifact. Never publish an
incomplete regional archive as the rolling public asset.

Runs stop before GitHub's hard job timeout and retain their checkpoints for the
next scheduled or manual run. A runtime-budget stop remains a successful job
but emits a warning and workflow summary labeled **Checkpointed, will resume**;
it does not publish an incomplete archive. Matrix jobs remain sequential; a
failure in one region must not delete, replace, or prevent an update of another
region.

Network exceptions and HTTP `429` or `5xx` responses retry inside the current
job with exponential backoff. A valid API page resets the progress watchdog;
five minutes without one fails the job. No collector result creates another
workflow run.

The weekly workflow selects all five regions. Manual dispatch exposes five
default-enabled region checkboxes; unselected regions are omitted from the
matrix. After the matrix finishes, the workflow commits
[`status/last-run.json`](../status/last-run.json) with the attempted regions and
workflow result. Besides providing an operational heartbeat, this keeps the
public repository active so GitHub does not disable its scheduled workflow
after 60 inactive days. The repository must allow Actions to write Release
assets and the `main` branch.

Before collection starts, the live artifact listing must contain at least 100
items and every artifact in the previously published regional manifest. A
smaller catalog fails the run before collection or pruning, preventing a
temporary upstream listing regression from deleting cached history. An
intentional artifact removal therefore requires an explicit migration.
