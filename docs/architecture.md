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

Published archives, manifests, and commit markers use immutable names whose
UTC timestamp is the final filename component. Data uploads and SHA-256
verification finish before the marker is uploaded. Restore validates markers
newest-to-oldest and falls back when a newer generation is incomplete or
damaged. Cleanup retains the newest and preceding valid generations, removes
obsolete markers first, then deletes only data no retained marker references.

After regional collection jobs finish, the workflow resolves the newest valid
stable marker, verifies its archive digest, runs the canonical estimator, and
commits the merged price index with the operational status. A region without a
valid committed generation retains its prior index.

Collectors process one region at a time to avoid competing for the shared API
rate limit. Each completed artifact is uploaded under an immutable name and
verified before a timestamped session marker commits the complete checkpoint
map. Restore never mixes revisions: it uses the newest marker whose referenced
artifact digests all validate, otherwise the preceding valid revision. An
interrupted current artifact may be downloaded again.

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
