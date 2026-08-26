# Architecture

## Scope

This repository owns acquisition and public archival of rolling STALZONE
artifact auction history. It does not own calculator-specific price estimation
or browser deployment.

## Persistence model

The Git repository contains code and documentation only. Large data is stored
as GitHub Release assets:

- A draft staging release stores resumable, per-artifact checkpoints.
- A published rolling release stores validated, complete regional archives.

Collectors process one region at a time to avoid competing for the shared API
rate limit. Each completed artifact is checkpointed before the next artifact
starts. An interrupted artifact may be downloaded again; previously completed
artifacts in the same update session are skipped.

## Consumer boundary

Public consumers download complete regional archives. Staging assets are an
internal recovery mechanism and are not a stable data interface. Downstream
applications derive their own indexes from published archives rather than
depending on the collector workspace.

