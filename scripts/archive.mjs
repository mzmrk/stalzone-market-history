import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function buildRegionArchive({ archive, regionDirectory, execFileImpl = execFileAsync }) {
  const temporary = `${archive}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  try {
    await execFileImpl("tar", ["-czf", temporary, "-C", regionDirectory, "manifest.json", "artifacts"]);
    await validateRegionArchive({ archive: temporary, execFileImpl });
    await rename(temporary, archive);
  } finally {
    await rm(temporary, { force: true });
  }
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  return { archive, digest, checksumLine: `${digest}  ${path.basename(archive)}\n` };
}

export async function validateRegionArchive({ archive, execFileImpl = execFileAsync }) {
  const { stdout: manifestText } = await execFileImpl("tar", ["-xOzf", archive, "manifest.json"]);
  const manifest = JSON.parse(manifestText);
  if (manifest.status !== "complete" || !manifest.artifacts || typeof manifest.artifacts !== "object") {
    throw new Error("Regional archive manifest is incomplete or invalid.");
  }
  const { stdout: listing } = await execFileImpl("tar", ["-tzf", archive]);
  const members = new Set(listing.split("\n").filter(Boolean));
  for (const artifactId of Object.keys(manifest.artifacts)) {
    if (!members.has(`artifacts/${artifactId}.jsonl`)) {
      throw new Error(`Regional archive is missing artifacts/${artifactId}.jsonl.`);
    }
  }
  return manifest;
}
