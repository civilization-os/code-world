import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FileInsight, RepositoryAnalysis } from "./domain.js";
import type { LocaleCode } from "./i18n.js";
import { workspaceRootDir } from "./runtimePaths.js";

type FileInsightMap = Record<string, FileInsight>;
type RepoAnalysisMap = Record<string, RepositoryAnalysis>;

export class AnalysisCache {
  private readonly rootDir: string;
  private readonly cacheDir: string;
  private readonly fileInsightFile: string;
  private readonly repoResultFile: string;
  private fileInsights: FileInsightMap | null = null;
  private repoResults: RepoAnalysisMap | null = null;

  constructor(rootDir = path.join(workspaceRootDir(), ".repo-inspector")) {
    this.rootDir = rootDir;
    this.cacheDir = path.join(rootDir, "cache");
    this.fileInsightFile = path.join(this.cacheDir, "file-insights.json");
    this.repoResultFile = path.join(this.cacheDir, "repo-results.json");
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await this.ensureReady();
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  private async loadFileInsights(): Promise<FileInsightMap> {
    if (this.fileInsights) {
      return this.fileInsights;
    }
    this.fileInsights = await this.readJson<FileInsightMap>(this.fileInsightFile, {});
    return this.fileInsights;
  }

  private async loadRepoResults(): Promise<RepoAnalysisMap> {
    if (this.repoResults) {
      return this.repoResults;
    }
    this.repoResults = await this.readJson<RepoAnalysisMap>(this.repoResultFile, {});
    return this.repoResults;
  }

  async getFileInsight(key: string): Promise<FileInsight | undefined> {
    const map = await this.loadFileInsights();
    return map[key];
  }

  async saveFileInsight(key: string, insight: FileInsight): Promise<void> {
    const map = await this.loadFileInsights();
    map[key] = insight;
    await this.writeJson(this.fileInsightFile, map);
  }

  private repoKey(locale: LocaleCode, fingerprint: string, profileKey: string): string {
    return `${locale}:${fingerprint}:${profileKey}`;
  }

  async getRepoResult(
    fingerprint: string,
    locale: LocaleCode,
    profileKey: string
  ): Promise<RepositoryAnalysis | undefined> {
    const map = await this.loadRepoResults();
    return map[this.repoKey(locale, fingerprint, profileKey)];
  }

  async saveRepoResult(
    fingerprint: string,
    locale: LocaleCode,
    profileKey: string,
    analysis: RepositoryAnalysis
  ): Promise<void> {
    const map = await this.loadRepoResults();
    map[this.repoKey(locale, fingerprint, profileKey)] = analysis;
    await this.writeJson(this.repoResultFile, map);
  }
}
