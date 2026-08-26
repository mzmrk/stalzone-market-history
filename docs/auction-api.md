# EXBO auction artifact metadata

This document defines artifact-field normalization inside the auction API's
untyped `additional` object. It combines EXBO developer explanations with matched
API-to-game offers. The formal API only documents the surrounding auction
response: <https://eapi.stalzone.com/reference>.

Request `additional=true`; otherwise `additional` is empty. Preserve raw
responses because undocumented fields may change.
Legacy calculator caches flatten `additional` fields with dotted keys such as
`additional.qlt`. Public market-history archives preserve the nested API object.
The pricing builder accepts both storage shapes and normalizes them with the
rules below.

## Normalization contract

| Field | Rule |
| --- | --- |
| `qlt` | Rarity index: `0` Ordinary, `1` Uncommon, `2` Special, `3` Rare, `4` Exclusive, `5` Legendary. Missing means `0`. |
| `stats_random` | Present means studied and locates exact quality within the rarity range. Missing means unstudied; it is an unrevealed range, not a measured midpoint. |
| `ptn` | Upgrade level shown as `+X`. Missing means `0`. |
| `bonus_properties` | Property IDs unlocked by upgrades. Exact rolled values are not exposed. |
| `upgrade_bonus` | Associated with rolled additional properties. It is neither a general base-stat multiplier nor the displayed bonus value; decoding remains unknown. |
| `ndmg` | Normalized loss of current charge. Missing means no loss. |
| `md_k` | Normalized loss of maximum charge. Missing means no loss. |
| `it_transf_count` | Auction/trade transfer count, not Freshness. Missing-value behavior is unconfirmed. |

`qlt = 6` appeared in neither one-year EU history, current EU/RU lots, nor recent
RU sales checked on 26 August 2026; treat it as unsupported. Unique index `6`
stays unpriced, so capped searches exclude it.

Studied state, level, and charge are independent; an unstudied `+0` artifact can
have reduced current or maximum charge.

Studied quality is calculated within the selected rarity tier:

```text
position = clamp((stats_random + 2) / 4, 0, 1)
quality = tier_min + (tier_max - tier_min) * position
```

Tier ranges are `85..100`, `100..115`, `115..130`, `130..145`, `145..160`,
`160..175`, and `175..190`. Clamp out-of-range `stats_random`; use `qlt`, not a
boundary percentage, as the authoritative rarity.

```text
current_charge_percent = (1 - (ndmg ?? 0)) * 100
maximum_charge_percent = (1 - (md_k ?? 0)) * 100
```

Round charge only for display.

## Unknown fields

Do not interpret `spawn_time`, `ls_rc_start`, `ls_rc_duration`,
`compens_2026_owner`, `compens_2026_ptn`, `can_delete`, or `sell_is_blocked`.
The field or rule behind the in-game Freshness level is also unknown.

## Pricing guardrails

For optimizer pricing, normalize `qlt ?? 0`; require `ptn ?? 0` to be `0`, no
`bonus_properties`, and `md_k <= 1e-6`. Studied and unstudied `+0` sales are
build-equivalent, and recoverable current-charge loss (`ndmg`) is allowed.

[`scripts/generate-pricing-index.mjs`](../scripts/generate-pricing-index.mjs)
uses one year of completed sales; recency weighting requires enough recent
same-tier samples. A missing tier is extrapolated only from a directly measured
adjacent tier of the same artifact. Multiplier chains are forbidden, so other
gaps remain unknown. Active offers and upgraded sales require validation.

Keep IDs separate. EXBO [replaced Snares with Peg-Top](https://steamcommunity.com/games/1818450/announcements/detail/523118018927001619)
on 4 March 2026: `g34p` became Peg-Top and new Snares became `rnkl`. EU/RU checks
on 25 August found no `rnkl` history or lots; keep it unknown until sales appear.
