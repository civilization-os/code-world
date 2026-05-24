import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

import type {
  AnalysisMode,
  AnalysisJobSnapshot,
  BusinessEntity,
  EvidenceItem,
  FileInsight,
  FlowStep,
  ReportSection,
  RepoScanResult,
  RepoSignal,
  RepoTypePrediction,
  RepositoryAnalysis,
  EvidenceReviewItem,
  RuleItem,
  StructuredAnalysis,
  StructuredClaim
} from "../domain.js";
import type { LocaleCode } from "../i18n.js";
import { analysisText } from "../i18n.js";
import { AnalysisCache } from "../cache.js";
import { JobStore } from "../jobStore.js";
import { ProviderConfigStore, providerConfigSignature } from "../providerConfig.js";
import {
  buildFileInsight,
  buildModuleMap,
  identifyDeepDiveTargets,
  inferRepositoryModel,
  type RepositoryModel
} from "./heuristics.js";
import { buildReportBundle } from "./report.js";
import { callStructuredAnalysisModel, callQualityJudge, callReportGeneration } from "./modelClient.js";
import {
  buildEvidencePack,
  buildAutoFilterResult,
  buildStructuredFallbackAnalysis,
  normalizeStructuredAnalysis,
  structuredAnalysisSchema,
  type StructuredAnalysisContext,
  type StructuredEvidencePack
} from "./structured.js";
import { scanRepository } from "./scanner.js";
import { buildWorldModel } from "./worldModel.js";

const ANALYSIS_VERSION = 6;
const MAX_REWRITE_ATTEMPTS = 2;

interface AnalysisState {
  locale: LocaleCode;
  jobId: string;
  repoPath: string;
  repoName: string;
  fingerprint: string;
  analysisProfileKey: string;
  scan: RepoScanResult | null;
  fileInsights: FileInsight[];
  signals: RepoSignal[];
  repoType: RepoTypePrediction | null;
  domain: RepoTypePrediction | null;
  model: RepositoryModel | null;
  evidencePack: StructuredEvidencePack | null;
  filteredEvidencePack: StructuredEvidencePack | null;
  structuredAnalysis: StructuredAnalysis | null;
  structuredRaw: unknown;
  analysisMode: AnalysisMode;
  modelRequestId: string | undefined;
  forceFresh: boolean;
  entities: BusinessEntity[];
  flows: FlowStep[];
  rules: RuleItem[];
  evidence: EvidenceItem[];
  unknowns: string[];
  modules: Array<{ module: string; role: string; evidence: string[] }>;
  outline: string[];
  sections: ReportSection[];
  technicalMarkdown: string;
  businessMarkdown: string;
  reportMarkdown: string;
  cacheHit: boolean;
  fileCacheHits: number;
  fileCacheMisses: number;
  noiseSignals: string[];
  rejectedEvidence: EvidenceReviewItem[];
  filterNotes: string[];
  qaIssues: string[];
  qaPasses: number;
  rewriteAttempts: number;
  needsRewrite: boolean;
  deepDiveTargetFiles: string[];
  generatedAt: string;
  analysis: RepositoryAnalysis | null;
}

const State = Annotation.Root({
  locale: Annotation<LocaleCode>(),
  jobId: Annotation<string>(),
  repoPath: Annotation<string>(),
  repoName: Annotation<string>(),
  fingerprint: Annotation<string>(),
  scan: Annotation<RepoScanResult | null>(),
  fileInsights: Annotation<FileInsight[]>(),
  signals: Annotation<RepoSignal[]>(),
  repoType: Annotation<RepoTypePrediction | null>(),
  domain: Annotation<RepoTypePrediction | null>(),
  model: Annotation<RepositoryModel | null>(),
  evidencePack: Annotation<StructuredEvidencePack | null>(),
  filteredEvidencePack: Annotation<StructuredEvidencePack | null>(),
  structuredAnalysis: Annotation<StructuredAnalysis | null>(),
  structuredRaw: Annotation<unknown>(),
  analysisMode: Annotation<AnalysisMode>(),
  modelRequestId: Annotation<string | undefined>(),
  forceFresh: Annotation<boolean>(),
  entities: Annotation<BusinessEntity[]>(),
  flows: Annotation<FlowStep[]>(),
  rules: Annotation<RuleItem[]>(),
  evidence: Annotation<EvidenceItem[]>(),
  unknowns: Annotation<string[]>(),
  modules: Annotation<Array<{ module: string; role: string; evidence: string[] }>>(),
  outline: Annotation<string[]>(),
  sections: Annotation<ReportSection[]>(),
  technicalMarkdown: Annotation<string>(),
  businessMarkdown: Annotation<string>(),
  reportMarkdown: Annotation<string>(),
  cacheHit: Annotation<boolean>(),
  analysisProfileKey: Annotation<string>(),
  fileCacheHits: Annotation<number>(),
  fileCacheMisses: Annotation<number>(),
  noiseSignals: Annotation<string[]>(),
  rejectedEvidence: Annotation<EvidenceReviewItem[]>(),
  filterNotes: Annotation<string[]>(),
  qaIssues: Annotation<string[]>(),
  qaPasses: Annotation<number>(),
  rewriteAttempts: Annotation<number>(),
  needsRewrite: Annotation<boolean>(),
  deepDiveTargetFiles: Annotation<string[]>(),
  generatedAt: Annotation<string>(),
  analysis: Annotation<RepositoryAnalysis | null>()
});

