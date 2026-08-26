import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizePricingRegion } from "./pricing-regions.mjs";

const execFileAsync = promisify(execFile);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const region = normalizePricingRegion(process.argv[2] ?? "eu");
const requestedSnapshot = process.argv[3];
const requestedOutput = process.argv[4];
const rarityNames = ["Ordinary", "Uncommon", "Special", "Rare", "Exclusive", "Legendary"];
const windowDays = 365;
const recentWindowDays = 90;
const recencyBoostThreshold = 10;
const tolerance = 1e-6;
const pricingAlgorithmVersion = 2;

const outputFile = requestedOutput
  ? path.resolve(projectRoot, requestedOutput)
  : path.join(projectRoot, "data", "pricing", "generated", `pricing-index-${region}.json`);

const cleanupDirectories = [];
const globalAdjacentRatios = [];
const snapshot = await resolveSnapshot(region, requestedSnapshot, cleanupDirectories);
const snapshotDirectory = snapshot.directory;
try {
  const manifest = await readOptionalJson(path.join(snapshotDirectory, "manifest.json"));
  const manifestSha256 = await hashOptionalFile(path.join(snapshotDirectory, "manifest.json"));
  const recordsByArtifact = await readHistoryRecords(snapshotDirectory);
  const allSales = [...recordsByArtifact.values()].flat();
  const asOf = determineAsOf(manifest, allSales);
  const cutoff = asOf - windowDays * 24 * 60 * 60 * 1000;

  const realEstimates = {};

  for (const [artifactId, sales] of recordsByArtifact) {
    realEstimates[artifactId] = {};
    for (let rarityIndex = 0; rarityIndex <= 5; rarityIndex += 1) {
      const eligibleSales = sales.filter(
        (sale) =>
          sale.rarityIndex === rarityIndex &&
          sale.soldAt >= cutoff &&
          sale.soldAt <= asOf &&
          isBuildEquivalent(sale),
      );
      const estimate = estimateFromEligibleSales(eligibleSales, asOf);
      if (estimate) realEstimates[artifactId][rarityIndex] = estimate;
    }
  }

  for (let rarityIndex = 0; rarityIndex < 5; rarityIndex += 1) {
    const ratios = Object.values(realEstimates)
      .map((artifact) => {
        const lower = artifact[rarityIndex]?.median;
        const higher = artifact[rarityIndex + 1]?.median;
        return lower > 0 && higher > 0 ? higher / lower : null;
      })
      .filter((ratio) => ratio !== null)
      .sort((left, right) => left - right);
    globalAdjacentRatios[rarityIndex] = {
      from: rarityIndex,
      fromName: rarityNames[rarityIndex],
      to: rarityIndex + 1,
      toName: rarityNames[rarityIndex + 1],
      medianMultiplier: median(ratios),
      samples: ratios.length,
    };
  }

  const artifacts = {};
  for (const artifactId of [...recordsByArtifact.keys()].sort()) {
    artifacts[artifactId] = {};
    for (let rarityIndex = 0; rarityIndex <= 5; rarityIndex += 1) {
      artifacts[artifactId][rarityIndex] =
        realEstimates[artifactId]?.[rarityIndex] ??
        estimateFromAdjacentRarity(realEstimates[artifactId] ?? {}, rarityIndex);
    }
    for (const rarityIndex of Object.keys(artifacts[artifactId])) {
      if (!artifacts[artifactId][rarityIndex]) delete artifacts[artifactId][rarityIndex];
    }
  }

  const output = {
    region,
    snapshot: manifest?.sourceSnapshot
      ? path.basename(manifest.sourceSnapshot)
      : snapshot.label,
    generatedAt: new Date(asOf).toISOString(),
    provenance: {
      pricingAlgorithmVersion,
      cacheSha256: snapshot.sha256,
      manifestSha256,
      sourceManifest: manifest
        ? {
            schemaVersion: manifest.schemaVersion ?? null,
            region: manifest.region ?? null,
            capturedAt: manifest.capturedAt ?? null,
            initialBackfillDays: manifest.initialBackfillDays ?? null,
            asOf: manifest.asOf ?? null,
            cutoff: manifest.cutoff ?? null,
            windowDays: manifest.windowDays ?? null,
            artifactCount: manifest.artifactCount ?? null,
            recordCount: manifest.recordCount ?? null,
          }
        : null,
    },
    sourceWindow: {
      asOf: new Date(asOf).toISOString(),
      cutoff: new Date(cutoff).toISOString(),
      days: windowDays,
    },
    method:
      "recency-weighted median of build-equivalent completed sales; single-step adjacent-rarity extrapolation for missing rarity tiers",
    rules: {
      buildEquivalent:
        "+0, no bonus properties, full maximum charge; researched and unstudied sales are both eligible; current charge loss is allowed",
      recencyWeights: [
        { maxAgeDays: 14, weight: 5 },
        { maxAgeDays: 30, weight: 3 },
        { maxAgeDays: 90, weight: 2 },
        { maxAgeDays: 365, weight: 1 },
      ],
      recencyBoostThreshold,
      extrapolationMaxDistance: 1,
      confidence: {
        high: ">= 20 eligible samples",
        medium: "5-19 eligible samples",
        low: "1-4 eligible samples",
        estimated: "adjacent-rarity extrapolation",
      },
    },
    adjacentRarityMultipliers: globalAdjacentRatios,
    artifacts,
  };

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Generated ${path.relative(projectRoot, outputFile)} from ${recordsByArtifact.size} artifact histories.`,
  );
} finally {
  for (const directory of cleanupDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function resolveSnapshot(regionName, requested, cleanup) {
  if (requested) {
    const explicit = path.resolve(projectRoot, requested);
    if (await exists(explicit)) return resolveExplicitInput(explicit, cleanup);
  }

  const cacheArchive = path.join(projectRoot, ".work", "output", `auction-history-${regionName}.tar.gz`);
  if (await exists(cacheArchive)) return resolveExplicitInput(cacheArchive, cleanup);

  throw new Error(
    `Published history archive not found for region ${regionName}. Pass an explicit archive or extracted history directory.`,
  );
}

async function resolveExplicitInput(explicit, cleanup) {
  const explicitStat = await stat(explicit);
  if (explicitStat.isDirectory()) {
    if (await exists(path.join(explicit, "artifacts"))) {
      return { directory: explicit, label: path.basename(explicit), sha256: await hashCacheDirectory(explicit) };
    }
    throw new Error(`Pricing input is not a cache directory: ${path.relative(projectRoot, explicit)}`);
  }
  if (explicitStat.isFile() && explicit.endsWith(".tar.gz")) {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), "field-kit-pricing-cache-"));
    cleanup.push(tempDirectory);
    await execFileAsync("tar", ["-xzf", explicit, "-C", tempDirectory]);
    if (!(await exists(path.join(tempDirectory, "artifacts")))) {
      throw new Error(`Pricing cache archive does not contain artifacts/: ${path.relative(projectRoot, explicit)}`);
    }
    return { directory: tempDirectory, label: path.basename(explicit), sha256: await hashFile(explicit) };
  }
  throw new Error(`Unsupported pricing cache input: ${path.relative(projectRoot, explicit)}`);
}

async function hashCacheDirectory(directory) {
  const hash = createHash("sha256");
  const files = (await exists(path.join(directory, "manifest.json"))) ? ["manifest.json"] : [];
  const artifactEntries = await readdir(path.join(directory, "artifacts"), { withFileTypes: true });
  files.push(
    ...artifactEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.posix.join("artifacts", entry.name))
      .sort(),
  );
  for (const relativeFile of files) {
    hash.update(relativeFile);
    hash.update("\0");
    hash.update(await readFile(path.join(directory, relativeFile)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function hashOptionalFile(file) {
  return (await exists(file)) ? hashFile(file) : null;
}

async function readHistoryRecords(directory) {
  const artifactsDirectory = path.join(directory, "artifacts");
  if (!(await exists(artifactsDirectory))) {
    throw new Error(`Pricing cache directory must contain artifacts/: ${path.relative(projectRoot, directory)}`);
  }
  return readCacheRecords(artifactsDirectory);
}

async function readCacheRecords(artifactsDirectory) {
  const records = new Map();
  const files = (await readdir(artifactsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();

  for (const file of files) {
    const artifactId = file.slice(0, -6);
    const lines = (await readFile(path.join(artifactsDirectory, file), "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const sales = [];
    for (const line of lines) {
      const sale = normalizeSale(unflattenCacheRow(JSON.parse(line)));
      if (sale) sales.push(sale);
    }
    records.set(artifactId, dedupeSales(sales));
  }

  return records;
}

function dedupeSales(sales) {
  const seen = new Set();
  const deduped = [];
  for (const sale of sales.sort(compareSales)) {
    const key = stableStringify({
      additional: sale.additional,
      price: sale.price,
      rarityIndex: sale.rarityIndex,
      soldAt: sale.soldAt,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sale);
  }
  return deduped;
}

function compareSales(left, right) {
  return right.soldAt - left.soldAt || left.price - right.price;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function unflattenCacheRow(row) {
  const raw = {};
  const additional =
    row.additional && typeof row.additional === "object" && !Array.isArray(row.additional)
      ? { ...row.additional }
      : {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "additional") {
      continue;
    } else if (key.startsWith("additional.")) {
      additional[key.slice("additional.".length)] = value;
    } else {
      raw[key] = value;
    }
  }
  raw.additional = additional;
  return raw;
}

function normalizeSale(raw) {
  const additional = raw.additional && typeof raw.additional === "object" ? raw.additional : {};
  const price = Number(raw.price ?? raw.buyoutPrice ?? raw.buyout_price);
  const soldAt = Date.parse(raw.time ?? raw.closedAt ?? raw.endTime ?? raw.end_time ?? raw.date ?? "");
  const rarityIndex = additional.qlt ?? 0;

  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(soldAt)) return null;
  if (!Number.isInteger(rarityIndex) || rarityIndex < 0 || rarityIndex > 5) return null;
  if ((raw.amount ?? 1) !== 1) return null;

  return { additional, price, rarityIndex, soldAt };
}

function isBuildEquivalent(sale) {
  const additional = sale.additional;
  const level = additional.ptn ?? 0;
  const bonusProperties = Array.isArray(additional.bonus_properties)
    ? additional.bonus_properties.length
    : 0;
  return level === 0 && bonusProperties === 0 && Number(additional.md_k ?? 0) <= tolerance;
}

function estimateFromEligibleSales(sales, asOfMs) {
  if (sales.length === 0) return null;

  const recent90Samples = sales.filter((sale) => daysOld(sale, asOfMs) <= recentWindowDays).length;
  const recent30Sales = sales.filter((sale) => daysOld(sale, asOfMs) <= 30);
  const recent90Sales = sales.filter((sale) => daysOld(sale, asOfMs) <= recentWindowDays);
  const weighted = recent90Samples >= recencyBoostThreshold;
  const sortedPrices = sales.map((sale) => sale.price).sort((left, right) => left - right);
  const medianPrice = weighted
    ? weightedMedian(
        sales.map((sale) => ({
          price: sale.price,
          weight: recencyWeight(daysOld(sale, asOfMs)),
        })),
      )
    : median(sortedPrices);

  return {
    median: medianPrice,
    samples: sales.length,
    recent90Samples,
    recent30Median: median(recent30Sales.map((sale) => sale.price).sort((left, right) => left - right)),
    recent90Median: median(recent90Sales.map((sale) => sale.price).sort((left, right) => left - right)),
    recent365Median: median(sortedPrices),
    condition: "build-equivalent",
    confidence: confidenceForSamples(sales.length),
    weighted,
    windowDays,
  };
}

function estimateFromAdjacentRarity(artifactEstimates, targetRarity) {
  const anchors = Object.entries(artifactEstimates)
    .map(([rarityIndex, estimate]) => ({
      rarityIndex: Number(rarityIndex),
      estimate,
      distance: Math.abs(Number(rarityIndex) - targetRarity),
    }))
    .filter((anchor) => anchor.distance === 1 && anchor.estimate?.median > 0)
    .sort((left, right) => left.distance - right.distance);

  const anchor = anchors[0];
  if (!anchor) return null;

  const multiplier = adjacentMultiplier(anchor.rarityIndex, targetRarity);
  if (!(multiplier > 0)) return null;

  return {
    median: anchor.estimate.median * multiplier,
    samples: 0,
    recent90Samples: 0,
    condition: "adjacent-extrapolated",
    confidence: "estimated",
    weighted: false,
    windowDays,
    anchorRarity: anchor.rarityIndex,
    anchorRarityName: rarityNames[anchor.rarityIndex],
    anchorPrice: anchor.estimate.median,
    multiplier,
  };
}

function adjacentMultiplier(fromRarity, toRarity) {
  if (Math.abs(toRarity - fromRarity) !== 1) return null;
  const boundary = Math.min(fromRarity, toRarity);
  const step = globalAdjacentRatios[boundary]?.medianMultiplier;
  if (!(step > 0)) return null;
  return toRarity > fromRarity ? step : 1 / step;
}

function confidenceForSamples(samples) {
  if (samples >= 20) return "high";
  if (samples >= 5) return "medium";
  return "low";
}

function recencyWeight(ageDays) {
  if (ageDays <= 14) return 5;
  if (ageDays <= 30) return 3;
  if (ageDays <= 90) return 2;
  return 1;
}

function daysOld(sale, asOfMs) {
  return (asOfMs - sale.soldAt) / (24 * 60 * 60 * 1000);
}

function determineAsOf(snapshotManifest, sales) {
  const manifestDate = Date.parse(
    snapshotManifest?.asOf ??
      snapshotManifest?.capturedAt ??
      snapshotManifest?.extendsHistoryCapturedAt ??
      "",
  );
  if (Number.isFinite(manifestDate)) return manifestDate;
  let latestSale = Number.NEGATIVE_INFINITY;
  for (const sale of sales) {
    if (sale.soldAt > latestSale) latestSale = sale.soldAt;
  }
  if (Number.isFinite(latestSale)) return latestSale;
  return Date.now();
}

function median(values) {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function weightedMedian(values) {
  const sorted = values
    .filter((value) => value.price > 0 && value.weight > 0)
    .sort((left, right) => left.price - right.price);
  const totalWeight = sorted.reduce((total, value) => total + value.weight, 0);
  let accumulatedWeight = 0;

  for (const value of sorted) {
    accumulatedWeight += value.weight;
    if (accumulatedWeight >= totalWeight / 2) return value.price;
  }
  return null;
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
