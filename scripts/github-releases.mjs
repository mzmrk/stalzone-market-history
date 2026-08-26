import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);

export class GitHubReleaseStore {
  constructor({
    repository,
    stableTag = "market-history-latest",
    stagingTag = "market-history-staging",
    execFileImpl = execFileAsync,
  }) {
    if (!repository) throw new Error("GitHub release storage requires a repository name.");
    this.repository = repository;
    this.stableTag = stableTag;
    this.stagingTag = stagingTag;
    this.execFile = execFileImpl;
  }

  async restoreRegion({ region, workRoot }) {
    const regionDirectory = path.join(workRoot, region);
    await mkdir(regionDirectory, { recursive: true });
    const temporary = await mkdtemp(path.join(tmpdir(), `market-history-restore-${region}-`));
    try {
      if (await this.releaseExists(this.stableTag)) {
        const pointerName = `latest-${region}.json`;
        const downloaded = await this.download(this.stableTag, pointerName, temporary);
        if (downloaded) {
          const pointer = JSON.parse(await readFile(path.join(temporary, pointerName), "utf8"));
          const archivePattern = new RegExp(`^auction-history-${region}-[a-f0-9]{12}\\.tar\\.gz$`);
          if (
            pointer.schemaVersion !== 1 ||
            pointer.region !== region ||
            !archivePattern.test(pointer.archive) ||
            !/^[a-f0-9]{64}$/.test(pointer.sha256)
          ) {
            throw new Error(`Stable release pointer is invalid for region ${region}.`);
          }
          if (!(await this.download(this.stableTag, pointer.archive, temporary))) {
            throw new Error(`Stable release archive is missing for region ${region}: ${pointer.archive}.`);
          }
          const archive = path.join(temporary, pointer.archive);
          const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
          if (actual !== pointer.sha256) {
            throw new Error(`Stable release archive failed SHA-256 verification for region ${region}.`);
          }
          await this.execFile("tar", ["-xzf", archive, "-C", regionDirectory]);
        }
      }

      if (await this.releaseExists(this.stagingTag)) {
        await this.download(this.stagingTag, `${region}--*`, temporary);
        for (const entry of await readdir(temporary, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith(`${region}--`)) continue;
          if (entry.name === `${region}--session.json`) {
            await copyFile(path.join(temporary, entry.name), path.join(regionDirectory, "session.json"));
            continue;
          }
          const match = entry.name.match(new RegExp(`^${region}--(.+)\\.jsonl\\.gz$`));
          if (!match) continue;
          const destination = path.join(regionDirectory, "artifacts", `${match[1]}.jsonl`);
          await mkdir(path.dirname(destination), { recursive: true });
          await pipeline(createReadStream(path.join(temporary, entry.name)), createGunzip(), createWriteStream(destination));
        }
      }
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
      const assets = [];
      if (artifactId && artifactFile) {
        const compressed = path.join(temporary, `${region}--${artifactId}.jsonl.gz`);
        await pipeline(createReadStream(artifactFile), createGzip({ level: 9 }), createWriteStream(compressed));
        assets.push(compressed);
      }
      const sessionAsset = path.join(temporary, `${region}--session.json`);
      await copyFile(sessionFile, sessionAsset);
      assets.push(sessionAsset);
      await this.execFile("gh", ["release", "upload", this.stagingTag, ...assets, "--clobber", "--repo", this.repository]);
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
      const version = digest.slice(0, 12);
      const archiveName = `auction-history-${region}-${version}.tar.gz`;
      const manifestName = `manifest-${region}-${version}.json`;
      const archiveAsset = path.join(temporary, archiveName);
      const manifestAsset = path.join(temporary, manifestName);
      const checksumAsset = path.join(temporary, `auction-history-${region}-${version}.sha256`);
      const latestAsset = path.join(temporary, `latest-${region}.json`);
      await copyFile(archive, archiveAsset);
      await copyFile(manifestFile, manifestAsset);
      await writeFile(checksumAsset, `${digest}  ${archiveName}\n`);
      await this.execFile("gh", [
        "release",
        "upload",
        this.stableTag,
        archiveAsset,
        manifestAsset,
        checksumAsset,
        "--clobber",
        "--repo",
        this.repository,
      ]);
      await this.verifyReleaseAsset({ assetName: archiveName, digest, directory: temporary });
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      await writeFile(
        latestAsset,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            region,
            capturedAt: manifest.capturedAt,
            archive: archiveName,
            manifest: manifestName,
            sha256: digest,
          },
          null,
          2,
        )}\n`,
      );
      await this.execFile("gh", [
        "release",
        "upload",
        this.stableTag,
        latestAsset,
        "--clobber",
        "--repo",
        this.repository,
      ]);
      await this.removeSupersededStableAssets({ keepVersion: version, region });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async verifyReleaseAsset({ assetName, digest, directory }) {
    const verificationDirectory = path.join(directory, "verify");
    await mkdir(verificationDirectory, { recursive: true });
    await this.download(this.stableTag, assetName, verificationDirectory);
    const actual = createHash("sha256")
      .update(await readFile(path.join(verificationDirectory, assetName)))
      .digest("hex");
    if (actual !== digest) throw new Error(`Published release asset failed SHA-256 verification: ${assetName}.`);
  }

  async removeSupersededStableAssets({ keepVersion, region }) {
    const releaseId = await this.releaseId(this.stableTag);
    const assets = await this.releaseAssets(releaseId);
    const keep = new Set([
      `auction-history-${region}-${keepVersion}.tar.gz`,
      `auction-history-${region}-${keepVersion}.sha256`,
      `manifest-${region}-${keepVersion}.json`,
      `latest-${region}.json`,
    ]);
    for (const asset of assets) {
      const belongsToRegion =
        asset.name.startsWith(`auction-history-${region}-`) ||
        asset.name.startsWith(`manifest-${region}-`);
      if (belongsToRegion && !keep.has(asset.name)) await this.deleteAsset(asset.id);
    }
  }

  async clearStagingRegion(region) {
    if (!(await this.releaseExists(this.stagingTag))) return;
    const releaseId = await this.releaseId(this.stagingTag);
    for (const asset of await this.releaseAssets(releaseId)) {
      if (asset.name.startsWith(`${region}--`)) await this.deleteAsset(asset.id);
    }
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
      await this.execFile("gh", [
        "release",
        "download",
        tag,
        "--pattern",
        pattern,
        "--dir",
        directory,
        "--clobber",
        "--repo",
        this.repository,
      ]);
      return true;
    } catch (error) {
      if (
        error?.code === 1 &&
        /no files matched|no assets (?:match|to download)|not found/i.test(
          `${error.stderr ?? ""} ${error.stdout ?? ""}`,
        )
      ) {
        return false;
      }
      throw error;
    }
  }

  async releaseId(tag) {
    const { stdout } = await this.execFile("gh", [
      "api",
      "--paginate",
      `repos/${this.repository}/releases?per_page=100`,
      "--jq",
      `.[] | select(.tag_name == ${JSON.stringify(tag)}) | .id`,
    ]);
    const id = stdout.trim();
    if (!id) throw new Error(`GitHub release not found: ${tag}.`);
    return id;
  }

  async releaseAssets(releaseId) {
    const { stdout } = await this.execFile("gh", [
      "api",
      "--paginate",
      `repos/${this.repository}/releases/${releaseId}/assets?per_page=100`,
      "--jq",
      ".[] | [.id, .name] | @tsv",
    ]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, name] = line.split("\t");
        return { id: Number(id), name };
      });
  }

  async deleteAsset(assetId) {
    await this.execFile("gh", ["api", "--method", "DELETE", `repos/${this.repository}/releases/assets/${assetId}`]);
  }
}
