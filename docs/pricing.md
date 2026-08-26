# Pricing

[`scripts/generate-pricing-index.mjs`](../scripts/generate-pricing-index.mjs)
is the single canonical artifact price estimator. It reads a validated regional
history archive without rewriting raw API records and emits one regional index.
[`scripts/merge-pricing-indexes.mjs`](../scripts/merge-pricing-indexes.mjs)
merges refreshed regions into [`data/pricing-index.json`](../data/pricing-index.json)
while preserving regions that were not refreshed.

## Eligible sales

An estimate uses completed sales from the preceding 365 days when:

- the amount is one and the price and timestamp are valid;
- rarity is `additional.qlt`, with an absent value treated as Ordinary (`0`);
- potential level is `additional.ptn`, with an absent value treated as `+0`;
- the artifact is `+0`, has no bonus properties, and has full maximum charge;
- studied and unstudied artifacts are both accepted; and
- reduced current charge is accepted because it is recoverable.

Unknown rarity values, upgraded artifacts, bonus-property artifacts, and
permanently degraded artifacts are excluded. See [Auction API](auction-api.md)
for the evidence behind these interpretations.

## Estimate and confidence

The primary estimate is a median. If at least ten eligible sales occurred in
the latest 90 days, prices receive age weights of `5` (14 days), `3` (30 days),
`2` (90 days), and `1` (365 days); otherwise the unweighted annual median is
used. The index also retains unweighted 30-, 90-, and 365-day medians.

Confidence is `high` for at least 20 eligible samples, `medium` for 5–19, and
`low` for 1–4. A missing artifact-rarity pair may be estimated from the nearest
adjacent rarity using the global median multiplier for that one boundary.
Multi-tier extrapolation is deliberately forbidden and is marked `estimated`.

The estimator's calculation rules are versioned in each index. Changes to
eligibility, weighting, confidence, or extrapolation require focused fixtures
and a pricing algorithm version increase.

## Consumer contract

The committed bundle has `schemaVersion: 1`, defaults to EU, and contains a
regional index under `regions.<region>`. Each regional index records its source
window and provenance digest. Consumers may copy the generated data into their
own deployment artifact, but must not fork the estimator silently.
