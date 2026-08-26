# Data contract

## Regional archive

Each `generation-<region>-<digest>-<timestamp>.json` release marker commits one
immutable regional archive and manifest by exact filename and full SHA-256
digest. The marker records a monotonically increasing generation, its preceding
marker, region, and capture timestamp. The timestamp is fixed-width UTC
`YYYYMMDDTHHMMSSsssZ` and is always the final filename component before the
extension. The regional archive contains:

```text
manifest.json
artifacts/<artifactId>.jsonl
```

Every JSONL line is one auction-history sale object. The collector preserves
the API object structure instead of flattening `additional` or adding capture
fields. Records are deduplicated, ordered newest first, and limited to the
manifest's rolling time window.

The manifest identifies the region, source endpoint, capture time, retention
cutoff, initial backfill period, artifact set, record counts, acquisition page
cap, and per-artifact time coverage. Consumers must use the manifest instead
of inferring completeness from filenames.

Consumers list regional generation markers, order them by the internal
generation and `createdAt`, and use the newest marker whose archive and manifest
both exist and match their digests. The archive must also pass structural
validation, and its embedded `manifest.json` must exactly match the separately
published manifest. Filename timestamps aid inspection and cleanup but are not
proof of validity. The rolling release retains the current and previous valid
generations. Two valid markers claiming the same generation are an error; a
consumer must not choose between them implicitly.

## Compatibility

The upstream API is beta and may change without notice. A schema change that
introduces apparent personal identifiers is a publishing failure, not an
automatic extension of this contract.
