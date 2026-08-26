# Architecture

## Scope

This repository owns acquisition and public archival of rolling STALZONE
artifact auction history, plus the canonical artifact price estimator derived
from that history. It does not own calculator behavior or browser deployment.

## Persistence model

The Git repository contains code, documentation, and a small operational status
record. Large data is stored as GitHub Release assets:

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

The workflow creates one matrix job for every selected region and permits only
one to run at a time. Scheduled runs select all regions; manual runs expose one
default-enabled checkbox per region. `fail-fast: false` isolates failures, so
one regional job does not cancel the remaining matrix jobs.

## Consumer boundary

Public consumers may download complete regional archives or consume the merged
[`data/pricing-index.json`](../data/pricing-index.json). Staging assets are an
internal recovery mechanism and are not a stable data interface. Downstream
applications must not independently reinterpret auction history when they need
the canonical estimates; they should validate and bundle the published index.
