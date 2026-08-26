import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegionArchive } from "./archive.mjs";
import { collectRegion } from "./collector.mjs";
import { GitHubReleaseStore } from "./github-releases.mjs";
import { nextRegion, normalizeRegion } from "./regions.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listingUrl = "https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/global/listing.json";

const region = normalizeRegion(process.argv[2] ?? process.env.MARKET_REGION ?? "eu");
const clientId = process.env.STALZONE_CLIENT_ID;
const clientSecret = process.env.STALZONE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error("Missing STALZONE_CLIENT_ID or STALZONE_CLIENT_SECRET.");
}

const workRoot = path.resolve(projectRoot, process.env.MARKET_WORK_ROOT ?? ".work");
const resultFile = path.join(workRoot, `result-${region}.json`);
const repository = process.env.GITHUB_REPOSITORY;
const remoteEnabled = process.env.MARKET_LOCAL_ONLY !== "1" && Boolean(repository && process.env.GITHUB_ACTIONS);
const store = remoteEnabled ? new GitHubReleaseStore({ repository }) : null;

await mkdir(workRoot, { recursive: true });
if (store) await store.restoreRegion({ region, workRoot });

const result = await collectRegion({
  checkpoint: store ? (checkpoint) => store.checkpoint(checkpoint) : async () => {},
  credentials: { clientId, clientSecret },
  fetchImpl: fetch,
  heartbeatMs: integerEnvironment("MARKET_HEARTBEAT_MS", 300_000),
  listingUrl,
  maxRuntimeMs: integerEnvironment(
    "MARKET_MAX_RUNTIME_MS",
    process.env.GITHUB_ACTIONS ? 5 * 60 * 60 * 1_000 + 20 * 60 * 1_000 : Number.POSITIVE_INFINITY,
  ),
  maxPagesPerArtifact: integerEnvironment("MARKET_MAX_PAGES_PER_ARTIFACT", Number.POSITIVE_INFINITY),
  pageLimit: 200,
  progressEvery: integerEnvironment("MARKET_PROGRESS_EVERY", 1),
  region,
  workRoot,
  windowDays: 365,
});

if (result.complete) {
  const outputDirectory = path.join(workRoot, "output");
  await mkdir(outputDirectory, { recursive: true });
  const archive = path.join(outputDirectory, `auction-history-${region}.tar.gz`);
  const built = await buildRegionArchive({ archive, regionDirectory: result.regionDirectory });
  if (store) {
    await store.publishRegion({
      archive,
      digest: built.digest,
      manifestFile: result.manifestFile,
      region,
    });
    await store.clearStagingRegion(region);
  }
}

const workflowResult = {
  ...result,
  nextRegion: result.complete ? nextRegion(region) : region,
};
await writeFile(resultFile, `${JSON.stringify(workflowResult, null, 2)}\n`);
console.log(`Collection result: ${JSON.stringify(workflowResult)}`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `complete=${workflowResult.complete}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `next_region=${workflowResult.nextRegion ?? ""}\n`);
}

function integerEnvironment(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
