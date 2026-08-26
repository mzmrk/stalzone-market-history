export const regions = ["eu", "ru", "na", "sea", "nea"];

export function normalizeRegion(value) {
  const region = String(value ?? "").toLowerCase();
  if (!regions.includes(region)) {
    throw new Error(`Unsupported region: ${value}. Expected one of ${regions.join(", ")}.`);
  }
  return region;
}

export function nextRegion(region) {
  const index = regions.indexOf(normalizeRegion(region));
  return regions[index + 1] ?? null;
}
