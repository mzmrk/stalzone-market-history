# Data contract

## Regional archive

Each `latest-<region>.json` release asset names the current
`auction-history-<region>-<digest>.tar.gz`, manifest asset, and full SHA-256
digest. The regional archive contains:

```text
manifest.json
artifacts/<artifactId>.jsonl
```

Every JSONL line is one auction-history sale object. The collector preserves
the API object structure instead of flattening `additional` or adding capture
fields. Records are deduplicated, ordered newest first, and limited to the
manifest's rolling time window.

The manifest identifies the region, source endpoint, capture time, cutoff,
artifact set, record counts, acquisition page cap, and per-artifact time
coverage. Consumers must use the manifest instead of inferring completeness
from filenames.

## Compatibility

The upstream API is beta and may change without notice. A schema change that
introduces apparent personal identifiers is a publishing failure, not an
automatic extension of this contract.
