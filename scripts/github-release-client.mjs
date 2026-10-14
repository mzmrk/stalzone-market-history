import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const API_ROOT = "https://api.github.com";
const UPLOAD_ROOT = "https://uploads.github.com";
const API_VERSION = "2022-11-28";

export class GitHubReleaseClient {
  constructor({
    repository,
    token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    fetchImpl = fetch,
    sleepImpl = sleep,
    nowImpl = Date.now,
    mutationIntervalMs = 1_000,
    maxRetries = 6,
  }) {
    if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
      throw new Error("GitHub release storage requires an owner/repository name.");
    }
    if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required for GitHub release storage.");
    this.repository = repository;
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.now = nowImpl;
    this.mutationIntervalMs = mutationIntervalMs;
    this.maxRetries = maxRetries;
    this.releasesLoaded = false;
    this.releases = new Map();
    this.assets = new Map();
    this.lastMutationAt = Number.NEGATIVE_INFINITY;
  }

  async releaseExists(tag) {
    await this.loadReleases();
    return this.releases.has(tag);
  }

  async ensureRelease({ draft, notes, tag, title }) {
    await this.loadReleases();
    if (this.releases.has(tag)) return this.releases.get(tag);
    const release = await this.request(`${API_ROOT}/repos/${this.repository}/releases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      bodyFactory: () => JSON.stringify({
        tag_name: tag,
        name: title,
        body: notes,
        draft,
        prerelease: false,
      }),
    });
    this.releases.set(tag, release);
    this.assets.set(tag, new Map());
    return release;
  }

  async listAssets(tag) {
    const release = await this.requireRelease(tag);
    if (this.assets.has(tag)) return [...this.assets.get(tag).values()];
    return this.refreshAssets(tag, release);
  }

  async refreshAssets(tag, release = undefined) {
    const resolvedRelease = release ?? await this.requireRelease(tag);
    const assets = new Map();
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        `${API_ROOT}/repos/${this.repository}/releases/${resolvedRelease.id}/assets?per_page=100&page=${page}`,
      );
      for (const asset of batch) assets.set(asset.name, asset);
      if (batch.length < 100) break;
    }
    this.assets.set(tag, assets);
    return [...assets.values()];
  }

  async uploadAsset(tag, file) {
    const release = await this.requireRelease(tag);
    await this.listAssets(tag);
    const name = path.basename(file);
    const existing = this.assets.get(tag).get(name);
    if (existing) return existing;
    const info = await stat(file);
    const query = new URLSearchParams({ name });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const asset = await this.request(
          `${UPLOAD_ROOT}/repos/${this.repository}/releases/${release.id}/assets?${query}`,
          {
            method: "POST",
            headers: {
              "content-length": String(info.size),
              "content-type": "application/octet-stream",
            },
            bodyFactory: () => createReadStream(file),
            duplex: "half",
            retryTransient: false,
          },
        );
        this.assets.get(tag).set(asset.name, asset);
        return asset;
      } catch (error) {
        if (!isAmbiguousUploadFailure(error)) throw error;
        const refreshed = await this.refreshAssets(tag, release);
        const uploaded = refreshed.find((asset) => asset.name === name);
        if (uploaded) return uploaded;
        if (attempt >= this.maxRetries) throw error;
        await this.sleep(transientDelay(attempt));
      }
    }
  }

  async downloadAsset(tag, name, directory) {
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, name);
    try {
      await stat(destination);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await this.listAssets(tag);
    const asset = this.assets.get(tag).get(name);
    if (!asset) return false;
    const bytes = await this.request(
      `${API_ROOT}/repos/${this.repository}/releases/assets/${asset.id}`,
      {
        headers: { accept: "application/octet-stream" },
        responseType: "buffer",
      },
    );
    await writeFile(destination, bytes);
    return true;
  }

  async deleteAsset(assetId) {
    try {
      await this.request(`${API_ROOT}/repos/${this.repository}/releases/assets/${assetId}`, {
        method: "DELETE",
        responseType: "empty",
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        this.removeCachedAsset(assetId);
        return;
      }
      throw error;
    }
    this.removeCachedAsset(assetId);
  }

  removeCachedAsset(assetId) {
    for (const assets of this.assets.values()) {
      for (const [name, asset] of assets) if (asset.id === assetId) assets.delete(name);
    }
  }

  async requireRelease(tag) {
    await this.loadReleases();
    const release = this.releases.get(tag);
    if (!release) throw new GitHubApiError(`GitHub release does not exist: ${tag}.`, { status: 404 });
    return release;
  }

  async loadReleases() {
    if (this.releasesLoaded) return;
    const releases = new Map();
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        `${API_ROOT}/repos/${this.repository}/releases?per_page=100&page=${page}`,
      );
      for (const release of batch) releases.set(release.tag_name, release);
      if (batch.length < 100) break;
    }
    this.releases = releases;
    this.releasesLoaded = true;
  }

  async request(url, {
    method = "GET",
    headers = {},
    bodyFactory,
    duplex,
    responseType = "json",
    retryTransient = true,
  } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      if (isMutation(method)) await this.throttleMutation();
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.token}`,
            "user-agent": "stalzone-market-history",
            "x-github-api-version": API_VERSION,
            ...headers,
          },
          body: bodyFactory ? bodyFactory() : undefined,
          duplex,
          redirect: "follow",
        });
      } catch (error) {
        if (!retryTransient || attempt >= this.maxRetries) throw error;
        await this.sleep(transientDelay(attempt));
        continue;
      }

      if (isMutation(method)) this.lastMutationAt = this.now();
      if (response.ok) return readResponse(response, responseType);

      const detail = await response.text();
      if (isRateLimited(response, detail)) {
        if (attempt >= this.maxRetries) {
          throw new GitHubApiError(apiMessage(response, detail), { status: response.status, detail });
        }
        await this.sleep(rateLimitDelay(response, attempt, this.now()));
        continue;
      }
      if (retryTransient && response.status >= 500 && attempt < this.maxRetries) {
        await this.sleep(transientDelay(attempt));
        continue;
      }
      throw new GitHubApiError(apiMessage(response, detail), { status: response.status, detail });
    }
  }

  async throttleMutation() {
    const remaining = this.mutationIntervalMs - (this.now() - this.lastMutationAt);
    if (remaining > 0) await this.sleep(remaining);
  }
}

