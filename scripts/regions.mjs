export const regions = ["eu", "ru", "na", "sea", "nea"];

export function normalizeRegion(value) {
  const region = String(value ?? "").toLowerCase();
  if (!regions.includes(region)) {
    throw new Error(`Unsupported region: ${value}. Expected one of ${regions.join(", ")}.`);
  }
  return region;
}
