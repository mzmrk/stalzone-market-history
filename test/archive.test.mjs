import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildRegionArchive, validateRegionArchive } from "../scripts/archive.mjs";
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

    const uploads = backend.commands.filter((command) => command[1] === "release" && command[2] === "upload");
    assert.equal(uploads.length, 2);
    assert.doesNotMatch(uploads.flat().join(" "), /--clobber/);
    assert.match(path.basename(uploads[0][4]), /^checkpoint-eu-alpha-[a-f0-9]{12}-20260826T120000000Z\.jsonl\.gz$/);
    assert.match(path.basename(uploads[1][4]), /^checkpoint-session-eu-r000001-[a-f0-9]{12}-20260826T120000000Z\.json$/);
    const marker = backend.jsonAsset("market-history-staging", path.basename(uploads[1][4]));
    assert.equal(marker.session.completedArtifactIds[0], "alpha");
    assert.equal(marker.artifacts.alpha.name, path.basename(uploads[0][4]));
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

test("legacy fixed assets survive as rollback until a second immutable generation is committed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-legacy-migration-"));
  const backend = new FakeReleaseBackend();
  try {
    const legacy = await regionFixture(directory, "legacy", "2026-08-24T12:00:00.000Z", 1);
    const legacyName = `auction-history-eu-${legacy.digest.slice(0, 12)}.tar.gz`;
    backend.put("market-history-latest", legacyName, await readFile(legacy.archive));
    backend.put("market-history-latest", "latest-eu.json", Buffer.from(JSON.stringify({ schemaVersion: 1, region: "eu", capturedAt: "2026-08-24T12:00:00.000Z", archive: legacyName, sha256: legacy.digest })));
    const store = backend.store();
    await store.restoreRegion({ region: "eu", workRoot: path.join(directory, "work") });
    const first = await regionFixture(directory, "first", "2026-08-25T12:00:00.000Z", 2);
    const second = await regionFixture(directory, "second", "2026-08-26T12:00:00.000Z", 3);

    await store.publishRegion({ ...first, region: "eu" });
    assert.ok(backend.assetNames("market-history-latest").includes("latest-eu.json"));
    const commandOffset = backend.commands.length;
    await store.publishRegion({ ...second, region: "eu" });
    const secondPublish = backend.commands.slice(commandOffset);
    const markerUpload = secondPublish.findIndex(
      (command) => command[1] === "release" && command[2] === "upload" && path.basename(command[4]).startsWith("generation-eu-"),
    );
    const firstDelete = secondPublish.findIndex((command) => command[1] === "api" && command.includes("DELETE"));
    assert.ok(markerUpload >= 0 && firstDelete > markerUpload);
    assert.doesNotMatch(secondPublish.flat().join(" "), /--clobber/);
    assert.ok(!backend.assetNames("market-history-latest").includes("latest-eu.json"));
    assert.equal(backend.assetNames("market-history-latest").filter((name) => name.startsWith("generation-eu-")).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    this.commands = [];
    this.nextAssetId = 1;
  }

  store() {
    return new GitHubReleaseStore({ repository: "owner/data", execFileImpl: this.execFile.bind(this) });
  }

  assets(tag) {
    if (!this.releases.has(tag)) this.releases.set(tag, new Map());
    return this.releases.get(tag);
  }

  assetNames(tag) { return [...this.assets(tag).keys()]; }
  jsonAsset(tag, name) { return JSON.parse(this.assets(tag).get(name).bytes.toString("utf8")); }
  put(tag, name, bytes) { this.assets(tag).set(name, { id: this.nextAssetId++, bytes: Buffer.from(bytes) }); }

  async execFile(command, args) {
    this.commands.push([command, ...args]);
    if (command === "tar") return execFileAsync(command, args);
    if (command !== "gh") throw new Error(`Unexpected command: ${command}`);
    if (args[0] === "release" && args[1] === "view") {
      if (this.releases.has(args[2])) return { stdout: "", stderr: "" };
      throw commandError("release missing");
    }
    if (args[0] === "release" && args[1] === "create") {
      this.assets(args[2]);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "release" && args[1] === "upload") {
      const tag = args[2];
      for (const file of args.slice(3, args.indexOf("--repo"))) {
        const name = path.basename(file);
        if (this.assets(tag).has(name)) throw new Error(`asset already exists: ${name}`);
        this.put(tag, name, await readFile(file));
      }
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "release" && args[1] === "download") {
      const tag = args[2];
      const pattern = args[args.indexOf("--pattern") + 1];
      const destination = args[args.indexOf("--dir") + 1];
      const matches = [...this.assets(tag)].filter(([name]) => globMatches(name, pattern));
      if (matches.length === 0) throw commandError("no assets to download");
      await mkdir(destination, { recursive: true });
      for (const [name, asset] of matches) await writeFile(path.join(destination, name), asset.bytes);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "api" && args.some((value) => value.includes("releases?per_page=100"))) {
      const tag = [...this.releases.keys()].find((candidate) => args.at(-1).includes(JSON.stringify(candidate)));
      return { stdout: tag ? `${[...this.releases.keys()].indexOf(tag) + 1}\n` : "", stderr: "" };
    }
    if (args[0] === "api" && args.some((value) => /releases\/\d+\/assets/.test(value))) {
      const id = Number(args.find((value) => /releases\/\d+\/assets/.test(value)).match(/releases\/(\d+)/)[1]);
      const tag = [...this.releases.keys()][id - 1];
      return { stdout: [...this.assets(tag)].map(([name, asset]) => `${asset.id}\t${name}`).join("\n") + "\n", stderr: "" };
    }
    if (args[0] === "api" && args.includes("DELETE")) {
      const id = Number(args.find((value) => value.includes("/assets/")).split("/").at(-1));
      for (const assets of this.releases.values()) for (const [name, asset] of assets) if (asset.id === id) assets.delete(name);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected gh arguments: ${args.join(" ")}`);
  }
}

function globMatches(name, pattern) {
  if (!pattern.includes("*")) return name === pattern;
  const [prefix, suffix] = pattern.split("*");
  return name.startsWith(prefix) && name.endsWith(suffix);
}

function commandError(message) {
  const error = new Error(message);
  error.code = 1;
  error.stderr = message;
  return error;
}
