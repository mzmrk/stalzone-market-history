# Operations

## Credentials

Collection uses `STALZONE_CLIENT_ID` and `STALZONE_CLIENT_SECRET`. The secret
belongs in GitHub Actions secrets or process environment only. It must not be
written to manifests, logs, fixtures, release assets, or Git history.

## Update lifecycle

A regional session has a fixed capture timestamp and cutoff. Existing artifact
history is refreshed through the newest cached sale plus an overlap page;
missing history is fetched through the cutoff. The default heartbeat is five
minutes and reports current page, row, and rolling-window progress.

After every artifact, the collector atomically writes local state and uploads
the artifact plus session manifest to the draft staging release. At completion
it validates and publishes the regional archive, then removes that region's
staging assets.

## Recovery

Restart the same region after interruption. The collector restores the latest
published region and unfinished session, skips session-complete artifacts, and
restarts only the incomplete artifact. Never publish an incomplete regional
archive as the rolling public asset.

Runs stop before GitHub's hard job timeout and request a continuation. Regions
remain sequential; a failure in one region must not delete or replace another
region's last valid archive.

