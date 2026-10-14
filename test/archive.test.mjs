import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildRegionArchive, validateRegionArchive } from "../scripts/archive.mjs";
import { GitHubApiError, GitHubReleaseClient } from "../scripts/github-release-client.mjs";
import { GitHubReleaseStore } from "../scripts/github-releases.mjs";

const execFileAsync = promisify(execFile);

test("regional archive validation requires every manifest artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-archive-test-"));
  try {
    await mkdir(path.join(directory, "artifacts"));
    await writeFile(path.join(directory, "artifacts", "alpha.jsonl"), '{"price":1,"time":"2026-01-01T00:00:00Z"}\n');
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ status: "complete", artifacts: { alpha: { records: 1 } } }));
    const archive = path.join(directory, "auction-history-eu.tar.gz");
    const built = await buildRegionArchive({ archive, regionDirectory: directory });

    assert.match(built.digest, /^[a-f0-9]{64}$/);
    assert.match(built.checksumLine, /auction-history-eu\.tar\.gz/);
    assert.equal((await validateRegionArchive({ archive })).artifacts.alpha.records, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint commits immutable data before its timestamped session marker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-checkpoint-test-"));
  const backend = new FakeReleaseBackend();
  try {
    const artifactFile = path.join(directory, "alpha.jsonl");
    const sessionFile = path.join(directory, "session.json");
    await writeFile(artifactFile, '{"price":1,"time":"2026-01-01T00:00:00Z"}\n');
    await writeFile(sessionFile, `${JSON.stringify(session({ completedArtifactIds: ["alpha"] }))}\n`);
    const store = backend.store();

    await store.checkpoint({ artifactFile, artifactId: "alpha", region: "eu", sessionFile });

    const uploads = backend.events.filter((event) => event.type === "upload");
    assert.equal(uploads.length, 2);
    assert.match(path.basename(uploads[0].file), /^checkpoint-eu-alpha-[a-f0-9]{12}-20260826T120000000Z\.jsonl\.gz$/);
    assert.match(path.basename(uploads[1].file), /^checkpoint-session-eu-r000001-[a-f0-9]{12}-20260826T120000000Z\.json$/);
    const marker = backend.jsonAsset("market-history-staging", path.basename(uploads[1].file));
    assert.equal(marker.session.completedArtifactIds[0], "alpha");
    assert.equal(marker.artifacts.alpha.name, path.basename(uploads[0].file));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint refuses to publish a marker when GitHub reports the wrong upload digest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-checkpoint-digest-test-"));
  const backend = new FakeReleaseBackend();
  const uploadAsset = backend.uploadAsset.bind(backend);
  backend.uploadAsset = async (...args) => ({
    ...await uploadAsset(...args),
    digest: `sha256:${"0".repeat(64)}`,
  });
  try {
    const artifactFile = path.join(directory, "alpha.jsonl");
    const sessionFile = path.join(directory, "session.json");
    await writeFile(artifactFile, '{"price":1}\n');
    await writeFile(sessionFile, `${JSON.stringify(session({ completedArtifactIds: ["alpha"] }))}\n`);

    await assert.rejects(
      backend.store().checkpoint({ artifactFile, artifactId: "alpha", region: "eu", sessionFile }),
      /failed GitHub upload verification/,
    );

    assert.equal(
      backend.assetNames("market-history-staging").filter((name) => name.startsWith("checkpoint-session-eu-")).length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release upload recovers when GitHub stores the asset but its response is lost", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-upload-response-test-"));
  const api = new CountingGitHubApi();
  api.loseNextUploadResponse = true;
  const client = new GitHubReleaseClient({
    repository: "owner/data",
    token: "test-token",
    fetchImpl: api.fetch.bind(api),
    mutationIntervalMs: 0,
    sleepImpl: async () => {},
  });
  const file = path.join(directory, "checkpoint.json");
  try {
    await writeFile(file, '{"saved":true}\n');
    const uploaded = await client.uploadAsset("market-history-staging", file);

    assert.equal(uploaded.name, "checkpoint.json");
    assert.equal(api.count("POST"), 1, "an ambiguous successful upload must not be repeated");
    assert.equal(api.count("GET"), 3, "the asset inventory should be refreshed after the lost response");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a full 103-artifact checkpoint session stays within a bounded GitHub request budget", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-checkpoint-budget-test-"));
  const api = new CountingGitHubApi();
  const client = new GitHubReleaseClient({
    repository: "owner/data",
    token: "test-token",
    fetchImpl: api.fetch.bind(api),
    mutationIntervalMs: 0,
  });
  const store = new GitHubReleaseStore({ repository: "owner/data", releaseClient: client });
  const artifactFile = path.join(directory, "artifact.jsonl");
  const sessionFile = path.join(directory, "session.json");
  const completedArtifactIds = [];
  try {
    for (let index = 0; index < 103; index += 1) {
      const artifactId = `artifact-${String(index).padStart(3, "0")}`;
      completedArtifactIds.push(artifactId);
      const updatedAt = new Date(Date.parse("2026-08-26T12:00:00.000Z") + index * 1_000).toISOString();
      await writeFile(artifactFile, `${JSON.stringify({ artifactId, price: index + 1 })}\n`);
      await writeFile(sessionFile, `${JSON.stringify(session({ completedArtifactIds, updatedAt }))}\n`);
      await store.checkpoint({ artifactFile, artifactId, region: "eu", sessionFile });
    }

    assert.equal(api.count("GET"), 2, "release and asset inventories should each be fetched once");
    assert.equal(api.count("POST"), 206, "each checkpoint uploads one artifact and one marker");
    assert.equal(api.count("DELETE"), 101, "only superseded markers should require deletion");
    assert.ok(api.requests.length <= 350, `expected at most 350 requests, received ${api.requests.length}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore falls back to the previous committed stable generation when the newer archive is damaged", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-stable-fallback-"));
  const backend = new FakeReleaseBackend();
  try {
    const store = backend.store();
    const older = await regionFixture(directory, "older", "2026-08-25T12:00:00.000Z", 1);
    const newer = await regionFixture(directory, "newer", "2026-08-26T12:00:00.000Z", 2);
    await store.publishRegion({ ...older, region: "eu" });
    await store.publishRegion({ ...newer, region: "eu" });
    const markers = backend.assetNames("market-history-latest").filter((name) => name.startsWith("generation-eu-"));
    assert.equal(markers.length, 2);
    const newestMarker = markers.map((name) => backend.jsonAsset("market-history-latest", name)).sort((a, b) => b.generation - a.generation)[0];
    backend.assets("market-history-latest").set(newestMarker.archive.name, { id: 999, bytes: Buffer.from("damaged") });

    const restoredRoot = path.join(directory, "restored");
    await backend.store().restoreRegion({ region: "eu", workRoot: restoredRoot });

    const row = JSON.parse((await readFile(path.join(restoredRoot, "eu", "artifacts", "alpha.jsonl"), "utf8")).trim());
    assert.equal(row.price, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conflicting valid stable markers at the same generation fail closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-stable-fork-"));
  const backend = new FakeReleaseBackend();
  try {
    const initialStore = backend.store();
    const initial = await regionFixture(directory, "initial", "2026-08-24T12:00:00.000Z", 1);
    await initialStore.publishRegion({ ...initial, region: "eu" });

    const firstWriter = backend.store();
    const secondWriter = backend.store();
    await firstWriter.restoreRegion({ region: "eu", workRoot: path.join(directory, "first-work") });
    await secondWriter.restoreRegion({ region: "eu", workRoot: path.join(directory, "second-work") });

    const first = await regionFixture(directory, "first-fork", "2026-08-25T12:00:00.000Z", 2);
    const second = await regionFixture(directory, "second-fork", "2026-08-26T12:00:00.000Z", 3);
    await firstWriter.publishRegion({ ...first, region: "eu" });
    await assert.rejects(
      secondWriter.publishRegion({ ...second, region: "eu" }),
      /Conflicting stable generation 2/,
    );

    assert.equal(
      backend.assetNames("market-history-latest").filter((name) => name.startsWith("generation-eu-")).length,
      3,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore never mixes staging revisions and falls back when the newest checkpoint is incomplete", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-staging-fallback-"));
  const backend = new FakeReleaseBackend();
  try {
    const store = backend.store();
    const artifactDirectory = path.join(directory, "artifacts");
    await mkdir(artifactDirectory);
    const sessionFile = path.join(directory, "session.json");
    const alpha = path.join(artifactDirectory, "alpha.jsonl");
    const beta = path.join(artifactDirectory, "beta.jsonl");
    await writeFile(alpha, '{"price":1}\n');
    await writeFile(sessionFile, `${JSON.stringify(session({ completedArtifactIds: ["alpha"] }))}\n`);
    await store.checkpoint({ artifactFile: alpha, artifactId: "alpha", region: "eu", sessionFile });
    await writeFile(beta, '{"price":2}\n');
    await writeFile(sessionFile, `${JSON.stringify(session({ completedArtifactIds: ["alpha", "beta"], updatedAt: "2026-08-26T12:01:00.000Z" }))}\n`);
    await store.checkpoint({ artifactFile: beta, artifactId: "beta", region: "eu", sessionFile });
    const newest = backend.assetNames("market-history-staging")
      .filter((name) => name.startsWith("checkpoint-session-eu-"))
      .map((name) => backend.jsonAsset("market-history-staging", name))
      .sort((a, b) => b.revision - a.revision)[0];
    backend.assets("market-history-staging").delete(newest.artifacts.beta.name);

    const restoredRoot = path.join(directory, "restored");
    await backend.store().restoreRegion({ region: "eu", workRoot: restoredRoot });
    const restoredSession = JSON.parse(await readFile(path.join(restoredRoot, "eu", "session.json"), "utf8"));

    assert.deepEqual(restoredSession.completedArtifactIds, ["alpha"]);
    assert.equal(await readFile(path.join(restoredRoot, "eu", "artifacts", "alpha.jsonl"), "utf8"), '{"price":1}\n');
    await assert.rejects(readFile(path.join(restoredRoot, "eu", "artifacts", "beta.jsonl")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable publication retains two immutable generations and cleans older assets only after committing the marker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-generation-retention-"));
  const backend = new FakeReleaseBackend();
  try {
    const store = backend.store();
    const first = await regionFixture(directory, "first", "2026-08-24T12:00:00.000Z", 1);
    const second = await regionFixture(directory, "second", "2026-08-25T12:00:00.000Z", 2);
    const third = await regionFixture(directory, "third", "2026-08-26T12:00:00.000Z", 3);

    await store.publishRegion({ ...first, region: "eu" });
    await store.publishRegion({ ...second, region: "eu" });
    const firstMarkerName = backend.assetNames("market-history-latest")
      .filter((name) => name.startsWith("generation-eu-"))
      .find((name) => backend.jsonAsset("market-history-latest", name).generation === 1);
    const firstMarker = backend.jsonAsset("market-history-latest", firstMarkerName);
    const eventOffset = backend.events.length;
    await store.publishRegion({ ...third, region: "eu" });
    const thirdPublish = backend.events.slice(eventOffset);
    const markerUpload = thirdPublish.findIndex(
      (event) => event.type === "upload" && path.basename(event.file).startsWith("generation-eu-"),
    );
    const firstDelete = thirdPublish.findIndex((event) => event.type === "delete");
    assert.ok(markerUpload >= 0 && firstDelete > markerUpload);
    assert.ok(!backend.assetNames("market-history-latest").includes(firstMarkerName));
    assert.ok(!backend.assetNames("market-history-latest").includes(firstMarker.archive.name));
    assert.ok(!backend.assetNames("market-history-latest").includes(firstMarker.manifest.name));
    assert.equal(backend.assetNames("market-history-latest").filter((name) => name.startsWith("generation-eu-")).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub release client waits for the primary rate-limit reset and retries", async () => {
  let calls = 0;
  const delays = [];
  const client = new GitHubReleaseClient({
    repository: "owner/data",
    token: "test-token",
    mutationIntervalMs: 0,
    nowImpl: () => 100_000,
    sleepImpl: async (delay) => delays.push(delay),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ message: "API rate limit exceeded for installation" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "101",
        });
      }
      return jsonResponse([]);
    },
  });

  assert.equal(await client.releaseExists("missing"), false);

  assert.deepEqual(delays, [2_000]);
  assert.equal(calls, 2);
});

test("GitHub release client treats only an explicit asset 404 as already deleted", async () => {
  let calls = 0;
  const client = new GitHubReleaseClient({
    repository: "owner/data",
    token: "test-token",
    mutationIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ message: "Not Found" }, 404);
    },
  });

  await client.deleteAsset(456);
  assert.equal(calls, 1);
});

test("GitHub release lookup propagates a non-rate-limit authorization failure", async () => {
  const client = new GitHubReleaseClient({
    repository: "owner/data",
    token: "test-token",
    mutationIntervalMs: 0,
    fetchImpl: async () => jsonResponse({ message: "Forbidden" }, 403),
  });

  await assert.rejects(
    client.releaseExists("market-history-staging"),
    (error) => error instanceof GitHubApiError && error.status === 403,
  );
});

function session(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "in-progress",
    region: "eu",
    capturedAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
    completedArtifactIds: [],
    ...overrides,
  };
}

async function regionFixture(root, name, capturedAt, price) {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "artifacts"), { recursive: true });
  await writeFile(path.join(directory, "artifacts", "alpha.jsonl"), `${JSON.stringify({ price, time: capturedAt })}\n`);
  const manifestFile = path.join(directory, "manifest.json");
  await writeFile(manifestFile, `${JSON.stringify({ schemaVersion: 1, status: "complete", region: "eu", capturedAt, artifacts: { alpha: { records: 1 } } })}\n`);
  const built = await buildRegionArchive({ archive: path.join(directory, "archive.tar.gz"), regionDirectory: directory });
  return { archive: built.archive, digest: built.digest, manifestFile };
}

class FakeReleaseBackend {
  constructor() {
    this.releases = new Map();
    this.events = [];
    this.nextAssetId = 1;
  }

  store() {
    return new GitHubReleaseStore({
      repository: "owner/data",
      execFileImpl: execFileAsync,
      releaseClient: this,
    });
  }

  assets(tag) {
    if (!this.releases.has(tag)) this.releases.set(tag, new Map());
    return this.releases.get(tag);
  }

  assetNames(tag) { return [...this.assets(tag).keys()]; }
  jsonAsset(tag, name) { return JSON.parse(this.assets(tag).get(name).bytes.toString("utf8")); }
  put(tag, name, bytes) {
    const body = Buffer.from(bytes);
    const asset = {
      id: this.nextAssetId++,
      name,
      bytes: body,
      size: body.length,
      state: "uploaded",
      digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    };
    this.assets(tag).set(name, asset);
    return asset;
  }

  async releaseExists(tag) {
    this.events.push({ type: "release-exists", tag });
    return this.releases.has(tag);
  }

  async ensureRelease({ tag }) {
    this.events.push({ type: "ensure-release", tag });
    this.assets(tag);
  }

  async listAssets(tag) {
    this.events.push({ type: "list-assets", tag });
    return [...this.assets(tag)].map(([name, asset]) => ({ ...asset, name }));
  }

  async uploadAsset(tag, file) {
    this.events.push({ type: "upload", tag, file });
    const name = path.basename(file);
    if (this.assets(tag).has(name)) return this.assets(tag).get(name);
    return this.put(tag, name, await readFile(file));
  }

  async downloadAsset(tag, name, directory) {
    this.events.push({ type: "download", tag, name });
    const asset = this.assets(tag).get(name);
    if (!asset) return false;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), asset.bytes);
    return true;
  }

  async deleteAsset(id) {
    this.events.push({ type: "delete", id });
    for (const assets of this.releases.values()) {
      for (const [name, asset] of assets) if (asset.id === id) assets.delete(name);
    }
  }
}

class CountingGitHubApi {
  constructor() {
    this.requests = [];
    this.assets = new Map();
    this.nextAssetId = 1;
    this.release = {
      id: 1,
      tag_name: "market-history-staging",
      draft: true,
    };
  }

  count(method) {
    return this.requests.filter((request) => request.method === method).length;
  }

  async fetch(value, options = {}) {
    const url = new URL(value);
    const method = options.method ?? "GET";
    this.requests.push({ method, url: url.toString() });
    if (method === "GET" && url.pathname === "/repos/owner/data/releases") {
      return jsonResponse([this.release]);
    }
    if (method === "GET" && url.pathname === "/repos/owner/data/releases/1/assets") {
      return jsonResponse([...this.assets.values()].map(({ bytes, ...asset }) => asset));
    }
    if (method === "POST" && url.hostname === "uploads.github.com") {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const name = url.searchParams.get("name");
      const asset = {
        id: this.nextAssetId++,
        name,
        size: bytes.length,
        state: "uploaded",
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        bytes,
      };
      this.assets.set(name, asset);
      if (this.loseNextUploadResponse) {
        this.loseNextUploadResponse = false;
        throw new TypeError("simulated lost upload response");
      }
      const { bytes: ignored, ...metadata } = asset;
      return jsonResponse(metadata, 201);
    }
    if (method === "DELETE" && url.pathname.startsWith("/repos/owner/data/releases/assets/")) {
      const id = Number(url.pathname.split("/").at(-1));
      for (const [name, asset] of this.assets) if (asset.id === id) this.assets.delete(name);
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ message: `Unhandled test request: ${method} ${url}` }, 500);
  }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
