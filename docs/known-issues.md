# Known issues

## Release asset replacement is not atomic

Staging checkpoints and fixed `latest-<region>.json` pointers are replaced with
`gh release upload --clobber` in
[`scripts/github-releases.mjs`](../scripts/github-releases.mjs). GitHub deletes
the existing asset before uploading its replacement, so interruption during
that interval can remove a checkpoint or pointer. The versioned regional
archive remains intact, and a later run normally repairs the missing state, but
it may need to repeat collection or bootstrap restoration.

This is accepted for now. The intended remedy is immutable, uniquely named
checkpoint and publication generations: upload data, verify it, upload a marker
that references exact asset names and digests, then clean older generations.
Restore must select the newest marker whose referenced assets validate.
