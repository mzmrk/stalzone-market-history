# STALZONE Market History

A rolling artifact-auction archive and canonical price index for developers
building **STALZONE** market tools. It preserves data from the official STALZONE
API for EU, RU, NA, SEA, and NEA.

## Use the data

- [Download the canonical price index](https://raw.githubusercontent.com/mzmrk/stalzone-market-history/main/data/pricing-index.json)
- [Browse the price index on GitHub](data/pricing-index.json)
- [Download regional history archives](https://github.com/mzmrk/stalzone-market-history/releases/tag/market-history-latest)

Price estimates are historical completed-sale medians, not current listings or
guaranteed sale prices. See [the pricing methodology](docs/pricing.md) before
interpreting or redistributing them.

## Regional history archives

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

The canonical index is derived from validated completed sales and grouped by
artifact, rarity, and region. Each estimate includes its method, confidence,
sample count, source window, and provenance.

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
