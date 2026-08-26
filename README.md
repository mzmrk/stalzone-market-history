# STALZONE Market History

A rolling, machine-readable archive of artifact auction history from the
official STALZONE API. The dataset covers EU, RU, NA, SEA, and NEA and is
published as compressed GitHub Release assets.

## Data

The rolling release provides a `latest-<region>.json` pointer for each region.
It names the current content-addressed archive, manifest, and SHA-256 digest:

```text
latest-eu.json
auction-history-eu-<digest>.tar.gz
manifest-eu-<digest>.json
auction-history-eu-<digest>.sha256
```

Each archive contains a manifest and one JSON Lines file per artifact. Sale
objects are preserved as returned by the API; collection metadata is kept in
the manifest.

See [the data contract](docs/data-contract.md) before consuming the archive.

## Development

Node.js 22 or newer is required.

```bash
npm test
npm run docs:check
```

The collection scripts require an approved STALZONE API application. Never
commit its client secret.

## Legal

Repository software is licensed under the [MIT License](LICENSE). API data is
not relicensed under MIT; see [DATA-NOTICE.md](DATA-NOTICE.md).
