import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_TEXT_EXTENSIONS,
  ENTRYPOINT_HINTS,
  MANIFEST_NAMES,
  type RepoFileRecord,
  type RepoScanResult
} from "../domain.js";

const MAX_SAMPLE_BYTES = 24 * 1024;
const MAX_HASH_BYTES = 2 * 1024 * 1024;

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function sha1(value: string | Buffer): string {
  return createHash("sha1").update(value).digest("hex");
}

function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isEntryPointCandidate(relativePath: string, fileName: string): boolean {
  const haystack = `${relativePath} ${fileName}`.toLowerCase();
  return ENTRYPOINT_HINTS.some((hint) => haystack.includes(hint));
}

function isManifestName(fileName: string): boolean {
  return MANIFEST_NAMES.has(fileName);
}

function isLikelyTextByExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("dockerfile")) {
    return true;
  }

  const ext = path.extname(lower);
  if (DEFAULT_TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  const baseName = path.basename(lower);
  return isManifestName(baseName) || baseName.startsWith("readme") || baseName.startsWith("license");
}

async function readSample(filePath: string, maxBytes = MAX_SAMPLE_BYTES): Promise<string> {
  try {
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (slice.includes(0)) {
        return "";
      }
      return slice.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function hashFile(filePath: string, size: number): Promise<string | null> {
  if (size > MAX_HASH_BYTES) {
    return null;
  }

  try {
    const handle = await open(filePath, "r");
    try {
      const hash = createHash("sha1");
      const chunkSize = 64 * 1024;
      const buffer = Buffer.alloc(chunkSize);
      let position = 0;

      while (position < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(chunkSize, size - position),
          position
        );
        if (bytesRead <= 0) {
          break;
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }

      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function classifyFile(
  relativePath: string,
  sample: string,
  fileName: string,
  extension: string
): string {
  const lower = `${relativePath} ${fileName}`.toLowerCase();

  if (isManifestName(fileName)) {
    return "manifest";
  }
  if (lower.includes("docker") || lower.includes("compose") || lower.includes(".github/workflows")) {
    return "infra";
  }
  if (lower.includes("test") || lower.includes("spec") || lower.includes("__tests__")) {
    return "test";
  }
  if (lower.includes("readme") || extension === ".md" || extension === ".txt") {
    return "docs";
  }
  if (isEntryPointCandidate(relativePath, fileName)) {
    return "entrypoint";
  }
  if (extension === ".sql" || sample.includes("CREATE TABLE") || sample.includes("ALTER TABLE")) {
    return "data";
  }
  if (sample.includes("route") || sample.includes("router") || sample.includes("controller")) {
    return "service";
  }
  if (sample.includes("component") || sample.includes("render(") || sample.includes("useState(")) {
    return "ui";
  }
  if (sample.includes("queue") || sample.includes("workflow") || sample.includes("checkpoint")) {
    return "orchestration";
  }
  if (extension === ".json" || extension === ".yaml" || extension === ".yml" || extension === ".toml") {
    return "config";
  }
  return "source";
}

function collectWords(...values: string[]): string[] {
  const words = new Set<string>();
  for (const value of values) {
    for (const word of splitWords(value)) {
      words.add(word);
    }
  }
  return [...words];
}

function buildFingerprint(parts: string[]): string {
  return sha1(parts.sort().join("\n"));
}

export async function scanRepository(rootPath: string): Promise<RepoScanResult> {
  const resolvedRoot = path.resolve(rootPath);
  const rootName = path.basename(resolvedRoot) || resolvedRoot;
  const directories = new Set<string>();
  const files: RepoFileRecord[] = [];
  let ignored = 0;

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = toPosix(path.relative(resolvedRoot, absolutePath));

      if (!relativePath) {
        continue;
      }

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
          ignored += 1;
          continue;
        }
        directories.add(relativePath);
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        ignored += 1;
        continue;
      }

      const baseName = entry.name;
      const extension = path.extname(baseName).toLowerCase();
      const fileStat = await stat(absolutePath);
      const shouldTreatAsText = isLikelyTextByExtension(baseName) || isLikelyTextByExtension(relativePath);
      const sample = shouldTreatAsText ? await readSample(absolutePath) : "";
      const isText = shouldTreatAsText && sample.length > 0;
      const hash = isText ? await hashFile(absolutePath, fileStat.size) : null;
      const category = classifyFile(relativePath, sample, baseName, extension);

      files.push({
        path: absolutePath,
        relativePath,
        extension,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        isText,
        hash,
        category,
        sample
      });
    }
  }

  await visit(resolvedRoot);

  const manifests = files.filter((file) => file.category === "manifest").map((file) => file.relativePath);
  const configs = files.filter((file) => file.category === "config" || file.category === "infra").map((file) => file.relativePath);
  const tests = files.filter((file) => file.category === "test").map((file) => file.relativePath);
  const entrypoints = files.filter((file) => file.category === "entrypoint").map((file) => file.relativePath);
  const docs = files.filter((file) => file.category === "docs").map((file) => file.relativePath);
  const fingerprint = buildFingerprint(
    files.map((file) => `${file.relativePath}:${file.hash ?? `${file.size}:${file.mtimeMs}`}`)
  );

  return {
    rootName,
    rootPath: resolvedRoot,
    files,
    directories: [...directories].sort(),
    manifests: [...new Set(manifests)].sort(),
    configs: [...new Set(configs)].sort(),
    tests: [...new Set(tests)].sort(),
    entrypoints: [...new Set(entrypoints)].sort(),
    docs: [...new Set(docs)].sort(),
    ignored,
    fingerprint
  };
}

export function extractPathWords(file: RepoFileRecord): string[] {
  return collectWords(file.relativePath, path.basename(file.relativePath));
}
