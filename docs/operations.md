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

After every artifact, the collector atomically writes local state, uploads and
verifies an immutable compressed artifact, then commits a session marker that
references every completed artifact by filename and digest. It retains the
current and previous valid checkpoint revisions. At completion it commits the
regional archive with the same marker-last protocol, then removes that region's
staging assets. [`scripts/collect-region.mjs`](../scripts/collect-region.mjs) is
the supported entry point; `.work/` is disposable after publication.

After collection, `pricing:published` downloads only committed stable regional
archives, verifies their marker SHA-256 digests, rebuilds available regional
estimates, and preserves prior estimates for unavailable regions. The final
workflow commit includes both [`data/pricing-index.json`](../data/pricing-index.json)
and the operational status.

## Recovery

Restart the same region after interruption. The collector validates stable and
staging markers newest-to-oldest, restores the newest complete referenced set,
checks that the archive is structurally complete and contains the exact
published manifest, and falls back to the preceding valid generation when
necessary. It skips session-complete artifacts and restarts only the incomplete
artifact. Conflicting valid markers at the same generation or session revision
fail visibly rather than guessing. Never publish an incomplete regional archive.

All release uploads use unique names and never use `--clobber`. Cleanup begins
only after the new marker and its references can be restored independently. It
deletes obsolete markers before unreferenced data, so interruption can leave
harmless orphan assets but cannot invalidate a retained generation.

Runs stop before GitHub's hard job timeout and retain their checkpoints for the
next scheduled or manual run. A runtime-budget stop remains a successful job
but emits a warning and workflow summary labeled **Checkpointed, will resume**;
it does not publish an incomplete archive. Matrix jobs remain sequential; a
failure in one region must not delete, replace, or prevent an update of another
region.

Auction-page network exceptions and HTTP `429` or `5xx` responses retry inside
the current job with exponential backoff. Release-asset deletion also uses
bounded exponential retries; a missing asset is treated as already deleted so a
lost successful response remains idempotent. A persistent cleanup failure still
fails the region after its latest marker is safely committed. A valid API page
resets the progress watchdog; five minutes without one fails the job. No
collector result creates another workflow run.

The weekly workflow selects all five regions. Manual dispatch exposes five
default-enabled region checkboxes; unselected regions are omitted from the
matrix. After the matrix finishes, the workflow commits the merged price index
and [`status/last-run.json`](../status/last-run.json) with the attempted regions
and workflow result. Besides providing an operational heartbeat, this keeps the
public repository active so GitHub does not disable its scheduled workflow
after 60 inactive days. The repository must allow Actions to write Release
assets and the `main` branch.

Before collection starts, the live artifact listing must contain at least 100
items and every artifact in the previously published regional manifest. A
smaller catalog fails the run before collection or pruning, preventing a
temporary upstream listing regression from deleting cached history. An
intentional artifact removal therefore requires an explicit migration.
