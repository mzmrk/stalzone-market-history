import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { buildRegionArchive, validateRegionArchive } from "../scripts/archive.mjs";
import { GitHubReleaseStore } from "../scripts/github-releases.mjs";

const execFileAsync = promisify(execFile);

test("regional archive validation requires every manifest artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-archive-test-"));
  try {
    await mkdir(path.join(directory, "artifacts"));
    await writeFile(path.join(directory, "artifacts", "alpha.jsonl"), '{"price":1,"time":"2026-01-01T00:00:00Z"}\n');
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ status: "complete", artifacts: { alpha: { records: 1 } } }),
    );
    const archive = path.join(directory, "auction-history-eu.tar.gz");
    const built = await buildRegionArchive({ archive, regionDirectory: directory });

    assert.match(built.digest, /^[a-f0-9]{64}$/);
    assert.match(built.checksumLine, /auction-history-eu\.tar\.gz/);
    assert.equal((await validateRegionArchive({ archive })).artifacts.alpha.records, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release checkpoint uploads the completed raw artifact before the session marker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-release-test-"));
  const commands = [];
  let uploadedRaw;
  try {
    const artifactFile = path.join(directory, "alpha.jsonl");
    const sessionFile = path.join(directory, "session.json");
    await writeFile(artifactFile, '{"price":1,"time":"2026-01-01T00:00:00Z","additional":{"qlt":0}}\n');
    await writeFile(sessionFile, '{"completedArtifactIds":["alpha"]}\n');
    const store = new GitHubReleaseStore({
      repository: "owner/data",
      execFileImpl: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === "release" && args[1] === "view") {
          const error = new Error("missing");
          error.code = 1;
          throw error;
        }
        if (args[0] === "release" && args[1] === "upload") {
          const compressed = args.find((argument) => argument.endsWith("eu--alpha.jsonl.gz"));
          uploadedRaw = gunzipSync(await readFile(compressed, null)).toString("utf8");
        }
        return { stdout: "", stderr: "" };
      },
    });

    await store.checkpoint({ artifactFile, artifactId: "alpha", region: "eu", sessionFile });

    assert.equal(uploadedRaw, await readFile(artifactFile, "utf8"));
    const upload = commands.find((command) => command[1] === "release" && command[2] === "upload");
    assert.ok(upload.find((argument) => argument.endsWith("eu--alpha.jsonl.gz")));
    assert.ok(upload.find((argument) => argument.endsWith("eu--session.json")));
    assert.ok(upload.indexOf(upload.find((argument) => argument.endsWith("eu--alpha.jsonl.gz"))) < upload.indexOf(upload.find((argument) => argument.endsWith("eu--session.json"))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("region restore follows the stable pointer and verifies its archive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-restore-test-"));
  const source = path.join(directory, "source");
  const workRoot = path.join(directory, "work");
  const assets = new Map();
  try {
    await mkdir(path.join(source, "artifacts"), { recursive: true });
    await writeFile(path.join(source, "artifacts", "alpha.jsonl"), '{"price":1,"time":"2026-01-01T00:00:00Z"}\n');
    await writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify({ status: "complete", artifacts: { alpha: { records: 1 } } }),
    );
    const built = await buildRegionArchive({
      archive: path.join(directory, "source.tar.gz"),
      regionDirectory: source,
    });
    const versionedName = `auction-history-eu-${built.digest.slice(0, 12)}.tar.gz`;
    assets.set(versionedName, await readFile(built.archive));
    assets.set(
      "latest-eu.json",
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, region: "eu", archive: versionedName, sha256: built.digest }),
      ),
    );
    const store = new GitHubReleaseStore({
      repository: "owner/data",
      execFileImpl: async (command, args) => {
        if (command === "tar") return execFileAsync(command, args);
        if (args[0] === "release" && args[1] === "view") {
          if (args[2] === "market-history-latest") return { stdout: "", stderr: "" };
          const error = new Error("missing");
          error.code = 1;
          throw error;
        }
        if (args[0] === "release" && args[1] === "download") {
          const name = args[args.indexOf("--pattern") + 1];
          const output = args[args.indexOf("--dir") + 1];
          await copyFileFromMemory(assets.get(name), path.join(output, name));
          return { stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    await store.restoreRegion({ region: "eu", workRoot });

    assert.equal(
      await readFile(path.join(workRoot, "eu", "artifacts", "alpha.jsonl"), "utf8"),
      await readFile(path.join(source, "artifacts", "alpha.jsonl"), "utf8"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("region restore treats an absent regional pointer as an empty bootstrap", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-bootstrap-test-"));
  try {
    const store = new GitHubReleaseStore({
      repository: "owner/data",
      execFileImpl: async (_command, args) => {
        if (args[0] === "release" && args[1] === "view") {
          if (args[2] === "market-history-latest") return { stdout: "", stderr: "" };
          const error = new Error("missing");
          error.code = 1;
          throw error;
        }
        if (args[0] === "release" && args[1] === "download") {
          const error = new Error("no assets");
          error.code = 1;
          error.stderr = "no assets to download";
          throw error;
        }
        throw new Error(`Unexpected arguments: ${args.join(" ")}`);
      },
    });

    await store.restoreRegion({ region: "ru", workRoot: directory });
    assert.deepEqual(await readFileOrNull(path.join(directory, "ru", "session.json")), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable publishing verifies the versioned archive before moving its latest pointer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "market-publish-test-"));
  const commands = [];
  const assets = new Map();
  try {
    const archive = path.join(directory, "archive.tar.gz");
    const manifestFile = path.join(directory, "manifest.json");
    await writeFile(archive, "verified archive bytes");
    await writeFile(manifestFile, '{"capturedAt":"2026-08-26T00:00:00.000Z"}\n');
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
    const oldAsset = { id: 10, name: "auction-history-eu-old.tar.gz" };
    const store = new GitHubReleaseStore({
      repository: "owner/data",
      execFileImpl: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === "release" && args[1] === "upload") {
          for (const argument of args.slice(3, args.indexOf("--clobber"))) {
            assets.set(path.basename(argument), await readFile(argument));
          }
        }
        if (args[0] === "release" && args[1] === "download") {
          const name = args[args.indexOf("--pattern") + 1];
          const output = args[args.indexOf("--dir") + 1];
          await copyFileFromMemory(assets.get(name), path.join(output, name));
        }
        if (args[0] === "api" && args.some((argument) => argument.includes("releases?per_page=100"))) {
          return { stdout: "1\n", stderr: "" };
        }
        if (args[0] === "api" && args.some((argument) => argument.includes("releases/1/assets"))) {
          return { stdout: `${oldAsset.id}\t${oldAsset.name}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    await store.publishRegion({ archive, digest, manifestFile, region: "eu" });

    const archiveUpload = commands.findIndex(
      (entry) => entry[1] === "release" && entry[2] === "upload" && entry.some((value) => value.includes(digest.slice(0, 12))),
    );
    const verification = commands.findIndex((entry) => entry[1] === "release" && entry[2] === "download");
    const pointerUpload = commands.findIndex(
      (entry) => entry[1] === "release" && entry[2] === "upload" && entry.some((value) => value.endsWith("latest-eu.json")),
    );
    const oldDelete = commands.findIndex((entry) => entry.includes("repos/owner/data/releases/assets/10"));
    assert.ok(archiveUpload < verification);
    assert.ok(verification < pointerUpload);
    assert.ok(pointerUpload < oldDelete);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function copyFileFromMemory(contents, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function readFileOrNull(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