export class GitHubApiError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.detail = detail;
  }
}

function isMutation(method) {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase());
}

function isAmbiguousUploadFailure(error) {
  return !(error instanceof GitHubApiError) || error.status === 422 || error.status >= 500;
}

function isRateLimited(response, detail) {
  if (![403, 429].includes(response.status)) return false;
  return response.headers.get("retry-after") !== null
    || response.headers.get("x-ratelimit-remaining") === "0"
    || /rate limit|secondary rate/i.test(detail);
}

function rateLimitDelay(response, attempt, now) {
  const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.ceil(retryAfter * 1_000) + 1_000;
  const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
  if (Number.isFinite(reset)) return Math.max(1_000, reset * 1_000 - now + 1_000);
  return Math.min(60_000 * (2 ** attempt), 15 * 60_000);
}

function transientDelay(attempt) {
  return Math.min(1_000 * (2 ** attempt), 30_000);
}

async function readResponse(response, responseType) {
  if (responseType === "empty" || response.status === 204) return null;
  if (responseType === "buffer") return Buffer.from(await response.arrayBuffer());
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function apiMessage(response, detail) {
  let message = detail;
  try {
    message = JSON.parse(detail).message ?? detail;
  } catch {
    // Preserve a non-JSON response body as diagnostic text.
  }
  return `GitHub API ${response.status} ${response.statusText}: ${message || "request failed"}`;
}
