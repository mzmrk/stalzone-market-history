export const pricingRegions = ["eu", "ru", "na", "sea", "nea"];

export function normalizePricingRegion(value) {
  const region = String(value).toLowerCase();
  if (!pricingRegions.includes(region)) {
    throw new Error(`Unsupported pricing region: ${value}. Expected one of ${pricingRegions.join(", ")}.`);
  }
  return region;
}
