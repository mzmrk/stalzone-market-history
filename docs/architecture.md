# Architecture

## Scope

This repository owns acquisition and public archival of rolling STALZONE
artifact auction history. It does not own calculator-specific price estimation
or browser deployment.

## Persistence model

The Git repository contains code and documentation only. Large data is stored
as GitHub Release assets:

- The `market-history-staging` draft release stores resumable, per-artifact
  checkpoints through [`scripts/github-releases.mjs`](../scripts/github-releases.mjs).
- The `market-history-latest` rolling release stores validated, complete
  regional archives built by [`scripts/archive.mjs`](../scripts/archive.mjs).

Published archives use digest-versioned names. The collector uploads and
downloads the new archive to verify its SHA-256 digest before replacing the
small `latest-<region>.json` pointer or removing the previous regional assets.
This prevents a failed replacement from destroying the last usable archive.

Collectors process one region at a time to avoid competing for the shared API
rate limit. Each completed artifact is checkpointed before the next artifact
starts. An interrupted artifact may be downloaded again; previously completed
artifacts in the same update session are skipped.

The workflow creates one matrix job for every planned region and permits only
one to run at a time. Scheduled runs select all regions; manual runs offer an
`all`, EU, RU, NA, SEA, or NEA selector with `all` as the default. `fail-fast:
false` isolates failures, so one regional job does not cancel the remaining
matrix jobs.

## Consumer boundary

Public consumers download complete regional archives. Staging assets are an
internal recovery mechanism and are not a stable data interface. Downstream
applications derive their own indexes from published archives rather than
depending on the collector workspace.
