# Operations

## Credentials

Collection uses `STALZONE_CLIENT_ID` and `STALZONE_CLIENT_SECRET`. The secret
belongs in GitHub Actions secrets or process environment only. It must not be
written to manifests, logs, fixtures, release assets, or Git history.

## Update lifecycle

A regional session has a fixed capture timestamp and cutoff. Existing artifact
history is refreshed through the newest cached sale plus an overlap page;
missing history is fetched through the cutoff. The default heartbeat is five
minutes and reports current page, row, and rolling-window progress. Automated
runs currently cap acquisition at three API pages per artifact; manifests
record this cap so consumers can distinguish it from exhaustive history.

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

Runs stop before GitHub's hard job timeout and request a continuation. Regions
remain sequential; a failure in one region must not delete or replace another
region's last valid archive.

The weekly workflow starts with EU. An incomplete run dispatches itself for the
same region; a complete run dispatches the next region. The repository must
allow Actions to create workflow runs and write Release assets.
