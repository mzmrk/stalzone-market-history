import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { validateRegionArchive } from "./archive.mjs";

const execFileAsync = promisify(execFile);

export class GitHubReleaseStore {
  constructor({
    repository,
    stableTag = "market-history-latest",
    stagingTag = "market-history-staging",
    execFileImpl = execFileAsync,
    sleepImpl = sleep,
    deleteRetryDelaysMs = [1_000, 2_000, 4_000, 8_000],
  }) {
    if (!repository) throw new Error("GitHub release storage requires a repository name.");
    this.repository = repository;
    this.stableTag = stableTag;
    this.stagingTag = stagingTag;
    this.execFile = execFileImpl;
    this.sleep = sleepImpl;
    this.deleteRetryDelaysMs = deleteRetryDelaysMs;
    this.stableStates = new Map();
    this.stagingStates = new Map();
  }

  async restoreRegion({ region, workRoot }) {
    const regionDirectory = path.join(workRoot, region);
    await mkdir(regionDirectory, { recursive: true });
    const temporary = await mkdtemp(path.join(tmpdir(), `market-history-restore-${region}-`));
    try {
      const stable = await this.downloadLatestStableGeneration({ directory: temporary, region });
      this.stableStates.set(region, stable);
      if (stable) await this.execFile("tar", ["-xzf", stable.archivePath, "-C", regionDirectory]);
      const staging = await this.restoreLatestStagingGeneration({ directory: temporary, region, regionDirectory, stable });
      this.stagingStates.set(region, staging);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async checkpoint({ artifactFile, artifactId, region, sessionFile }) {
    await this.ensureRelease({
      tag: this.stagingTag,
      draft: true,
      title: "Market history staging",
      notes: "Internal resumable checkpoints. Public consumers should use the rolling release.",
    });
    const temporary = await mkdtemp(path.join(tmpdir(), `market-history-checkpoint-${region}-`));
    try {
      const session = JSON.parse(await readFile(sessionFile, "utf8"));
      const previous = this.stagingStates.get(region) ?? null;
      const sessionId = checkpointSessionId(region, session.capturedAt);
      const sameSession = previous?.marker?.sessionId === sessionId;
      const revision = sameSession ? previous.marker.revision + 1 : 1;
      const artifacts = sameSession ? structuredClone(previous.marker.artifacts) : {};
      const timestamp = assetTimestamp(session.updatedAt);

      if (artifactId && artifactFile) {
        const compressed = path.join(temporary, `checkpoint-${region}-${safeName(artifactId)}-pending-${timestamp}.jsonl.gz`);
        await pipeline(createReadStream(artifactFile), createGzip({ level: 9 }), createWriteStream(compressed));
        const digest = await hashFile(compressed);
        const assetName = `checkpoint-${region}-${safeName(artifactId)}-${digest.slice(0, 12)}-${timestamp}.jsonl.gz`;
        const assetFile = path.join(temporary, assetName);
        await copyFile(compressed, assetFile);
        await this.uploadVerifiedImmutable({ tag: this.stagingTag, file: assetFile, digest, directory: temporary });
        artifacts[artifactId] = { name: assetName, sha256: digest };
      }

      const completedIds = new Set(session.completedArtifactIds ?? []);
      for (const existingId of Object.keys(artifacts)) if (!completedIds.has(existingId)) delete artifacts[existingId];
      for (const completedId of session.completedArtifactIds ?? []) {
        if (!artifacts[completedId]) {
          throw new Error(`Cannot commit staging revision ${revision}: ${completedId} has no verified checkpoint asset.`);
        }
      }

      const marker = {
        schemaVersion: 2,
        kind: "staging-generation",
        region,
        sessionId,
        revision,
        previousMarker: sameSession ? previous.markerName : null,
        baseStableMarker: this.stableStates.get(region)?.markerName ?? null,
        createdAt: session.updatedAt,
        session,
        artifacts,
      };
      const markerText = `${JSON.stringify(marker, null, 2)}\n`;
      const markerDigest = hashBytes(markerText);
      const markerName = `checkpoint-session-${region}-r${String(revision).padStart(6, "0")}-${markerDigest.slice(0, 12)}-${timestamp}.json`;
      const markerFile = path.join(temporary, markerName);
      await writeFile(markerFile, markerText);
      await this.uploadVerifiedImmutable({ tag: this.stagingTag, file: markerFile, digest: markerDigest, directory: temporary });

      const current = { marker, markerName };
      await this.cleanupStagingAssets({ current, previous: sameSession ? previous : null, region });
      this.stagingStates.set(region, current);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async publishRegion({ archive, digest, manifestFile, region }) {
    await this.ensureRelease({
      tag: this.stableTag,
      draft: false,
      title: "Rolling market history",
      notes: "Complete rolling auction-history archives from the official STALZONE API.",
    });
    const temporary = await mkdtemp(path.join(tmpdir(), `market-history-publish-${region}-`));
    try {
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      const timestamp = assetTimestamp(manifest.capturedAt);
      const version = digest.slice(0, 12);
      const parent = this.stableStates.has(region)
        ? this.stableStates.get(region)
        : await this.downloadLatestStableGeneration({ directory: temporary, region });
      const generation = (parent?.marker?.generation ?? 0) + 1;
      const archiveName = `auction-history-${region}-${version}-${timestamp}.tar.gz`;
      const manifestDigest = await hashFile(manifestFile);
      const manifestName = `manifest-${region}-${manifestDigest.slice(0, 12)}-${timestamp}.json`;
      const archiveAsset = path.join(temporary, archiveName);
      const manifestAsset = path.join(temporary, manifestName);
      await copyFile(archive, archiveAsset);
      await copyFile(manifestFile, manifestAsset);

      const archivedManifest = await validateRegionArchive({ archive: archiveAsset, execFileImpl: this.execFile });
      const { stdout: archivedManifestText } = await this.execFile("tar", ["-xOzf", archiveAsset, "manifest.json"]);
      if (manifest.region !== region || archivedManifest.region !== region || manifest.capturedAt !== archivedManifest.capturedAt) {
        throw new Error(`Regional archive and manifest do not describe region ${region}.`);
      }
      if (hashBytes(archivedManifestText) !== manifestDigest) {
        throw new Error("The separately published manifest does not exactly match the manifest inside the archive.");
      }

      await this.uploadVerifiedImmutable({ tag: this.stableTag, file: archiveAsset, digest, directory: temporary });
      await this.uploadVerifiedImmutable({ tag: this.stableTag, file: manifestAsset, digest: manifestDigest, directory: temporary });

      const marker = {
        schemaVersion: 2,
        kind: "stable-generation",
        region,
        generation,
        previousMarker: parent?.markerName ?? null,
        createdAt: manifest.capturedAt,
        archive: { name: archiveName, sha256: digest },
        manifest: { name: manifestName, sha256: manifestDigest },
      };
      const markerText = `${JSON.stringify(marker, null, 2)}\n`;
      const markerDigest = hashBytes(markerText);
      const markerName = `generation-${region}-${markerDigest.slice(0, 12)}-${timestamp}.json`;
      const markerFile = path.join(temporary, markerName);
      await writeFile(markerFile, markerText);
      await this.uploadVerifiedImmutable({ tag: this.stableTag, file: markerFile, digest: markerDigest, directory: temporary });

      const current = { archivePath: archiveAsset, marker, markerName };
      const resolved = await this.downloadLatestStableGeneration({ directory: path.join(temporary, "committed"), region });
      if (!resolved || resolved.markerName !== markerName) {
        throw new Error(`Published stable generation did not resolve as current for region ${region}.`);
      }
      await this.cleanupStableAssets({ current, previous: parent, region });
      this.stableStates.set(region, current);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async downloadLatestStableGeneration({ directory, region }) {
    if (!(await this.releaseExists(this.stableTag))) return null;
    await mkdir(directory, { recursive: true });
    const assets = await this.assetsForTag(this.stableTag);
    const markerPattern = new RegExp(`^generation-${region}-([a-f0-9]{12})-\\d{8}T\\d{9}Z\\.json$`);
    const candidates = [];
    for (const asset of assets.filter((item) => markerPattern.test(item.name))) {
      if (!(await this.download(this.stableTag, asset.name, directory))) continue;
      try {
        const markerFile = path.join(directory, asset.name);
        if (!(await hashFile(markerFile)).startsWith(asset.name.match(markerPattern)[1])) throw new Error("marker digest does not match its filename");
        const marker = validateStableMarker(JSON.parse(await readFile(markerFile, "utf8")), region);
        if (!asset.name.endsWith(`-${assetTimestamp(marker.createdAt)}.json`)) throw new Error("marker timestamp does not match its filename");
        candidates.push({ marker, markerName: asset.name });
      } catch (error) {
        console.warn(`Ignoring invalid stable marker ${asset.name}: ${error.message}`);
      }
    }
    const verifiedCandidates = [];
    for (const candidate of candidates) {
      const verified = await this.verifyStableCandidate(candidate, directory);
      if (verified) verifiedCandidates.push(verified);
      else console.warn(`Ignoring incomplete stable generation ${candidate.markerName}.`);
    }
    assertNoGenerationFork(verifiedCandidates, region);
    verifiedCandidates.sort((left, right) => right.marker.generation - left.marker.generation || Date.parse(right.marker.createdAt) - Date.parse(left.marker.createdAt));
    if (verifiedCandidates.length > 0) return verifiedCandidates[0];
    return null;
  }

  async verifyStableCandidate(candidate, directory) {
    const { marker } = candidate;
    for (const reference of [marker.archive, marker.manifest]) {
      if (!(await this.download(this.stableTag, reference.name, directory))) return null;
      if (await hashFile(path.join(directory, reference.name)) !== reference.sha256) return null;
    }
    const archivePath = path.join(directory, marker.archive.name);
    try {
      const manifest = await validateRegionArchive({ archive: archivePath, execFileImpl: this.execFile });
      if (manifest.region !== marker.region || manifest.capturedAt !== marker.createdAt) return null;
      const { stdout: archivedManifest } = await this.execFile("tar", ["-xOzf", archivePath, "manifest.json"]);
      if (hashBytes(archivedManifest) !== marker.manifest.sha256) return null;
    } catch {
      return null;
    }
    return { ...candidate, archivePath };
  }

  async restoreLatestStagingGeneration({ directory, region, regionDirectory, stable }) {
    if (!(await this.releaseExists(this.stagingTag))) return null;
    const assets = await this.assetsForTag(this.stagingTag);
    const pattern = new RegExp(`^checkpoint-session-${region}-r\\d{6}-([a-f0-9]{12})-\\d{8}T\\d{9}Z\\.json$`);
    const candidates = [];
    for (const asset of assets.filter((item) => pattern.test(item.name))) {
      if (!(await this.download(this.stagingTag, asset.name, directory))) continue;
      try {
        const markerFile = path.join(directory, asset.name);
        if (!(await hashFile(markerFile)).startsWith(asset.name.match(pattern)[1])) throw new Error("marker digest does not match its filename");
        const marker = validateStagingMarker(JSON.parse(await readFile(markerFile, "utf8")), region);
        if (!asset.name.endsWith(`-${assetTimestamp(marker.createdAt)}.json`)) throw new Error("marker timestamp does not match its filename");
        if (marker.baseStableMarker === (stable?.markerName ?? null)) candidates.push({ marker, markerName: asset.name });
      } catch (error) {
        console.warn(`Ignoring invalid staging marker ${asset.name}: ${error.message}`);
      }
    }
    const verifiedCandidates = [];
    for (const candidate of candidates) {
      if (await this.verifyStagingCandidate(candidate, directory)) verifiedCandidates.push(candidate);
      else console.warn(`Ignoring incomplete staging generation ${candidate.markerName}.`);
    }
    assertNoCheckpointFork(verifiedCandidates, region);
    verifiedCandidates.sort((left, right) => Date.parse(right.marker.createdAt) - Date.parse(left.marker.createdAt) || right.marker.revision - left.marker.revision);
    if (verifiedCandidates.length > 0) {
      await this.restoreStagingCandidate(verifiedCandidates[0], directory, regionDirectory);
      return verifiedCandidates[0];
    }
    return null;
  }

  async verifyStagingCandidate(candidate, directory) {
    const completed = new Set(candidate.marker.session.completedArtifactIds ?? []);
    for (const artifactId of completed) {
      const reference = candidate.marker.artifacts[artifactId];
      if (!reference || !(await this.download(this.stagingTag, reference.name, directory))) return false;
      const compressed = path.join(directory, reference.name);
      if (await hashFile(compressed) !== reference.sha256) return false;
    }
    return true;
  }

  async restoreStagingCandidate(candidate, directory, regionDirectory) {
    const completed = new Set(candidate.marker.session.completedArtifactIds ?? []);
    await writeFile(path.join(regionDirectory, "session.json"), `${JSON.stringify(candidate.marker.session, null, 2)}\n`);
    for (const artifactId of completed) {
      const destination = path.join(regionDirectory, "artifacts", `${artifactId}.jsonl`);
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(createReadStream(path.join(directory, candidate.marker.artifacts[artifactId].name)), createGunzip(), createWriteStream(destination));
    }
  }

  async uploadVerifiedImmutable({ tag, file, digest, directory }) {
    const name = path.basename(file);
    const assets = await this.assetsForTag(tag);
    if (!assets.some((asset) => asset.name === name)) {
      await this.execFile("gh", ["release", "upload", tag, file, "--repo", this.repository]);
    }
    const verification = path.join(directory, `verify-${hashBytes(`${tag}:${name}`).slice(0, 12)}`);
    await mkdir(verification, { recursive: true });
    if (!(await this.download(tag, name, verification))) throw new Error(`Uploaded release asset is missing: ${name}.`);
    if (await hashFile(path.join(verification, name)) !== digest) throw new Error(`Release asset failed SHA-256 verification: ${name}.`);
  }

  async cleanupStableAssets({ current, previous, region }) {
    const retained = [current, previous].filter(Boolean);
    const keepMarkers = new Set(retained.map((generation) => generation.markerName));
    const keepData = new Set(retained.flatMap((generation) => [generation.marker.archive?.name, generation.marker.manifest?.name]).filter(Boolean));
    const assets = await this.assetsForTag(this.stableTag);
    const markerAssets = assets.filter((asset) => asset.name.startsWith(`generation-${region}-`));
    for (const asset of markerAssets) if (!keepMarkers.has(asset.name)) await this.deleteAsset(asset.id);
    const dataAssets = assets.filter((asset) => asset.name.startsWith(`auction-history-${region}-`) || asset.name.startsWith(`manifest-${region}-`));
    for (const asset of dataAssets) if (!keepData.has(asset.name)) await this.deleteAsset(asset.id);
  }

  async cleanupStagingAssets({ current, previous, region }) {
    const retained = [current, previous].filter(Boolean);
    const keepMarkers = new Set(retained.map((generation) => generation.markerName));
    const keepData = new Set(retained.flatMap((generation) => Object.values(generation.marker.artifacts).map((reference) => reference.name)));
    const assets = await this.assetsForTag(this.stagingTag);
    const markers = assets.filter((asset) => asset.name.startsWith(`checkpoint-session-${region}-`));
    for (const asset of markers) if (!keepMarkers.has(asset.name)) await this.deleteAsset(asset.id);
    const data = assets.filter((asset) => asset.name.startsWith(`checkpoint-${region}-`));
    for (const asset of data) if (!keepData.has(asset.name) && !keepMarkers.has(asset.name)) await this.deleteAsset(asset.id);
  }

  async clearStagingRegion(region) {
    if (!(await this.releaseExists(this.stagingTag))) return;
    for (const asset of await this.assetsForTag(this.stagingTag)) {
      if (asset.name.startsWith(`checkpoint-${region}-`) || asset.name.startsWith(`checkpoint-session-${region}-`)) await this.deleteAsset(asset.id);
    }
    this.stagingStates.delete(region);
  }

  async ensureRelease({ draft, notes, tag, title }) {
    if (await this.releaseExists(tag)) return;
    const args = ["release", "create", tag, "--repo", this.repository, "--title", title, "--notes", notes];
    if (draft) args.push("--draft");
    await this.execFile("gh", args);
  }

  async releaseExists(tag) {
    try {
      await this.execFile("gh", ["release", "view", tag, "--repo", this.repository]);
      return true;
    } catch (error) {
      if (error?.code === 1) return false;
      throw error;
    }
  }

  async download(tag, pattern, directory) {
    try {
      await mkdir(directory, { recursive: true });
      if (!pattern.includes("*") && await exists(path.join(directory, pattern))) return true;
      await this.execFile("gh", ["release", "download", tag, "--pattern", pattern, "--dir", directory, "--repo", this.repository]);
      return true;
    } catch (error) {
      if (error?.code === 1 && /no files matched|no assets (?:match|to download)|not found/i.test(`${error.stderr ?? ""} ${error.stdout ?? ""}`)) return false;
      throw error;
    }
  }

  async assetsForTag(tag) {
    if (!(await this.releaseExists(tag))) return [];
    return this.releaseAssets(await this.releaseId(tag));
  }

  async releaseId(tag) {
    const { stdout } = await this.execFile("gh", ["release", "view", tag, "--repo", this.repository, "--json", "apiUrl", "--jq", ".apiUrl"]);
    const match = stdout.trim().match(/\/releases\/(\d+)$/);
    if (!match) throw new Error(`GitHub release has an invalid API URL: ${tag}.`);
    return match[1];
  }

  async releaseAssets(releaseId) {
    const { stdout } = await this.execFile("gh", ["api", "--paginate", `repos/${this.repository}/releases/${releaseId}/assets?per_page=100`, "--jq", ".[] | [.id, .name] | @tsv"]);
    return stdout.split("\n").filter(Boolean).map((line) => {
      const [id, name] = line.split("\t");
      return { id: Number(id), name };
    });
  }

  async deleteAsset(assetId) {
    const endpoint = `repos/${this.repository}/releases/assets/${assetId}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.execFile("gh", ["api", "--silent", "--method", "DELETE", endpoint]);
        return;
      } catch (error) {
        if (isNotFound(error)) return;
        if (attempt >= this.deleteRetryDelaysMs.length) throw error;
        const delay = this.deleteRetryDelaysMs[attempt];
        console.warn(`Release asset ${assetId} deletion failed; retrying in ${delay} ms.`);
        await this.sleep(delay);
      }
    }
  }
}

function isNotFound(error) {
  return /\bHTTP\s*404\b/i.test(`${error?.message ?? ""} ${error?.stdout ?? ""} ${error?.stderr ?? ""}`);
}

function validateStableMarker(marker, region) {
  if (marker?.schemaVersion !== 2 || marker.kind !== "stable-generation" || marker.region !== region || !Number.isInteger(marker.generation) || marker.generation < 1 || !validDate(marker.createdAt)) {
    throw new Error("invalid stable marker fields");
  }
  validateAssetReference(marker.archive);
  validateAssetReference(marker.manifest);
  validateNamedReference(marker.archive, new RegExp(`^auction-history-${region}-([a-f0-9]{12})-\\d{8}T\\d{9}Z\\.tar\\.gz$`));
  validateNamedReference(marker.manifest, new RegExp(`^manifest-${region}-([a-f0-9]{12})-\\d{8}T\\d{9}Z\\.json$`));
  const timestamp = assetTimestamp(marker.createdAt);
  if (!marker.archive.name.endsWith(`-${timestamp}.tar.gz`) || !marker.manifest.name.endsWith(`-${timestamp}.json`)) throw new Error("stable asset timestamp does not match marker");
  if (marker.generation > 1 && typeof marker.previousMarker !== "string") throw new Error("stable generation has no parent marker");
  return marker;
}

function validateStagingMarker(marker, region) {
  if (marker?.schemaVersion !== 2 || marker.kind !== "staging-generation" || marker.region !== region || !Number.isInteger(marker.revision) || marker.revision < 1 || !validDate(marker.createdAt) || !marker.sessionId || !marker.session || marker.session.region !== region || !marker.artifacts || typeof marker.artifacts !== "object") {
    throw new Error("invalid staging marker fields");
  }
  if (marker.sessionId !== checkpointSessionId(region, marker.session.capturedAt) || marker.createdAt !== marker.session.updatedAt) throw new Error("staging session identity does not match marker");
  if (marker.revision > 1 && typeof marker.previousMarker !== "string") throw new Error("staging revision has no parent marker");
  const completed = [...(marker.session.completedArtifactIds ?? [])].sort();
  if (JSON.stringify(Object.keys(marker.artifacts).sort()) !== JSON.stringify(completed)) throw new Error("staging artifact map does not exactly match completed artifacts");
  for (const [artifactId, reference] of Object.entries(marker.artifacts)) {
    validateAssetReference(reference);
    validateNamedReference(reference, new RegExp(`^checkpoint-${region}-${safeName(artifactId)}-([a-f0-9]{12})-\\d{8}T\\d{9}Z\\.jsonl\\.gz$`));
  }
  return marker;
}

function validateAssetReference(reference) {
  if (!reference || typeof reference.name !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error("invalid asset reference");
}

function validateNamedReference(reference, pattern) {
  const match = reference.name.match(pattern);
  if (!match || !reference.sha256.startsWith(match[1])) throw new Error("asset filename does not match its digest");
}

function assertNoGenerationFork(candidates, region) {
  const generations = new Map();
  for (const candidate of candidates) {
    const prior = generations.get(candidate.marker.generation);
    if (prior && prior !== candidate.markerName) throw new Error(`Conflicting stable generation ${candidate.marker.generation} for region ${region}.`);
    generations.set(candidate.marker.generation, candidate.markerName);
  }
}

function assertNoCheckpointFork(candidates, region) {
  const revisions = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.marker.sessionId}:${candidate.marker.revision}`;
    const prior = revisions.get(key);
    if (prior && prior !== candidate.markerName) throw new Error(`Conflicting staging revision ${candidate.marker.revision} for region ${region}.`);
    revisions.set(key, candidate.markerName);
  }
}

function checkpointSessionId(region, capturedAt) {
  if (!validDate(capturedAt)) throw new Error("Checkpoint session has an invalid capturedAt timestamp.");
  return `${region}-${hashBytes(`${region}\0${capturedAt}`).slice(0, 12)}`;
}

function assetTimestamp(value) {
  if (!validDate(value)) throw new Error(`Invalid generation timestamp: ${value}.`);
  return new Date(value).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function safeName(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Unsafe release asset identifier: ${value}.`);
  return value;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
