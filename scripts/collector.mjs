import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const dayMs = 24 * 60 * 60 * 1000;
const personalKeys = new Set([
  "account",
  "account_id",
  "buyer",
  "buyer_id",
  "character",
  "character_id",
  "display_login",
  "email",
  "ip",
  "ip_address",
  "login",
  "phone",
  "seller",
  "seller_id",
  "user",
  "user_id",
]);

export async function collectRegion({
  capturedAt = new Date(),
  checkpoint = async () => {},
  credentials,
  fetchImpl,
  heartbeatMs = 300_000,
  listingUrl,
  log = console.log,
  maxRuntimeMs = Number.POSITIVE_INFINITY,
  maxPagesPerArtifact = Number.POSITIVE_INFINITY,
  now = () => Date.now(),
  pageLimit = 200,
  progressEvery = 1,
  region,
  workRoot,
  windowDays = 365,
}) {
  const startedAt = now();
  const recordedMaxPages = Number.isFinite(maxPagesPerArtifact) ? maxPagesPerArtifact : null;
  const regionDirectory = path.join(workRoot, region);
  const artifactsDirectory = path.join(regionDirectory, "artifacts");
  const sessionFile = path.join(regionDirectory, "session.json");
  await mkdir(artifactsDirectory, { recursive: true });

  const artifactIds = await loadArtifactIds(fetchImpl, listingUrl);
  const session = await loadSession({
    artifactIds,
    capturedAt,
    maxPagesPerArtifact: recordedMaxPages,
    region,
    sessionFile,
    windowDays,
  });
  const cutoff = Date.parse(session.cutoff);
  const sessionCapturedAt = Date.parse(session.capturedAt);
  const completed = new Set(session.completedArtifactIds);
  let current = { artifactId: null, fetched: 0, pages: 0, percent: 0 };

  const heartbeat = setInterval(() => {
    log(
      `Heartbeat ${region}: ${completed.size}/${artifactIds.length} artifacts complete, current ${current.artifactId ?? "idle"} (${current.fetched} rows across ${current.pages} pages, ${current.percent.toFixed(1)}% of ${windowDays}-day window).`,
    );
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    for (const artifactId of artifactIds) {
      if (completed.has(artifactId)) continue;
      if (now() - startedAt >= maxRuntimeMs) {
        session.updatedAt = new Date(now()).toISOString();
        session.stopReason = "time-budget";
        await atomicJson(sessionFile, session);
        await checkpoint({ artifactId: null, region, session, sessionFile });
        return result(session, false, "time-budget");
      }

      current = { artifactId, fetched: 0, pages: 0, percent: 0 };
      const artifactFile = path.join(artifactsDirectory, `${artifactId}.jsonl`);
      const existingRows = await readJsonLines(artifactFile);
      const newestExistingSale = latestSaleTimestamp(existingRows);

      let fetchedRows;
      try {
        fetchedRows = await fetchHistoryRows({
          artifactId,
          cutoff,
          credentials,
          fetchImpl,
          newestExistingSale,
          maxPages: maxPagesPerArtifact,
          pageLimit,
          region,
          shouldStop: () => now() - startedAt >= maxRuntimeMs,
          onPage: ({ fetchedRecords, historyExhausted, oldestTimestamp, pagesFetched }) => {
            current.fetched = fetchedRecords;
            current.pages = pagesFetched;
            current.percent = historyExhausted
              ? 100
              : windowPercent({ capturedAt: sessionCapturedAt, cutoff, oldestTimestamp });
          },
        });
      } catch (error) {
        session.updatedAt = new Date(now()).toISOString();
        session.stopReason = error instanceof TimeBudgetExceeded ? "time-budget" : "artifact-error";
        session.lastError =
          error instanceof TimeBudgetExceeded ? null : { artifactId, message: error.message };
        await atomicJson(sessionFile, session);
        await checkpoint({ artifactId: null, region, session, sessionFile });
        log(`Stopped ${region} at ${artifactId}: ${error.message}`);
        return result(session, false, session.stopReason);
      }

      const mergedRows = mergeHistoryRows({
        capturedAt: new Date(session.capturedAt),
        existingRows,
        fetchedRows,
        windowDays,
      });
      await atomicJsonLines(artifactFile, mergedRows);

      completed.add(artifactId);
      session.completedArtifactIds = artifactIds.filter((id) => completed.has(id));
      session.updatedAt = new Date(now()).toISOString();
      session.stopReason = null;
      session.lastError = null;
      session.artifacts[artifactId] = summarizeArtifact({
        existingRows,
        fetchedRows,
        maxPagesPerArtifact: recordedMaxPages,
        mergedRows,
      });
      await atomicJson(sessionFile, session);
      await checkpoint({ artifactFile, artifactId, region, session, sessionFile });

      if (completed.size % progressEvery === 0 || completed.size === artifactIds.length) {
        log(`Updated ${completed.size}/${artifactIds.length} ${region} artifacts (${artifactId}).`);
      }
    }

    await pruneStaleArtifacts(artifactsDirectory, new Set(artifactIds));
    const manifest = await buildManifest({ artifactIds, artifactsDirectory, session });
    const manifestFile = path.join(regionDirectory, "manifest.json");
    await atomicJson(manifestFile, manifest);
    session.status = "complete";
    session.updatedAt = new Date(now()).toISOString();
    session.stopReason = null;
    await atomicJson(sessionFile, session);
    await checkpoint({ artifactId: null, manifestFile, region, session, sessionFile });
    return { ...result(session, true, null), manifest, manifestFile, regionDirectory };
  } finally {
    clearInterval(heartbeat);
  }
}

export async function fetchHistoryRows({
  artifactId,
  cutoff,
  credentials,
  fetchImpl,
  newestExistingSale,
  maxPages = Number.POSITIVE_INFINITY,
  onPage = () => {},
  pageLimit,
  region,
  requestDelay = delay,
  shouldStop = () => false,
}) {
  const rows = [];
  let offset = 0;
  let pagesFetched = 0;
  let fetchOneMoreAfterOverlap = false;

  while (true) {
    const url = new URL(`https://eapi.stalzone.com/${region.toUpperCase()}/auction/${artifactId}/history`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("additional", "true");

    const response = await request({
      credentials,
      fetchImpl,
      label: `${artifactId} offset ${offset}`,
      requestDelay,
      url,
    });
    const parsed = await response.json();
    if (!Number.isInteger(parsed.total) || !Array.isArray(parsed.prices)) {
      throw new Error(`${artifactId} offset ${offset} returned an invalid history response.`);
    }

    for (const row of parsed.prices) validateAuctionRecord(row, artifactId);
    rows.push(...parsed.prices);
    pagesFetched += 1;
    const timestamps = parsed.prices.map(parseSoldAt);
    const overlapsExisting =
      Number.isFinite(newestExistingSale) && timestamps.some((timestamp) => timestamp <= newestExistingSale);
    const crossedCutoff = timestamps.some((timestamp) => timestamp < cutoff);
    const exhausted = parsed.prices.length === 0 || offset + parsed.prices.length >= parsed.total;
    offset += parsed.prices.length;

    onPage({
      artifactId,
      fetchedRecords: rows.length,
      historyExhausted: exhausted,
      oldestTimestamp: timestamps.length ? Math.min(...timestamps) : null,
      pageRecords: parsed.prices.length,
      pagesFetched,
    });
    if (shouldStop()) throw new TimeBudgetExceeded();

    if (exhausted || fetchOneMoreAfterOverlap || pagesFetched >= maxPages) break;
    if (overlapsExisting) {
      fetchOneMoreAfterOverlap = true;
      continue;
    }
    if (crossedCutoff) break;
  }

  return rows;
}

class TimeBudgetExceeded extends Error {
  constructor() {
    super("soft runtime budget reached; the current artifact will resume from its last checkpoint");
  }
}

export function mergeHistoryRows({ capturedAt, existingRows, fetchedRows, windowDays }) {
  const cutoff = capturedAt.getTime() - windowDays * dayMs;
  const seen = new Set();
  const rows = [];

  for (const row of [...existingRows, ...fetchedRows].sort(compareRows)) {
    validateAuctionRecord(row, "cached");
    const timestamp = parseSoldAt(row);
    if (timestamp < cutoff || timestamp > capturedAt.getTime()) continue;
    const key = stableStringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

export function validateAuctionRecord(record, artifactId = "unknown") {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${artifactId} returned a non-object auction record.`);
  }
  if (!Number.isFinite(parseSoldAt(record))) {
    throw new Error(`${artifactId} returned an auction record without a valid sale timestamp.`);
  }
  const personalKey = findPersonalKey(record);
  if (personalKey) {
    throw new Error(`${artifactId} returned blocked personal identifier field: ${personalKey}.`);
  }
}

async function loadArtifactIds(fetchImpl, listingUrl) {
  const response = await fetchImpl(listingUrl);
  if (!response.ok) throw new Error(`Artifact listing failed (${response.status}).`);
  const listing = await response.json();
  if (!Array.isArray(listing)) throw new Error("Artifact listing returned an invalid response.");
  return [
    ...new Set(
      listing
        .map((entry) => entry?.data)
        .filter((itemPath) => typeof itemPath === "string" && itemPath.startsWith("/items/artefact/"))
        .map((itemPath) => path.posix.basename(itemPath, ".json")),
    ),
  ].sort();
}

async function loadSession({ artifactIds, capturedAt, maxPagesPerArtifact, region, sessionFile, windowDays }) {
  const existing = await readJson(sessionFile);
  if (
    existing?.status === "in-progress" &&
    existing.region === region &&
    existing.maxPagesPerArtifact === maxPagesPerArtifact
  ) {
    const known = new Set(artifactIds);
    existing.artifactIds = artifactIds;
    existing.completedArtifactIds = existing.completedArtifactIds.filter((id) => known.has(id));
    existing.artifacts ??= {};
    return existing;
  }
  return {
    schemaVersion: 1,
    status: "in-progress",
    region,
    source: "https://eapi.stalzone.com/{region}/auction/{artifact}/history",
    capturedAt: capturedAt.toISOString(),
    cutoff: new Date(capturedAt.getTime() - windowDays * dayMs).toISOString(),
    windowDays,
    maxPagesPerArtifact,
    artifactIds,
    completedArtifactIds: [],
    artifacts: {},
    updatedAt: capturedAt.toISOString(),
    stopReason: null,
    lastError: null,
  };
}

async function buildManifest({ artifactIds, artifactsDirectory, session }) {
  const artifacts = {};
  let recordCount = 0;
  for (const artifactId of artifactIds) {
    const rows = await readJsonLines(path.join(artifactsDirectory, `${artifactId}.jsonl`));
    recordCount += rows.length;
    artifacts[artifactId] = {
      records: rows.length,
      newestSaleAt: formatTimestamp(rows.at(0)),
      oldestSaleAt: formatTimestamp(rows.at(-1)),
      refreshedAt: session.artifacts[artifactId]?.refreshedAt ?? session.updatedAt,
    };
  }
  return {
    schemaVersion: 1,
    status: "complete",
    region: session.region,
    source: session.source,
    capturedAt: session.capturedAt,
    cutoff: session.cutoff,
    windowDays: session.windowDays,
    maxPagesPerArtifact: session.maxPagesPerArtifact,
    artifactCount: artifactIds.length,
    recordCount,
    artifacts,
    format: "tar.gz containing manifest.json and artifacts/<artifactId>.jsonl; each line preserves one API sale object",
  };
}

function summarizeArtifact({ existingRows, fetchedRows, maxPagesPerArtifact, mergedRows }) {
  return {
    existingRecords: existingRows.length,
    fetchedRecords: fetchedRows.length,
    maxPagesPerArtifact,
    retainedRecords: mergedRows.length,
    newestSaleAt: formatTimestamp(mergedRows.at(0)),
    oldestSaleAt: formatTimestamp(mergedRows.at(-1)),
    refreshedAt: new Date().toISOString(),
  };
}

async function request({ credentials, fetchImpl, label, requestDelay, url }) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: { "Client-Id": credentials.clientId, "Client-Secret": credentials.clientSecret },
    });
    if (response.ok) return response;
    const body = await response.text();
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`${label} failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    await requestDelay(
      Number.isFinite(retryAfter) ? retryAfter * 1_000 : Math.min(30_000, 1_000 * 2 ** attempt),
    );
  }
  throw new Error(`${label} failed after retries.`);
}

function findPersonalKey(value, prefix = "") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    const qualified = prefix ? `${prefix}.${key}` : key;
    if (personalKeys.has(normalized)) return qualified;
    const nested = findPersonalKey(child, qualified);
    if (nested) return nested;
  }
  return null;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonLines(file) {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function atomicJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicJsonLines(file, rows) {
  await atomicWrite(file, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
}

async function atomicWrite(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

async function pruneStaleArtifacts(directory, currentIds) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl") && !currentIds.has(entry.name.slice(0, -6))) {
      await rm(path.join(directory, entry.name), { force: true });
    }
  }
}

function parseSoldAt(row) {
  return Date.parse(row?.time ?? row?.closedAt ?? row?.endTime ?? row?.end_time ?? row?.date ?? "");
}

function latestSaleTimestamp(rows) {
  return rows.reduce((latest, row) => Math.max(latest, parseSoldAt(row)), Number.NEGATIVE_INFINITY);
}

function compareRows(left, right) {
  return parseSoldAt(right) - parseSoldAt(left) || Number(left.price ?? 0) - Number(right.price ?? 0);
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

function formatTimestamp(row) {
  const timestamp = parseSoldAt(row);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function windowPercent({ capturedAt, cutoff, oldestTimestamp }) {
  if (!Number.isFinite(oldestTimestamp) || capturedAt <= cutoff) return 0;
  return Math.min(100, Math.max(0, ((capturedAt - oldestTimestamp) / (capturedAt - cutoff)) * 100));
}

function result(session, complete, reason) {
  return {
    complete,
    reason,
    region: session.region,
    completedArtifacts: session.completedArtifactIds.length,
    artifactCount: session.artifactIds.length,
    capturedAt: session.capturedAt,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
