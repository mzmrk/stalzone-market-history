import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitHubReleaseStore } from "./github-releases.mjs";
import { mergePricingIndexes } from "./merge-pricing-indexes.mjs";
import { pricingRegions } from "./pricing-regions.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required to read published market history.");
  await buildPublishedPrices({ repository, outputFile: path.join(projectRoot, "data", "pricing-index.json") });
}

export async function buildPublishedPrices({
  repository,
  outputFile,
  regions = pricingRegions,
  store = new GitHubReleaseStore({ repository }),
  generateIndex = generateRegionalIndex,
}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "market-published-prices-"));
  const regionalIndexes = [];
  try {
    for (const region of regions) {
      const regionDirectory = path.join(temporary, region);
      await mkdir(regionDirectory, { recursive: true });
      const generation = await store.downloadLatestStableGeneration({ directory: regionDirectory, region });
      if (!generation) {
        console.log(`No stable ${region.toUpperCase()} archive; retaining its current price index.`);
        continue;
      }
      const regionalIndex = path.join(regionDirectory, `pricing-index-${region}.json`);
      await generateIndex({ archive: generation.archivePath, outputFile: regionalIndex, region });
      regionalIndexes.push(regionalIndex);
    }
    if (regionalIndexes.length > 0) {
      await mergePricingIndexes({ outputFile, inputFiles: regionalIndexes });
    }
    return regionalIndexes.map((file) => path.basename(file).slice(14, -5));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function generateRegionalIndex({ archive, outputFile, region }) {
  await execFileAsync("node", ["scripts/generate-pricing-index.mjs", region, archive, outputFile], {
    cwd: projectRoot,
  });
}
