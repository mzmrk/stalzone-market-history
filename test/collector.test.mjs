import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectRegion, fetchHistoryRows, validateAuctionRecord } from "../scripts/collector.mjs";

const credentials = { clientId: "test", clientSecret: "secret" };

test("history acquisition preserves nested API records unchanged", async () => {
  const raw = {
    amount: 1,
    price: 125000,
    time: "2026-08-25T12:00:00.000Z",
    additional: { qlt: 2, stats_random: -0.25 },
  };
  const rows = await fetchHistoryRows({
    artifactId: "alpha",
    cutoff: Date.parse("2025-08-26T00:00:00.000Z"),
    credentials,
    fetchImpl: async () => response({ total: 1, prices: [raw] }),
    newestExistingSale: Number.NEGATIVE_INFINITY,
    pageLimit: 200,
    region: "eu",
  });

  assert.deepEqual(rows, [raw]);
  assert.deepEqual(rows[0].additional, { qlt: 2, stats_random: -0.25 });
});

test("history acquisition retries a throttled page", async () => {
  let attempts = 0;
  const rows = await fetchHistoryRows({
    artifactId: "alpha",
    cutoff: Date.parse("2025-08-26T00:00:00.000Z"),
    credentials,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return response({ message: "rate limited" }, { status: 429, headers: { "retry-after": "0" } });
      }
      return response({ total: 1, prices: [{ price: 1, time: "2026-08-25T00:00:00.000Z" }] });
    },
    newestExistingSale: Number.NEGATIVE_INFINITY,
    pageLimit: 200,
    region: "eu",
    requestDelay: async () => {},
  });

  assert.equal(attempts, 2);
  assert.equal(rows.length, 1);
});

test("history acquisition respects the configured per-artifact page cap", async () => {
  let requests = 0;
  const rows = await fetchHistoryRows({
    artifactId: "alpha",
    cutoff: Date.parse("2025-08-26T00:00:00.000Z"),
    credentials,
    fetchImpl: async () => {
      requests += 1;
      return response({
        total: 1_000,
        prices: [{ price: requests, time: `2026-08-${26 - requests}T00:00:00.000Z` }],
      });
    },
    maxPages: 3,
    newestExistingSale: Number.NEGATIVE_INFINITY,
    pageLimit: 1,
    region: "eu",
  });

  assert.equal(requests, 3);
  assert.equal(rows.length, 3);
});

test("soft runtime expiration abandons the partial artifact", async () => {
  await assert.rejects(
    fetchHistoryRows({
      artifactId: "alpha",
      cutoff: Date.parse("2025-08-26T00:00:00.000Z"),
      credentials,
      fetchImpl: async () =>
        response({ total: 2, prices: [{ price: 1, time: "2026-08-25T00:00:00.000Z" }] }),
      newestExistingSale: Number.NEGATIVE_INFINITY,
      pageLimit: 1,
      region: "eu",
      shouldStop: () => true,
    }),
    /soft runtime budget reached/,
  );
});

test("a resumed session skips completed artifacts and continues with the missing one", async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), "market-history-test-"));
  let clock = Date.parse("2026-08-26T00:00:00.000Z");
  const requestedArtifacts = [];
  const checkpoints = [];
  const fetchImpl = createFetch({
    histories: {
      alpha: [{ price: 100, time: "2026-08-25T00:00:00.000Z", additional: { qlt: 0 } }],
      beta: [{ price: 200, time: "2026-08-24T00:00:00.000Z", additional: { qlt: 1 } }],
    },
    onHistory: (artifactId) => requestedArtifacts.push(artifactId),
  });

  try {
    const first = await collectRegion({
      capturedAt: new Date(clock),
      checkpoint: async ({ artifactId }) => {
        checkpoints.push(artifactId);
        if (artifactId === "alpha") clock += 10_000;
      },
      credentials,
      fetchImpl,
      heartbeatMs: 60_000,
      listingUrl: "https://example.test/listing.json",
      log: () => {},
      maxRuntimeMs: 5_000,
      now: () => clock,
      pageLimit: 200,
      progressEvery: 1,
      region: "eu",
      workRoot,
      windowDays: 365,
    });
    assert.equal(first.complete, false);
    assert.equal(first.reason, "time-budget");
    assert.equal(first.completedArtifacts, 1);

    const second = await collectRegion({
      capturedAt: new Date(clock),
      checkpoint: async ({ artifactId }) => checkpoints.push(artifactId),
      credentials,
      fetchImpl,
      heartbeatMs: 60_000,
      listingUrl: "https://example.test/listing.json",
      log: () => {},
      now: () => clock,
      pageLimit: 200,
      progressEvery: 1,
      region: "eu",
      workRoot,
      windowDays: 365,
    });

    assert.equal(second.complete, true);
    assert.deepEqual(requestedArtifacts, ["alpha", "beta"]);
    assert.deepEqual(second.manifest.artifacts.alpha.records, 1);
    assert.deepEqual(second.manifest.artifacts.beta.records, 1);
    const alpha = JSON.parse(
      (await readFile(path.join(workRoot, "eu", "artifacts", "alpha.jsonl"), "utf8")).trim(),
    );
    assert.deepEqual(alpha.additional, { qlt: 0 });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("publishing fails closed when an auction record contains a personal identifier", () => {
  assert.throws(
    () => validateAuctionRecord({ price: 10, time: "2026-08-25T00:00:00Z", seller_id: "player-1" }),
    /blocked personal identifier field: seller_id/,
  );
});

function createFetch({ histories, onHistory }) {
  return async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "example.test") {
      return response([
        { data: "/items/artefact/alpha.json" },
        { data: "/items/artefact/beta.json" },
      ]);
    }
    const artifactId = url.pathname.match(/\/auction\/([^/]+)\/history$/)?.[1];
    onHistory(artifactId);
    const prices = histories[artifactId] ?? [];
    return response({ total: prices.length, prices });
  };
}

function response(value, init) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}
