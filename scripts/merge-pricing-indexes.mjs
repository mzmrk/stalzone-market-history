import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePricingRegion, pricingRegions } from "./pricing-regions.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputFile = path.resolve(projectRoot, process.argv[2] ?? "data/pricing-index.json");
  const inputFiles = process.argv.slice(3).map((file) => path.resolve(projectRoot, file));
  await mergePricingIndexes({ outputFile, inputFiles });
}

export async function mergePricingIndexes({ outputFile, inputFiles }) {
  const existing = await readOptionalJson(outputFile);
  const bundle = normalizeBundle(existing);

  for (const inputFile of inputFiles) {
    const index = await readJson(inputFile);
    validateRegionalIndex(index, inputFile);
    bundle.regions[index.region] = index;
  }

  bundle.regions = Object.fromEntries(
    pricingRegions.flatMap((region) => bundle.regions[region] ? [[region, bundle.regions[region]]] : []),
  );
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function normalizeBundle(value) {
  if (value?.schemaVersion === 1 && value.defaultRegion === "eu" && isRecord(value.regions)) {
    const regions = {};
    for (const [regionName, index] of Object.entries(value.regions)) {
      const region = normalizePricingRegion(regionName);
      validateRegionalIndex(index, `existing ${region} index`);
      if (index.region !== region) throw new Error(`Existing region key ${region} does not match index region ${index.region}.`);
      regions[region] = index;
    }
    return { schemaVersion: 1, defaultRegion: "eu", regions };
  }
  if (isRecord(value) && typeof value.region === "string") {
    validateRegionalIndex(value, "existing regional index");
    return { schemaVersion: 1, defaultRegion: "eu", regions: { [value.region]: value } };
  }
  if (value === null) return { schemaVersion: 1, defaultRegion: "eu", regions: {} };
  throw new Error("Existing pricing index is neither a regional index nor a supported pricing bundle.");
}

function validateRegionalIndex(value, source) {
  if (!isRecord(value) || typeof value.region !== "string") {
    throw new Error(`Invalid regional pricing index from ${source}: region is missing.`);
  }
  const normalizedRegion = normalizePricingRegion(value.region);
  if (value.region !== normalizedRegion) {
    throw new Error(`Invalid regional pricing index from ${source}: region must be lowercase.`);
  }
  if (!isRecord(value.sourceWindow) || typeof value.sourceWindow.asOf !== "string" || !isRecord(value.artifacts)) {
    throw new Error(`Invalid regional pricing index from ${source}: sourceWindow or artifacts is missing.`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
