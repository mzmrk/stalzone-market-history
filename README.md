# STALZONE Market History

A rolling, machine-readable archive of artifact auction history from the
official STALZONE API. The dataset covers EU, RU, NA, SEA, and NEA and is
published as compressed GitHub Release assets.

## Data

The rolling release provides immutable, timestamped generations. Consumers
select the highest valid generation marker and verify its referenced digests:

```text
generation-eu-<digest>-<timestamp>.json
auction-history-eu-<digest>-<timestamp>.tar.gz
manifest-eu-<digest>-<timestamp>.json
```

Each archive contains a manifest and one JSON Lines file per artifact. Sale
objects are preserved as returned by the API; collection metadata is kept in
the manifest.

The newest and immediately preceding valid generations are retained for
rollback. See [the data contract](docs/data-contract.md) before consuming them.

## Price estimates

The repository also publishes a canonical price index derived from validated
completed sales across EU, RU, NA, SEA, and NEA. Estimates are grouped by
artifact and rarity and include their method, confidence, sample count, source
window, and provenance.

- [View the price index on GitHub](data/pricing-index.json)
- [Download the raw JSON](https://raw.githubusercontent.com/mzmrk/stalzone-market-history/main/data/pricing-index.json)

The index contains historical estimates, not current listings or guaranteed
sale prices. See [the pricing methodology](docs/pricing.md) before interpreting
or redistributing estimates.

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
