import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildPublishedPrices } from "../scripts/build-published-prices.mjs";
import { mergePricingIndexes } from "../scripts/merge-pricing-indexes.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

test("pricing estimator accepts raw API records and applies the established eligibility rules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "market-pricing-test-"));
  const artifacts = path.join(root, "artifacts");
  const output = path.join(root, "pricing-eu.json");
  await mkdir(artifacts);
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, region: "eu", capturedAt: "2026-08-01T00:00:00.000Z" })}\n`,
  );
  await writeFile(
    path.join(artifacts, "alpha.jsonl"),
    [
      sale("2026-07-30T00:00:00.000Z", 100),
      sale("2026-07-29T00:00:00.000Z", 200),
      sale("2026-07-28T00:00:00.000Z", 999, { ptn: 5 }),
      sale("2026-07-27T00:00:00.000Z", 999, { md_k: 0.1 }),
      sale("2026-07-26T00:00:00.000Z", 999, { bonus_properties: ["x"] }),
      sale("2026-07-25T00:00:00.000Z", 999, { qlt: 7 }),
    ].map(JSON.stringify).join("\n") + "\n",
  );
  await writeFile(
    path.join(artifacts, "beta.jsonl"),
    `${JSON.stringify(sale("2026-07-30T00:00:00.000Z", 200, { qlt: 1 }))}\n`,
  );
  await writeFile(
    path.join(artifacts, "calibration.jsonl"),
    [
      sale("2026-07-30T00:00:00.000Z", 100),
      sale("2026-07-30T00:00:00.000Z", 200, { qlt: 1 }),
    ].map(JSON.stringify).join("\n") + "\n",
  );

  await execFileAsync("node", [
    "scripts/generate-pricing-index.mjs",
    "eu",
    root,
    output,
  ], { cwd: projectRoot });

  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.artifacts.alpha[0].median, 150);
  assert.equal(result.artifacts.alpha[0].samples, 2);
  assert.equal(result.artifacts.alpha[1].median, 300);
  assert.equal(result.artifacts.alpha[1].confidence, "estimated");
  assert.equal(result.artifacts.alpha[1].anchorRarity, 0);
  assert.equal(result.artifacts.beta[0].median, 100);
  assert.equal(result.artifacts.beta[0].confidence, "estimated");
  assert.equal(result.provenance.sourceManifest.capturedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(result.snapshot, path.basename(root));
});

test("pricing merge replaces refreshed regions and preserves the others", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "market-pricing-merge-"));
  const output = path.join(root, "pricing-index.json");
  const refreshed = path.join(root, "ru.json");
  await writeFile(output, `${JSON.stringify(bundle(regionalIndex("eu", 100)))}\n`);
  await writeFile(refreshed, `${JSON.stringify(regionalIndex("ru", 200))}\n`);

  const result = await mergePricingIndexes({ outputFile: output, inputFiles: [refreshed] });

  assert.equal(result.regions.eu.artifacts.alpha[0].median, 100);
  assert.equal(result.regions.ru.artifacts.alpha[0].median, 200);
});

test("published pricing verifies the stable archive and preserves regions not rebuilt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "market-pricing-published-"));
  const output = path.join(root, "pricing-index.json");
  const archive = path.join(root, "auction-history-ru-123456789abc.tar.gz");
  await writeFile(archive, "verified archive fixture");
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  const pointer = path.join(root, "latest-ru.json");
  await writeFile(pointer, `${JSON.stringify({
    schemaVersion: 1,
    region: "ru",
    archive: path.basename(archive),
    sha256,
  })}\n`);
  await writeFile(output, `${JSON.stringify(bundle(regionalIndex("eu", 100)))}\n`);
  const assets = new Map([[path.basename(archive), archive], [path.basename(pointer), pointer]]);
  const store = {
    stableTag: "market-history-latest",
    async releaseExists() { return true; },
    async download(_tag, name, destination) {
      const source = assets.get(name);
      if (!source) return false;
      await copyFile(source, path.join(destination, name));
      return true;
    },
  };

  const refreshed = await buildPublishedPrices({
    repository: "owner/repository",
    outputFile: output,
    regions: ["ru", "na"],
    store,
    async generateIndex({ outputFile: regionalOutput, region }) {
      await writeFile(regionalOutput, `${JSON.stringify(regionalIndex(region, 200))}\n`);
    },
  });
  const result = JSON.parse(await readFile(output, "utf8"));

  assert.deepEqual(refreshed, ["ru"]);
  assert.equal(result.regions.eu.artifacts.alpha[0].median, 100);
  assert.equal(result.regions.ru.artifacts.alpha[0].median, 200);
  assert.equal(result.regions.na, undefined);
});

function sale(endTime, price, additional = {}) {
  return { amount: 1, buyoutPrice: price, endTime, additional };
}

function regionalIndex(region, median) {
  return {
    region,
    sourceWindow: { asOf: "2026-08-01T00:00:00.000Z" },
    artifacts: { alpha: { 0: { median } } },
  };
}

function bundle(index) {
  return { schemaVersion: 1, defaultRegion: "eu", regions: { [index.region]: index } };
}
