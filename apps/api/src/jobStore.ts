import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  ANALYSIS_STAGES,
  type AnalysisJobSnapshot,
  type AnalysisStage,
  type RepositoryAnalysis,
  type StepStatus,
  type TimelineEntry
} from "./domain.js";
import type { LocaleCode } from "./i18n.js";
import { workspaceRootDir } from "./runtimePaths.js";

type JobPatch = Partial<Omit<AnalysisJobSnapshot, "id" | "createdAt" | "repoPath" | "repoName">>;
type CreateJobOptions = {
  sourceJobId?: string;
  revision?: number;
};

export class JobStore {
  private readonly rootDir: string;
  private readonly jobsDir: string;
  private readonly recordsDir: string;
  private readonly jobs = new Map<string, AnalysisJobSnapshot>();
  private readonly emitters = new Map<string, EventEmitter>();

  constructor(rootDir = path.join(workspaceRootDir(), ".repo-inspector")) {
    this.rootDir = rootDir;
    this.jobsDir = path.join(rootDir, "jobs");
    this.recordsDir = path.join(rootDir, "records");
    this.bootstrapFromDisk();
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.recordsDir, { recursive: true });
  }

  private async persist(snapshot: AnalysisJobSnapshot): Promise<void> {
    await this.ensureReady();
    const filePath = path.join(this.jobsDir, `${snapshot.id}.json`);
    await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  private normalizeSnapshot(snapshot: AnalysisJobSnapshot): AnalysisJobSnapshot {
    return {
      ...snapshot,
      revision: snapshot.revision ?? 1,
      sourceJobId: snapshot.sourceJobId
    };
  }

  private async persistRecordArtifacts(snapshot: AnalysisJobSnapshot): Promise<void> {
    if (!snapshot.analysis) {
      return;
    }
    await this.ensureReady();
    const recordDir = path.join(this.recordsDir, snapshot.id);
    await mkdir(recordDir, { recursive: true });
    const manifest = {
      id: snapshot.id,
      sourceJobId: snapshot.sourceJobId ?? null,
      revision: snapshot.revision,
      locale: snapshot.locale,
      repoPath: snapshot.repoPath,
      repoName: snapshot.repoName,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      status: snapshot.status,
      analysisVersion: snapshot.analysis.analysisVersion,
      analysisMode: snapshot.analysis.analysisMode,
      analysisProfileKey: snapshot.analysis.analysisProfileKey,
      generatedAt: snapshot.analysis.generatedAt,
      fingerprint: snapshot.analysis.fingerprint
    };
    await writeFile(path.join(recordDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(recordDir, "analysis.json"), `${JSON.stringify(snapshot.analysis, null, 2)}\n`, "utf8");
    await writeFile(path.join(recordDir, "technical.md"), `${snapshot.analysis.technicalMarkdown}\n`, "utf8");
    await writeFile(path.join(recordDir, "business.md"), `${snapshot.analysis.businessMarkdown}\n`, "utf8");
    await writeFile(path.join(recordDir, "report.md"), `${snapshot.analysis.reportMarkdown}\n`, "utf8");
  }

  private bootstrapFromDisk(): void {
    try {
      if (!existsSync(this.jobsDir)) {
        return;
      }
      for (const entry of readdirSync(this.jobsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(this.jobsDir, entry.name);
        try {
          const raw = readFileSync(filePath, "utf8");
          const parsed = JSON.parse(raw) as AnalysisJobSnapshot;
          if (parsed && typeof parsed.id === "string") {
            const normalized = this.normalizeSnapshot(parsed);
            this.jobs.set(normalized.id, normalized);
            this.emitters.set(normalized.id, new EventEmitter());
          }
        } catch {
          // Ignore malformed persisted jobs and keep booting.
        }
      }
    } catch {
      // Ignore disk bootstrap errors and keep an empty in-memory store.
    }
  }

  private makeTimeline(): TimelineEntry[] {
    return ANALYSIS_STAGES.map((stage) => ({
      stage: stage.stage,
      label: stage.label,
      status: "pending" as StepStatus
    }));
  }

  private now(): string {
    return new Date().toISOString();
  }

  create(repoPath: string, locale: LocaleCode, options: CreateJobOptions = {}): AnalysisJobSnapshot {
    const id = randomUUID();
    const repoName = path.basename(path.resolve(repoPath)) || repoPath;
    const snapshot: AnalysisJobSnapshot = {
      id,
      sourceJobId: options.sourceJobId,
      revision: options.revision ?? 1,
      locale,
      status: "queued",
      repoPath: path.resolve(repoPath),
      repoName,
      createdAt: this.now(),
      updatedAt: this.now(),
      currentStage: "scanRepo",
      currentLabel: "Queued",
      progress: 0,
      error: null,
      timeline: this.makeTimeline(),
      analysis: null
    };
    this.jobs.set(id, this.normalizeSnapshot(snapshot));
    this.emitters.set(id, new EventEmitter());
    void this.persist(snapshot);
    return snapshot;
  }

  get(id: string): AnalysisJobSnapshot | undefined {
    return this.jobs.get(id);
  }

  update(id: string, patch: JobPatch): AnalysisJobSnapshot {
    const current = this.jobs.get(id);
    if (!current) {
      throw new Error(`Unknown job: ${id}`);
    }
    const next: AnalysisJobSnapshot = {
      ...current,
      ...patch,
      updatedAt: this.now(),
      timeline: patch.timeline ?? current.timeline,
      analysis: patch.analysis ?? current.analysis
    };
    this.jobs.set(id, next);
    void this.persist(next);
    this.emitters.get(id)?.emit("update", next);
    return next;
  }

  startStage(id: string, stage: AnalysisStage, message?: string): AnalysisJobSnapshot {
    const current = this.jobs.get(id);
    if (!current) {
      throw new Error(`Unknown job: ${id}`);
    }
    const stageMeta = ANALYSIS_STAGES.find((item) => item.stage === stage);
    const nextTimeline = current.timeline.map((item) =>
      item.stage === stage
        ? {
            ...item,
            status: "running" as StepStatus,
            startedAt: item.startedAt ?? this.now(),
            message: message ?? item.message
          }
        : item.status === "running"
          ? { ...item, status: "done" as StepStatus, endedAt: item.endedAt ?? this.now() }
          : item
    );
    return this.update(id, {
      currentStage: stage,
      currentLabel: stageMeta?.label ?? stage,
      progress: stageMeta?.progress ?? current.progress,
      timeline: nextTimeline
    });
  }

  finishStage(id: string, stage: AnalysisStage, message?: string): AnalysisJobSnapshot {
    const current = this.jobs.get(id);
    if (!current) {
      throw new Error(`Unknown job: ${id}`);
    }
    const nextTimeline = current.timeline.map((item) =>
      item.stage === stage
        ? {
            ...item,
            status: "done" as StepStatus,
            endedAt: this.now(),
            message: message ?? item.message
          }
        : item
    );
    return this.update(id, {
      timeline: nextTimeline
    });
  }

  fail(id: string, error: unknown): AnalysisJobSnapshot {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.jobs.get(id);
    if (!current) {
      throw new Error(`Unknown job: ${id}`);
    }
    const nextTimeline = current.timeline.map((item) =>
      item.stage === current.currentStage && item.status === "running"
        ? { ...item, status: "error" as StepStatus, endedAt: this.now(), message }
        : item
    );
    return this.update(id, {
      status: "failed",
      error: message,
      timeline: nextTimeline
    });
  }

  complete(id: string, analysis: RepositoryAnalysis): AnalysisJobSnapshot {
    const current = this.jobs.get(id);
    if (!current) {
      throw new Error(`Unknown job: ${id}`);
    }
    const cacheRestoredMessage = analysis.locale === "zh-CN" ? "已从缓存恢复报告" : "Restored from cache";
    const nextTimeline = current.timeline.map((item) =>
      item.stage === current.currentStage
        ? { ...item, status: "done" as StepStatus, endedAt: this.now() }
        : item.status === "running"
          ? { ...item, status: "done" as StepStatus, endedAt: this.now() }
          : analysis.cacheHit && item.status === "pending"
            ? { ...item, status: "done" as StepStatus, endedAt: this.now(), message: item.message ?? cacheRestoredMessage }
            : item
    );
    return this.update(id, {
      status: "completed",
      progress: 100,
      analysis,
      error: null,
      timeline: nextTimeline
    });
  }

  snapshot(id: string): AnalysisJobSnapshot | undefined {
    return this.jobs.get(id);
  }

  async loadFromDisk(id: string): Promise<AnalysisJobSnapshot | undefined> {
    try {
      const raw = await readFile(path.join(this.jobsDir, `${id}.json`), "utf8");
      const parsed = JSON.parse(raw) as AnalysisJobSnapshot;
      const normalized = this.normalizeSnapshot(parsed);
      this.jobs.set(id, normalized);
      this.emitters.set(id, this.emitters.get(id) ?? new EventEmitter());
      return normalized;
    } catch {
      return undefined;
    }
  }

  list(limit = 20): AnalysisJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(0, limit));
  }

  rerunFrom(sourceId: string, overrides: Partial<Pick<AnalysisJobSnapshot, "locale">> = {}): AnalysisJobSnapshot {
    const source = this.jobs.get(sourceId);
    if (!source) {
      throw new Error(`Unknown job: ${sourceId}`);
    }
    return this.create(source.repoPath, overrides.locale ?? source.locale, {
      sourceJobId: source.id,
      revision: (source.revision ?? 1) + 1
    });
  }

  onUpdate(id: string, listener: (snapshot: AnalysisJobSnapshot) => void): () => void {
    const emitter = this.emitters.get(id);
    if (!emitter) {
      throw new Error(`Unknown job: ${id}`);
    }
    const handler = (snapshot: AnalysisJobSnapshot) => listener(snapshot);
    emitter.on("update", handler);
    return () => emitter.off("update", handler);
  }

  async archiveResult(snapshot: AnalysisJobSnapshot): Promise<void> {
    await this.persistRecordArtifacts(snapshot);
  }

  async delete(id: string): Promise<AnalysisJobSnapshot> {
    const current = this.jobs.get(id);
    if (!current) {
      throw new Error(`Unknown job: ${id}`);
    }
    if (current.status === "queued" || current.status === "running") {
      throw new Error(`Job ${id} is still active and cannot be deleted`);
    }

    const jobFile = path.join(this.jobsDir, `${id}.json`);
    const recordDir = path.join(this.recordsDir, id);
    await Promise.all([
      rm(jobFile, { force: true }),
      rm(recordDir, { recursive: true, force: true })
    ]);

    this.jobs.delete(id);
    const emitter = this.emitters.get(id);
    if (emitter) {
      emitter.removeAllListeners();
    }
    this.emitters.delete(id);
    return current;
  }
}