function toFileKey(file: { hash: string | null; relativePath: string; size: number; mtimeMs: number }): string {
  return file.hash ?? `${file.relativePath}:${file.size}:${file.mtimeMs}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isCurrentAnalysis(candidate: unknown): candidate is RepositoryAnalysis {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const analysis = candidate as Partial<RepositoryAnalysis>;
  return analysis.analysisVersion === ANALYSIS_VERSION
    && typeof analysis.analysisProfileKey === "string"
    && typeof analysis.reportMarkdown === "string"
    && typeof analysis.technicalMarkdown === "string"
    && typeof analysis.businessMarkdown === "string"
    && Boolean(analysis.structuredAnalysis)
    && Boolean(analysis.worldModel);
}

function mapClaimToEntity(claim: StructuredClaim): BusinessEntity {
  return {
    name: claim.title,
    kind: claim.status,
    description: claim.description,
    evidence: claim.evidenceFiles,
    confidence: claim.confidence
  };
}

function mapClaimToFlow(claim: StructuredClaim, order: number): FlowStep {
  return {
    id: `flow-${order + 1}`,
    title: claim.title,
    description: claim.description,
    evidence: claim.evidenceFiles,
    confidence: claim.confidence,
    order: order + 1
  };
}

function mapClaimToRule(claim: StructuredClaim): RuleItem {
  return {
    rule: claim.title,
    rationale: claim.rationale,
    evidence: claim.evidenceFiles,
    confidence: claim.confidence
  };
}

function mapClaimToModule(claim: StructuredClaim): { module: string; role: string; evidence: string[] } {
  return {
    module: claim.title,
    role: claim.description,
    evidence: claim.evidenceFiles
  };
}

function buildAllowedEvidenceSet(scan: RepoScanResult, fileInsights: FileInsight[]): Set<string> {
  return new Set([
    ...scan.files.map((file) => file.relativePath),
    ...scan.manifests,
    ...scan.configs,
    ...scan.tests,
    ...scan.entrypoints,
    ...scan.docs,
    ...fileInsights.flatMap((item) => [item.path, ...item.evidence])
  ]);
}

function buildStructuredContext(
  locale: LocaleCode,
  scan: RepoScanResult,
  fileInsights: FileInsight[],
  repoType: RepoTypePrediction,
  domain: RepoTypePrediction,
  model: RepositoryModel,
  signals: RepoSignal[],
  deepDiveTargets: string[]
): StructuredAnalysisContext {
  const modules = buildModuleMap(scan, fileInsights);
  const outline = model.outline.length > 0 ? model.outline : [];
  return {
    locale,
    scan,
    fileInsights,
    repoType,
    domain,
    signals,
    model,
    modules,
    outline,
    deepDiveTargets
  };
}

function buildQualityIssues(state: AnalysisState): string[] {
  const issues: string[] = [];
  const structured = state.structuredAnalysis;
  const t = analysisText(state.locale);

  if (!structured) {
    issues.push(state.locale === "zh-CN" ? "未生成结构化分析结果。" : "No structured analysis was produced.");
    return issues;
  }

  if (!structured.repoType.evidenceFiles.length) {
    issues.push(state.locale === "zh-CN" ? "仓库类型结论没有证据支撑。" : "The repository type conclusion has no evidence.");
  }
  if (!structured.domain.evidenceFiles.length) {
    issues.push(state.locale === "zh-CN" ? "业务领域结论没有证据支撑。" : "The domain conclusion has no evidence.");
  }
  if (!structured.technicalSummary.evidenceFiles.length) {
    issues.push(state.locale === "zh-CN" ? "技术结论没有证据支撑。" : "The technical summary has no evidence.");
  }
  if (!structured.businessSummary.evidenceFiles.length) {
    issues.push(state.locale === "zh-CN" ? "业务摘要没有证据支撑。" : "The business summary has no evidence.");
  }

  const confirmedEntities = structured.entities.filter((item) => item.status !== "unconfirmed");
  const confirmedFlows = structured.flows.filter((item) => item.status !== "unconfirmed");
  const confirmedRules = structured.rules.filter((item) => item.status !== "unconfirmed");

  if (confirmedEntities.length === 0) {
    issues.push(state.locale === "zh-CN" ? "没有找到可确认的业务对象。" : "No confirmable business entities were found.");
  }
  if (confirmedFlows.length === 0) {
    issues.push(state.locale === "zh-CN" ? "没有找到可确认的主流程。" : "No confirmable main flows were found.");
  }
  if (confirmedRules.length === 0) {
    issues.push(state.locale === "zh-CN" ? "没有找到可确认的规则。" : "No confirmable rules were found.");
  }
  if (structured.reportOutline.length < 6) {
    issues.push(state.locale === "zh-CN" ? "报告大纲过短。" : "The report outline is too short.");
  }
  if (structured.qaNotes.some((note) => note.toLowerCase().includes("no evidence") || note.toLowerCase().includes("unconfirmed"))) {
    issues.push(state.locale === "zh-CN" ? "模型报告了未确认或低证据质量说明。" : "The model reported unconfirmed or low-evidence quality notes.");
  }
  if (state.analysisMode === "fallback" && state.rewriteAttempts === 0) {
    issues.push(state.locale === "zh-CN" ? "当前结果来自保守兜底，还需要更深入的验证。" : "The current result came from a conservative fallback and needs deeper verification.");
  }

  if (state.repoType && state.repoType.confidence < 0.45) {
    issues.push(state.locale === "zh-CN" ? "仓库类型置信度较低。" : "Repository type confidence is low.");
  }
  if (state.domain && state.domain.confidence < 0.45) {
    issues.push(state.locale === "zh-CN" ? "业务领域置信度较低。" : "Business domain confidence is low.");
  }

  return unique(issues);
}

function buildFinalAnalysis(state: AnalysisState): RepositoryAnalysis {
  const scan = state.scan;
  if (!scan) {
    throw new Error("Analysis state is missing a repository scan");
  }

  const repoType = state.repoType ?? {
    label: "application",
    confidence: 0.25,
    reasons: [state.locale === "zh-CN" ? "没有可用的仓库类型推断。" : "No repository type inference was available."]
  };
  const domain = state.domain ?? {
    label: "generic product",
    confidence: 0.25,
    reasons: [state.locale === "zh-CN" ? "没有可用的业务领域推断。" : "No domain inference was available."]
  };
  const model = state.model ?? inferRepositoryModel(scan, state.fileInsights);
  const generatedAt = state.generatedAt || new Date().toISOString();
  const deepDiveTargets = identifyDeepDiveTargets(state.fileInsights);
  const context = buildStructuredContext(
    state.locale,
    scan,
    state.fileInsights,
    repoType,
    domain,
    model,
    state.signals,
    deepDiveTargets
  );
  const structuredAnalysis = state.structuredAnalysis ?? buildStructuredFallbackAnalysis(context);
  const bundle = state.sections.length > 0 && state.technicalMarkdown.length > 0 && state.businessMarkdown.length > 0
    ? {
        sections: state.sections,
        technicalMarkdown: state.technicalMarkdown,
        businessMarkdown: state.businessMarkdown,
        reportMarkdown: state.reportMarkdown || `${state.technicalMarkdown}

---

${state.businessMarkdown}`
      }
    : buildReportBundle({
        locale: state.locale,
        repoName: state.repoName,
        repoPath: state.repoPath,
        fingerprint: state.fingerprint,
        fileCount: scan.files.length,
        directoryCount: scan.directories.length,
        scan,
        repoType,
        domain,
        structuredAnalysis,
        analysisMode: state.analysisMode || "fallback",
        cacheHit: state.cacheHit,
        fileCacheHits: state.fileCacheHits,
        fileCacheMisses: state.fileCacheMisses,
        qaIssues: state.qaIssues,
        qaPasses: state.qaPasses,
        generatedAt,
        signals: state.signals,
        modules: state.modules.length > 0 ? state.modules : structuredAnalysis.modules.map((item) => mapClaimToModule(item)),
        fileInsights: state.fileInsights
      });

  const entities = structuredAnalysis.entities.map(mapClaimToEntity);
  const flows = structuredAnalysis.flows.map((flow, index) => mapClaimToFlow(flow, index));
  const rules = structuredAnalysis.rules.map(mapClaimToRule);
  const evidence = structuredAnalysis.evidenceItems;
  const modules = structuredAnalysis.modules.map(mapClaimToModule);
  const qaIssues = unique([...state.qaIssues, ...buildQualityIssues(state)]);
  const worldModel = buildWorldModel({
    repoName: state.repoName || scan.rootName,
    repoPath: state.repoPath,
    scan,
    repoType,
    domain,
    structuredAnalysis,
    fileInsights: state.fileInsights,
    generatedAt
  });

  return {
    analysisVersion: ANALYSIS_VERSION,
    analysisMode: state.analysisMode || "fallback",
    analysisProfileKey: state.analysisProfileKey || `${ANALYSIS_VERSION}:unknown`,
    locale: state.locale,
    repoPath: state.repoPath,
    repoName: state.repoName || scan.rootName,
    fingerprint: state.fingerprint,
    fileCount: scan.files.length,
    directoryCount: scan.directories.length,
    scan,
    fileInsights: state.fileInsights,
    signals: state.signals,
    repoType,
    domain,
    structuredAnalysis,
    worldModel,
    technicalMarkdown: bundle.technicalMarkdown,
    businessMarkdown: bundle.businessMarkdown,
    entities,
    flows,
    rules,
    evidence,
    unknowns: unique([...structuredAnalysis.unknowns, ...qaIssues]),
    noiseSignals: state.noiseSignals,
    rejectedEvidence: state.rejectedEvidence,
    filterNotes: state.filterNotes,
    modules: modules.length > 0 ? modules : state.modules,
    outline: structuredAnalysis.reportOutline,
    sections: bundle.sections,
    reportMarkdown: bundle.reportMarkdown,
    cacheHit: state.cacheHit,
    fileCacheHits: state.fileCacheHits,
    fileCacheMisses: state.fileCacheMisses,
    qaIssues,
    qaPasses: state.qaPasses,
    generatedAt
  };
}

function buildBaselinePayload(state: AnalysisState, model: RepositoryModel) {
  return {
    repoType: model.repoType,
    domain: model.domain,
    signals: model.signals.slice(0, 10),
    noiseSignals: state.noiseSignals.slice(0, 12),
    filterNotes: state.filterNotes.slice(0, 12),
    rejectedEvidence: state.rejectedEvidence.slice(0, 12),
    entities: model.entities.slice(0, 6),
    flows: model.flows.slice(0, 6),
    rules: model.rules.slice(0, 6),
    evidence: model.evidence.slice(0, 8),
    unknowns: model.unknowns.slice(0, 6),
    outline: model.outline.slice(0, 12),
    modules: buildModuleMap(state.scan!, state.fileInsights).slice(0, 12)
  };
}

async function extractStructuredAnalysis(
  state: AnalysisState,
  providerConfigStore: ProviderConfigStore,
  model: RepositoryModel
): Promise<{
  structuredAnalysis: StructuredAnalysis;
  analysisMode: AnalysisMode;
  structuredRaw: unknown;
  modelRequestId?: string;
}> {
  const scan = state.scan;
  if (!scan) {
    throw new Error("Missing repository scan");
  }

  const allowedEvidenceFiles = buildAllowedEvidenceSet(scan, state.fileInsights);
  const context = buildStructuredContext(
    state.locale,
    scan,
    state.fileInsights,
    state.repoType ?? model.repoType,
    state.domain ?? model.domain,
    model,
    state.signals,
    identifyDeepDiveTargets(state.fileInsights)
  );
  const fallback = buildStructuredFallbackAnalysis(context);
  const providerConfig = await providerConfigStore.load();

  if (!providerConfig.apiKey.trim() || !providerConfig.model.trim()) {
    return {
      structuredAnalysis: fallback,
      analysisMode: "fallback",
      structuredRaw: null
    };
  }

  try {
    const result = await callStructuredAnalysisModel({
      provider: providerConfig.provider,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      locale: state.locale,
      evidencePack: state.filteredEvidencePack ?? buildEvidencePack(context),
      baseline: buildBaselinePayload(state, model)
    });

    const parsed = structuredAnalysisSchema.safeParse(result.parsed);
    if (!parsed.success) {
      return {
        structuredAnalysis: fallback,
        analysisMode: "fallback",
        structuredRaw: result.parsed,
        modelRequestId: result.requestId
      };
    }

    return {
      structuredAnalysis: normalizeStructuredAnalysis(parsed.data, fallback, allowedEvidenceFiles, state.locale),
      analysisMode: "model",
      structuredRaw: result.parsed,
      modelRequestId: result.requestId
    };
  } catch {
    return {
      structuredAnalysis: fallback,
      analysisMode: "fallback",
      structuredRaw: null
    };
  }
}

export function createAnalysisGraph(jobStore: JobStore, cache: AnalysisCache, providerConfigStore: ProviderConfigStore) {
  const builder = new StateGraph(State)
    .addNode("scanRepo", async (state) => {
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "scanRepo", t.scanRepo.start);
      const scan = await scanRepository(state.repoPath);
      const providerConfig = await providerConfigStore.load();
      const analysisProfileKey = `${ANALYSIS_VERSION}:${providerConfigSignature(providerConfig)}`;
      const cached = state.forceFresh ? undefined : await cache.getRepoResult(scan.fingerprint, state.locale, analysisProfileKey);
      if (cached && isCurrentAnalysis(cached)) {
        const cachedAnalysis: RepositoryAnalysis = {
          ...cached,
          cacheHit: true,
          analysisMode: "cached"
        };
        jobStore.finishStage(state.jobId, "scanRepo", t.scanRepo.finishCached);
        return {
          locale: state.locale,
          repoName: cachedAnalysis.repoName,
          fingerprint: cachedAnalysis.fingerprint,
          analysisProfileKey: cachedAnalysis.analysisProfileKey,
          scan,
          cacheHit: true,
          analysis: cachedAnalysis,
          repoType: cachedAnalysis.repoType,
          domain: cachedAnalysis.domain,
          structuredAnalysis: cachedAnalysis.structuredAnalysis,
          structuredRaw: cachedAnalysis.structuredAnalysis,
          analysisMode: cachedAnalysis.analysisMode,
          signals: cachedAnalysis.signals,
          fileInsights: cachedAnalysis.fileInsights,
          entities: cachedAnalysis.entities,
          flows: cachedAnalysis.flows,
          rules: cachedAnalysis.rules,
          evidence: cachedAnalysis.evidence,
          unknowns: cachedAnalysis.unknowns,
          modules: cachedAnalysis.modules,
          outline: cachedAnalysis.outline,
          sections: cachedAnalysis.sections,
          technicalMarkdown: cachedAnalysis.technicalMarkdown,
          businessMarkdown: cachedAnalysis.businessMarkdown,
          reportMarkdown: cachedAnalysis.reportMarkdown,
          fileCacheHits: cachedAnalysis.fileCacheHits,
          fileCacheMisses: cachedAnalysis.fileCacheMisses,
          noiseSignals: cachedAnalysis.noiseSignals ?? [],
          rejectedEvidence: cachedAnalysis.rejectedEvidence ?? [],
          filterNotes: cachedAnalysis.filterNotes ?? [],
          qaIssues: cachedAnalysis.qaIssues,
          qaPasses: cachedAnalysis.qaPasses,
          generatedAt: cachedAnalysis.generatedAt
        };
      }

      jobStore.finishStage(state.jobId, "scanRepo", t.scanRepo.finishScanned(scan.files.length));
      return {
        locale: state.locale,
        repoName: scan.rootName,
        fingerprint: scan.fingerprint,
        analysisProfileKey,
        scan,
        cacheHit: false,
        analysisMode: "fallback" as AnalysisMode,
        noiseSignals: [],
        rejectedEvidence: [],
        filterNotes: [],
        filteredEvidencePack: null
      };
    })
    .addNode("classifySignals", async (state) => {
      if (!state.scan) {
        throw new Error("Missing repository scan");
      }
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "classifySignals", t.classifySignals.start);
      const nextInsights: FileInsight[] = [];
      let hits = 0;
      let misses = 0;

      for (const file of state.scan.files) {
        const key = toFileKey(file);
        const cached = await cache.getFileInsight(key);
        if (cached) {
          nextInsights.push({ ...cached, reusedFromCache: true });
          hits += 1;
          continue;
        }

        const build = await buildFileInsight(file, state.repoPath, undefined, { deep: false });
        nextInsights.push(build.insight);
        misses += 1;
        await cache.saveFileInsight(key, build.insight);
      }

      jobStore.finishStage(state.jobId, "classifySignals", t.classifySignals.finish(nextInsights.length));
      return {
        fileInsights: nextInsights,
        fileCacheHits: hits,
        fileCacheMisses: misses
      };
    })
    .addNode("inferRepository", async (state) => {
      if (!state.scan) {
        throw new Error("Missing repository scan");
      }
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "inferRepository", t.inferRepository.start);
      const model = inferRepositoryModel(state.scan, state.fileInsights);
      jobStore.finishStage(state.jobId, "inferRepository", t.inferRepository.finish(model.repoType.label, model.domain.label));
      return {
        model,
        repoType: model.repoType,
        domain: model.domain,
        signals: model.signals
      };
    })
    .addNode("filterEvidence", async (state) => {
      if (!state.scan || !state.model || !state.repoType || !state.domain) {
        throw new Error("Missing repository context for evidence filtering");
      }
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "filterEvidence", t.filterEvidence.start);
      const filterResult = buildAutoFilterResult(
        buildStructuredContext(
          state.locale,
          state.scan,
          state.fileInsights,
          state.repoType,
          state.domain,
          state.model,
          state.signals,
          identifyDeepDiveTargets(state.fileInsights)
        )
      );
      const filteredModel = inferRepositoryModel(filterResult.scan, filterResult.fileInsights);
      const filteredEvidencePack = buildEvidencePack(
        buildStructuredContext(
          state.locale,
          filterResult.scan,
          filterResult.fileInsights,
          filteredModel.repoType,
          filteredModel.domain,
          filteredModel,
          filteredModel.signals,
          identifyDeepDiveTargets(filterResult.fileInsights)
        )
      );
      jobStore.finishStage(
        state.jobId,
        "filterEvidence",
        t.filterEvidence.finish(filterResult.fileInsights.length, filterResult.rejectedEvidence.length)
      );
      return {
        scan: filterResult.scan,
        fileInsights: filterResult.fileInsights,
        signals: filteredModel.signals,
        model: filteredModel,
        repoType: filteredModel.repoType,
        domain: filteredModel.domain,
        filteredEvidencePack,
        noiseSignals: filterResult.noiseSignals,
        rejectedEvidence: filterResult.rejectedEvidence,
        filterNotes: filterResult.filterNotes
      };
    })
    .addNode("reconstructBusiness", async (state) => {
      if (!state.scan) {
        throw new Error("Missing repository scan");
      }
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "reconstructBusiness", t.reconstructBusiness.start);
      const model = state.model ?? inferRepositoryModel(state.scan, state.fileInsights);
      const extracted = await extractStructuredAnalysis(state, providerConfigStore, model);
      const modules = buildModuleMap(state.scan, state.fileInsights);
      jobStore.finishStage(state.jobId, "reconstructBusiness", t.reconstructBusiness.finish);
      return {
        evidencePack: state.filteredEvidencePack ?? buildEvidencePack(
          buildStructuredContext(
            state.locale,
            state.scan,
            state.fileInsights,
            state.repoType ?? model.repoType,
            state.domain ?? model.domain,
            model,
            state.signals,
            identifyDeepDiveTargets(state.fileInsights)
          )
        ),
        structuredAnalysis: extracted.structuredAnalysis,
        structuredRaw: extracted.structuredRaw,
        analysisMode: extracted.analysisMode,
        modelRequestId: extracted.modelRequestId,
        entities: extracted.structuredAnalysis.entities.map(mapClaimToEntity),
        flows: extracted.structuredAnalysis.flows.map((flow, index) => mapClaimToFlow(flow, index)),
        rules: extracted.structuredAnalysis.rules.map(mapClaimToRule),
        evidence: extracted.structuredAnalysis.evidenceItems,
        unknowns: extracted.structuredAnalysis.unknowns,
        modules: extracted.structuredAnalysis.modules.length > 0 ? extracted.structuredAnalysis.modules.map(mapClaimToModule) : modules,
        outline: extracted.structuredAnalysis.reportOutline
      };
    })
    .addNode("qualityCheck", async (state) => {
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "qualityCheck", t.qualityCheck.start);

      // Try AI-powered quality judge first
      let issues: string[] = [];
      let needsRewrite = false;
      let deepDiveTargetFiles: string[] = [];
      let usedAiJudge = false;

      if (state.analysisMode === "model" && state.evidencePack && state.structuredAnalysis) {
        try {
          const providerConfig = await providerConfigStore.load();
          if (providerConfig.apiKey.trim() && providerConfig.model.trim()) {
            const judgeResult = await callQualityJudge(
              {
                provider: providerConfig.provider,
                apiKey: providerConfig.apiKey,
                baseUrl: providerConfig.baseUrl,
                model: providerConfig.model
              },
              {
                locale: state.locale,
                evidencePack: state.evidencePack,
                structuredAnalysis: state.structuredAnalysis,
                rewriteAttempts: state.rewriteAttempts,
                maxRewriteAttempts: MAX_REWRITE_ATTEMPTS
              }
            );

            if (judgeResult) {
              issues = judgeResult.issues;
              needsRewrite = judgeResult.needsRewrite && state.rewriteAttempts < MAX_REWRITE_ATTEMPTS;
              deepDiveTargetFiles = judgeResult.deepDiveTargetFiles;
              usedAiJudge = true;
            }
          }
        } catch {
          // Fall through to rule-based check
        }
      }

      if (!usedAiJudge) {
        issues = buildQualityIssues(state);
        needsRewrite = issues.length > 0 && state.analysisMode === "model" && state.rewriteAttempts < MAX_REWRITE_ATTEMPTS;
      }

      const nextPasses = state.qaPasses + 1;
      jobStore.finishStage(
        state.jobId,
        "qualityCheck",
        usedAiJudge
          ? (needsRewrite ? t.qualityCheck.rewrite : t.qualityCheck.accepted)
          : (needsRewrite ? t.qualityCheck.rewrite : t.qualityCheck.accepted)
      );
      return {
        qaIssues: issues,
        qaPasses: nextPasses,
        needsRewrite,
        deepDiveTargetFiles
      };
    })
    .addNode("deepDive", async (state) => {
      if (!state.scan) {
        throw new Error("Missing repository scan");
      }
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "deepDive", t.deepDive.start);

      // Use AI-suggested targets if available, else fall back to heuristic
      const targets = state.deepDiveTargetFiles.length > 0
        ? state.deepDiveTargetFiles
        : identifyDeepDiveTargets(state.fileInsights);
      const targetSet = new Set(targets);
      const updatedInsights = [...state.fileInsights];

      const selectedFiles = state.scan.files.filter((file) => targetSet.has(file.relativePath));
      const fallbackFiles = selectedFiles.length > 0 ? selectedFiles : state.scan.files.slice(0, 6);

      for (const file of fallbackFiles) {
        const build = await buildFileInsight(file, state.repoPath, undefined, { deep: true });
        const key = toFileKey(file);
        const index = updatedInsights.findIndex((item) => item.path === file.relativePath);
        if (index >= 0) {
          updatedInsights[index] = build.insight;
        } else {
          updatedInsights.push(build.insight);
        }
        await cache.saveFileInsight(key, build.insight);
      }

      jobStore.finishStage(state.jobId, "deepDive", t.deepDive.finish(fallbackFiles.length));
      return {
        fileInsights: updatedInsights,
        fileCacheMisses: state.fileCacheMisses + fallbackFiles.length,
        rewriteAttempts: state.rewriteAttempts + 1,
        qaIssues: [],
        needsRewrite: false,
        deepDiveTargetFiles: []
      };
    })
    .addNode("draftReport", async (state) => {
      if (!state.scan || !state.repoType || !state.domain || !state.structuredAnalysis) {
        throw new Error("Missing repository model");
      }
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "draftReport", t.draftReport.start);
      const generatedAt = new Date().toISOString();

      // Try AI-powered report generation first
      let usedAiReport = false;
      let technicalMarkdown = "";
      let businessMarkdown = "";

      if (state.analysisMode === "model" && state.evidencePack) {
        try {
          const providerConfig = await providerConfigStore.load();
          if (providerConfig.apiKey.trim() && providerConfig.model.trim()) {
            const reportResult = await callReportGeneration(
              {
                provider: providerConfig.provider,
                apiKey: providerConfig.apiKey,
                baseUrl: providerConfig.baseUrl,
                model: providerConfig.model
              },
              {
                locale: state.locale,
                repoName: state.repoName || state.scan.rootName,
                repoPath: state.repoPath,
                fileCount: state.scan.files.length,
                directoryCount: state.scan.directories.length,
                structuredAnalysis: state.structuredAnalysis,
                evidencePack: state.evidencePack,
                fileInsights: state.fileInsights,
                qaIssues: state.qaIssues,
                generatedAt
              }
            );

            if (reportResult && reportResult.technicalMarkdown.length > 0) {
              technicalMarkdown = reportResult.technicalMarkdown;
              businessMarkdown = reportResult.businessMarkdown;
              usedAiReport = true;
            }
          }
        } catch {
          // Fall through to template-based report
        }
      }

      if (!usedAiReport) {
        const bundle = buildReportBundle({
          locale: state.locale,
          repoName: state.repoName || state.scan.rootName,
          repoPath: state.repoPath,
          fingerprint: state.fingerprint,
          fileCount: state.scan.files.length,
          directoryCount: state.scan.directories.length,
          scan: state.scan,
          repoType: state.repoType,
          domain: state.domain,
          structuredAnalysis: state.structuredAnalysis,
          analysisMode: state.analysisMode,
          cacheHit: state.cacheHit,
          fileCacheHits: state.fileCacheHits,
          fileCacheMisses: state.fileCacheMisses,
          qaIssues: state.qaIssues,
          qaPasses: state.qaPasses,
          generatedAt,
          signals: state.signals,
          modules: state.modules,
          fileInsights: state.fileInsights
        });
        technicalMarkdown = bundle.technicalMarkdown;
        businessMarkdown = bundle.businessMarkdown;
      }

      const zh = state.locale === "zh-CN";
      const sections: ReportSection[] = [
        { id: "technical-conclusion", title: zh ? "技术报告" : "Technical Report", markdown: technicalMarkdown },
        { id: "business-summary", title: zh ? "业务摘要" : "Business Summary", markdown: businessMarkdown }
      ];
      const reportMarkdown = `${technicalMarkdown}\n\n---\n\n${businessMarkdown}`;

      jobStore.finishStage(state.jobId, "draftReport", t.draftReport.finish);
      return {
        sections,
        technicalMarkdown,
        businessMarkdown,
        reportMarkdown,
        generatedAt
      };
    })
    .addNode("finalizeReport", async (state) => {
      const t = analysisText(state.locale);
      jobStore.startStage(state.jobId, "finalizeReport", t.finalizeReport.start);
      const analysis = state.analysis ?? buildFinalAnalysis(state);
      const profileKey = state.analysisProfileKey || analysis.analysisProfileKey;
      await cache.saveRepoResult(state.fingerprint || analysis.fingerprint, state.locale, profileKey, analysis);
      const completed = jobStore.complete(state.jobId, analysis);
      await jobStore.archiveResult(completed);
      return {
        analysis,
        reportMarkdown: analysis.reportMarkdown,
        technicalMarkdown: analysis.technicalMarkdown,
        businessMarkdown: analysis.businessMarkdown,
        repoName: analysis.repoName,
        fingerprint: analysis.fingerprint,
        cacheHit: analysis.cacheHit || state.cacheHit
      };
    })
    .addEdge(START, "scanRepo")
    .addConditionalEdges(
      "scanRepo",
      (state) => (state.cacheHit && state.analysis ? "finalizeReport" : "classifySignals"),
      {
        finalizeReport: "finalizeReport",
        classifySignals: "classifySignals"
      }
    )
    .addEdge("classifySignals", "inferRepository")
    .addEdge("inferRepository", "filterEvidence")
    .addEdge("filterEvidence", "reconstructBusiness")
    .addEdge("reconstructBusiness", "qualityCheck")
    .addConditionalEdges(
      "qualityCheck",
      (state) => (state.needsRewrite ? "deepDive" : "draftReport"),
      {
        deepDive: "deepDive",
        draftReport: "draftReport"
      }
    )
    .addEdge("deepDive", "inferRepository")
    .addEdge("draftReport", "finalizeReport")
    .addEdge("finalizeReport", END);

  return builder.compile({ checkpointer: new MemorySaver() });
}

export async function runAnalysisJob(
  graph: ReturnType<typeof createAnalysisGraph>,
  jobStore: JobStore,
  jobId: string,
  repoPath: string,
  options: { forceFresh?: boolean } = {}
): Promise<AnalysisJobSnapshot> {
  jobStore.update(jobId, {
    status: "running",
    error: null
  });
  const initialState = {
    locale: jobStore.snapshot(jobId)?.locale ?? "en",
    jobId,
    repoPath,
    repoName: "",
    fingerprint: "",
    analysisProfileKey: "",
    scan: null,
    fileInsights: [],
    signals: [],
    repoType: null,
    domain: null,
    model: null,
    evidencePack: null,
    filteredEvidencePack: null,
    structuredAnalysis: null,
    structuredRaw: null,
    analysisMode: "fallback" as AnalysisMode,
    modelRequestId: undefined,
    entities: [],
    flows: [],
    rules: [],
    evidence: [],
    unknowns: [],
    modules: [],
    outline: [],
    sections: [],
    technicalMarkdown: "",
    businessMarkdown: "",
    reportMarkdown: "",
    cacheHit: false,
    forceFresh: options.forceFresh ?? false,
    fileCacheHits: 0,
    fileCacheMisses: 0,
    noiseSignals: [],
    rejectedEvidence: [],
    filterNotes: [],
    qaIssues: [],
    qaPasses: 0,
    rewriteAttempts: 0,
    needsRewrite: false,
    deepDiveTargetFiles: [],
    generatedAt: "",
    analysis: null
  };

  const result = (await graph.invoke(initialState, {
    configurable: { thread_id: jobId }
  })) as AnalysisState;
  const current = jobStore.snapshot(jobId);
  if (!current) {
    throw new Error(`Job ${jobId} disappeared during analysis`);
  }
  if (result.analysis) {
    return current;
  }
  return current;
}
