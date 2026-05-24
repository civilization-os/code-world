import { z } from "zod";

import type {
  EvidenceItem,
  FileInsight,
  RepoScanResult,
  RepoSignal,
  RepoTypePrediction,
  StructuredAnalysis,
  StructuredClaim,
  StructuredStatus,
  StructuredSummary
} from "../domain.js";
import type { LocaleCode } from "../i18n.js";
import { buildModuleMap, type RepositoryModel } from "./heuristics.js";

const structuredStatusSchema = z.enum(["confirmed", "provisional", "unconfirmed"]);

const structuredClaimSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  status: structuredStatusSchema,
  confidence: z.number().min(0).max(1),
  evidenceFiles: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1)
});

const structuredSummarySchema = z.object({
  headline: z.string().min(1),
  overview: z.string().min(1),
  status: structuredStatusSchema,
  confidence: z.number().min(0).max(1),
  evidenceFiles: z.array(z.string().min(1)).default([]),
  bullets: z.array(z.string()).default([])
});

export const structuredAnalysisSchema = z.object({
  repoType: structuredSummarySchema,
  domain: structuredSummarySchema,
  technicalSummary: structuredSummarySchema,
  businessSummary: structuredSummarySchema,
  entities: z.array(structuredClaimSchema).default([]),
  flows: z.array(structuredClaimSchema).default([]),
  rules: z.array(structuredClaimSchema).default([]),
  modules: z.array(structuredClaimSchema).default([]),
  risks: z.array(structuredClaimSchema).default([]),
  evidenceItems: z.array(
    z.object({
      claim: z.string().min(1),
      files: z.array(z.string().min(1)).default([]),
      confidence: z.number().min(0).max(1),
      notes: z.string().min(1)
    })
  ).default([]),
  unknowns: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
  reportOutline: z.array(z.string()).default([]),
  qaNotes: z.array(z.string()).default([])
}).passthrough();

export interface StructuredEvidencePack {
  repoName: string;
  repoPath: string;
  fingerprint: string;
  fileCount: number;
  directoryCount: number;
  repoType: RepoTypePrediction;
  domain: RepoTypePrediction;
  signals: RepoSignal[];
  fileInsights: Array<{
    path: string;
    category: string;
    summary: string;
    signals: string[];
    evidence: string[];
    confidence: number;
  }>;
  files: Array<{
    path: string;
    relativePath: string;
    category: string;
    sample: string;
    hash: string | null;
    size: number;
  }>;
  manifests: string[];
  configs: string[];
  tests: string[];
  entrypoints: string[];
  docs: string[];
  modules: Array<{ module: string; role: string; evidence: string[] }>;
  outline: string[];
  deepDiveTargets: string[];
}

export interface StructuredAnalysisContext {
  locale: LocaleCode;
  scan: RepoScanResult;
  fileInsights: FileInsight[];
  repoType: RepoTypePrediction;
  domain: RepoTypePrediction;
  signals: RepoSignal[];
  model: RepositoryModel;
  modules: Array<{ module: string; role: string; evidence: string[] }>;
  outline: string[];
  deepDiveTargets: string[];
}

export type AutoFilterAction = "keep" | "downrank" | "reject";

export interface AutoFilterDecision {
  kind: "file" | "signal" | "claim";
  action: AutoFilterAction;
  label: string;
  reason: string;
  files: string[];
}

export interface AutoFilterResult {
  scan: RepoScanResult;
  fileInsights: FileInsight[];
  signals: RepoSignal[];
  evidencePack: StructuredEvidencePack;
  noiseSignals: string[];
  rejectedEvidence: AutoFilterDecision[];
  filterNotes: string[];
  deepDiveTargets: string[];
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncate(value: string, maxLength = 240): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
}

function evidenceFilesFor(prefix: string, files: string[]): string[] {
  return unique(files.filter((file) => file.startsWith(prefix)));
}

function collectEvidenceFiles(items: Array<{ files?: string[]; evidence?: string[] }>): string[] {
  return unique(
    items.flatMap((item) => [...(item.files ?? []), ...(item.evidence ?? [])])
  );
}

function statusForConfidence(confidence: number, hardThreshold = 0.7): StructuredStatus {
  if (confidence >= hardThreshold) {
    return "confirmed";
  }
  if (confidence >= 0.45) {
    return "provisional";
  }
  return "unconfirmed";
}

function fallbackSummary(
  locale: LocaleCode,
  role: "repoType" | "domain" | "technicalSummary" | "businessSummary",
  overview: string,
  confidence: number,
  evidenceFiles: string[],
  bullets: string[] = []
): StructuredSummary {
  return {
    headline: headlineFor(locale, role),
    overview: truncate(overview, 220),
    status: statusForConfidence(confidence),
    confidence: clampConfidence(confidence),
    evidenceFiles: unique(evidenceFiles),
    bullets: unique(bullets).map((item) => truncate(item, 220))
  };
}

function fallbackClaim(
  title: string,
  description: string,
  confidence: number,
  evidenceFiles: string[],
  rationale: string
): StructuredClaim {
  return {
    title: truncate(title, 120),
    description: truncate(description, 260),
    status: statusForConfidence(confidence),
    confidence: clampConfidence(confidence),
    evidenceFiles: unique(evidenceFiles),
    rationale: truncate(rationale, 260)
  };
}

function evidenceFromModel(model: RepositoryModel): string[] {
  return unique(model.evidence.flatMap((item) => item.files));
}

const NOISE_PATH_PATTERNS = [
  /(^|\/)\.playwright-cli(\/|$)/,
  /(^|\/)playwright-report(\/|$)/,
  /(^|\/)test-results(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)\.mypy_cache(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)out(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)logs?(\/|$)/,
  /(^|\/)tmp(\/|$)/,
  /(^|\/)temp(\/|$)/,
  /(^|\/)generated(\/|$)/,
  /(^|\/)artifacts?(\/|$)/,
  /(^|\/)screenshots?(\/|$)/,
  /(^|\/)chroma_db(\/|$)/
];

const LOW_VALUE_EVIDENCE_PATTERNS = [
  /(^|\/)\.gitignore$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.editorconfig$/,
  /(^|\/)\.dockerignore$/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)chroma_db(\/|$)/,
  /(^|\/).*\.(sqlite|sqlite3|db|db-wal|db-shm)$/
];

const GENERIC_LABELS = new Set([
  "ref",
  "generic",
  "div",
  "const",
  "set",
  "name",
  "item",
  "data",
  "object",
  "utils",
  "helper",
  "node",
  "element",
  "component",
  "common",
  "shared",
  "base",
  "default",
  "index",
  "entry",
  "processing",
  "completion",
  "request",
  "validation",
  "submission",
  "decision",
  "result"
]);

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/").trim().toLowerCase();
}

function isNoisePath(value: string): boolean {
  const normalized = normalizePathLike(value);
  if (!normalized) {
    return true;
  }
  if (normalized.endsWith(".log") || normalized.endsWith(".pyc") || normalized.endsWith(".pyo") || normalized.endsWith(".tmp") || normalized.endsWith(".temp") || normalized.endsWith(".bak") || normalized.endsWith(".swp")) {
    return true;
  }
  return NOISE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLowValueEvidencePath(value: string): boolean {
  const normalized = normalizePathLike(value);
  if (!normalized) {
    return true;
  }
  return LOW_VALUE_EVIDENCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isPrimaryEvidencePath(value: string): boolean {
  return !isNoisePath(value) && !isLowValueEvidencePath(value);
}

function isLikelyNoise(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const tokens = normalized
    .split(/[\s._/-]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }
  if (tokens.every((token) => GENERIC_LABELS.has(token))) {
    return true;
  }
  if (tokens.length <= 2 && tokens.some((token) => GENERIC_LABELS.has(token))) {
    return true;
  }
  return GENERIC_LABELS.has(normalized);
}

function headlineFor(locale: LocaleCode, role: "repoType" | "domain" | "technicalSummary" | "businessSummary"): string {
  const zh = locale === "zh-CN";
  if (role === "repoType") {
    return zh ? "仓库类型判断" : "Repository type assessment";
  }
  if (role === "domain") {
    return zh ? "业务领域判断" : "Business domain assessment";
  }
  if (role === "technicalSummary") {
    return zh ? "技术结论摘要" : "Technical summary";
  }
  return zh ? "业务摘要概览" : "Business summary overview";
}

function headlineLooksGeneric(locale: LocaleCode, role: "repoType" | "domain" | "technicalSummary" | "businessSummary", headline: string): boolean {
  const normalized = headline.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const zh = locale === "zh-CN";
  const variants = zh
    ? {
        repoType: ["仓库类型", "仓库类型判断"],
        domain: ["业务领域", "业务领域判断"],
        technicalSummary: ["技术结论", "技术结论摘要"],
        businessSummary: ["业务摘要", "业务摘要概览"]
      }
    : {
        repoType: ["repository type", "repository type assessment"],
        domain: ["business domain", "business domain assessment"],
        technicalSummary: ["technical summary"],
        businessSummary: ["business summary", "business summary overview"]
      };
  return variants[role].some((variant) => variant === normalized) || (zh && headline.length <= 4);
}

function normalizeSummary(
  summary: StructuredSummary,
  allowedFiles: Set<string>,
  locale: LocaleCode,
  role: "repoType" | "domain" | "technicalSummary" | "businessSummary"
): StructuredSummary {
  const evidenceFiles = summary.evidenceFiles.filter(
    (file) => (allowedFiles.size === 0 || allowedFiles.has(file)) && isPrimaryEvidencePath(file)
  );
  const hasEvidence = evidenceFiles.length > 0;
  return {
    ...summary,
    headline: headlineLooksGeneric(locale, role, summary.headline) ? headlineFor(locale, role) : truncate(summary.headline, 80),
    overview: truncate(summary.overview, 220),
    status: hasEvidence ? summary.status : "unconfirmed",
    confidence: hasEvidence ? clampConfidence(summary.confidence) : Math.min(clampConfidence(summary.confidence), 0.35),
    evidenceFiles,
    bullets: unique(summary.bullets).map((bullet) => truncate(bullet, 220))
  };
}

function normalizeClaim(claim: StructuredClaim, allowedFiles: Set<string>): StructuredClaim {
  const evidenceFiles = claim.evidenceFiles.filter(
    (file) => (allowedFiles.size === 0 || allowedFiles.has(file)) && isPrimaryEvidencePath(file)
  );
  const hasEvidence = evidenceFiles.length > 0;
  const title = truncate(claim.title, 120);
  const noise = isLikelyNoise(title);
  return {
    ...claim,
    title,
    description: truncate(claim.description, 260),
    status: hasEvidence && !noise ? claim.status : "unconfirmed",
    confidence: hasEvidence && !noise ? clampConfidence(claim.confidence) : Math.min(clampConfidence(claim.confidence), 0.35),
    evidenceFiles,
    rationale: truncate(claim.rationale, 260)
  };
}

function filterTextConfidence(value: string, confidence: number): number {
  if (isLikelyNoise(value)) {
    return Math.min(confidence, 0.35);
  }
  return confidence;
}

function filterScanResult(scan: RepoScanResult): {
  scan: RepoScanResult;
  removedFiles: string[];
  removedDirectories: string[];
  allowedFiles: Set<string>;
} {
  const filteredFiles = scan.files.filter((file) => !isNoisePath(file.relativePath));
  const removedFiles = scan.files.filter((file) => isNoisePath(file.relativePath)).map((file) => file.relativePath);
  const allowedFiles = new Set(filteredFiles.map((file) => file.relativePath));
  const filteredDirectories = scan.directories.filter((directory) => !isNoisePath(directory));
  const removedDirectories = scan.directories.filter((directory) => isNoisePath(directory));

  const filterList = (values: string[]): string[] => unique(values.filter((value) => allowedFiles.has(value) && !isNoisePath(value)));

  return {
    scan: {
      ...scan,
      files: filteredFiles,
      directories: filteredDirectories,
      manifests: filterList(scan.manifests),
      configs: filterList(scan.configs),
      tests: filterList(scan.tests),
      entrypoints: filterList(scan.entrypoints),
      docs: filterList(scan.docs),
      ignored: scan.ignored + removedFiles.length + removedDirectories.length
    },
    removedFiles,
    removedDirectories,
    allowedFiles
  };
}

function filterFileInsights(
  insights: FileInsight[],
  allowedFiles: Set<string>,
  rejectedEvidence: AutoFilterDecision[],
  noiseSignals: string[]
): FileInsight[] {
  const filtered: FileInsight[] = [];
  for (const item of insights) {
    if (isNoisePath(item.path) || isLowValueEvidencePath(item.path) || !allowedFiles.has(item.path)) {
      rejectedEvidence.push({
        kind: "file",
        action: "reject",
        label: item.path,
        reason: "runtime artifact, generated file, or low-value metadata file was excluded before analysis",
        files: [item.path, ...item.evidence.slice(0, 3)]
      });
      noiseSignals.push(`Rejected file insight: ${item.path}`);
      continue;
    }

    const evidence = unique(item.evidence.filter((file) => allowedFiles.has(file) && !isNoisePath(file)));
    const summaryNoise = isLikelyNoise(item.summary) || item.signals.every((signal) => isLikelyNoise(signal));
    const confidence = summaryNoise ? filterTextConfidence(item.summary, item.confidence) : clampConfidence(item.confidence);

    if (summaryNoise) {
      rejectedEvidence.push({
        kind: "claim",
        action: "downrank",
        label: item.path,
        reason: "generic file insight was downranked",
        files: [item.path, ...evidence.slice(0, 3)]
      });
      noiseSignals.push(`Downranked generic file insight: ${item.path}`);
    }

    filtered.push({
      ...item,
      summary: truncate(item.summary, 220),
      signals: unique(item.signals).map((signal) => truncate(signal, 120)),
      evidence,
      confidence,
      tokenHints: unique(item.tokenHints).map((hint) => truncate(hint, 80)),
      reusedFromCache: item.reusedFromCache
    });
  }

  return filtered;
}

function filterSignals(
  signals: RepoSignal[],
  allowedFiles: Set<string>,
  rejectedEvidence: AutoFilterDecision[],
  noiseSignals: string[]
): RepoSignal[] {
  const filtered: RepoSignal[] = [];
  for (const signal of signals) {
    const evidence = unique(signal.evidence.filter((file) => allowedFiles.has(file) && isPrimaryEvidencePath(file)));
    if (evidence.length === 0) {
      rejectedEvidence.push({
        kind: "signal",
        action: "reject",
        label: signal.label,
        reason: "signal evidence points only to runtime artifacts or filtered files",
        files: signal.evidence.slice(0, 4)
      });
      noiseSignals.push(`Rejected noisy signal: ${signal.label}`);
      continue;
    }

    const labelNoise = isLikelyNoise(signal.label) || isLikelyNoise(signal.value);
    const confidence = labelNoise ? Math.min(clampConfidence(signal.confidence), 0.35) : clampConfidence(signal.confidence);
    if (labelNoise) {
      rejectedEvidence.push({
        kind: "signal",
        action: "downrank",
        label: signal.label,
        reason: "generic signal was downranked",
        files: evidence.slice(0, 4)
      });
      noiseSignals.push(`Downranked generic signal: ${signal.label}`);
    }

    filtered.push({
      ...signal,
      value: truncate(signal.value, 180),
      confidence,
      evidence
    });
  }
  return filtered;
}

export function buildAutoFilterResult(context: StructuredAnalysisContext): AutoFilterResult {
  const rejectedEvidence: AutoFilterDecision[] = [];
  const noiseSignals: string[] = [];
  const { scan: filteredScan, removedFiles, removedDirectories, allowedFiles } = filterScanResult(context.scan);
  const fileInsights = filterFileInsights(context.fileInsights, allowedFiles, rejectedEvidence, noiseSignals);
  const signals = filterSignals(context.signals, allowedFiles, rejectedEvidence, noiseSignals);
  const filteredModules = buildModuleMap(filteredScan, fileInsights).filter((module) => !isLikelyNoise(module.module));
  const filteredDeepDiveTargets = context.deepDiveTargets.filter(
    (target) => allowedFiles.has(target) && !isNoisePath(target) && !isLowValueEvidencePath(target)
  );
  const filteredContext: StructuredAnalysisContext = {
    ...context,
    scan: filteredScan,
    fileInsights,
    signals,
    modules: filteredModules,
    deepDiveTargets: filteredDeepDiveTargets
  };
  const evidencePack = buildEvidencePack(filteredContext);

  const filterNotes = unique([
    `${removedFiles.length} runtime or generated files removed before model analysis.`,
    `${removedDirectories.length} runtime or generated directories removed before model analysis.`,
    `${fileInsights.length} filtered file insights kept after noise cleanup.`,
    `${signals.length} signals kept after noise cleanup.`
  ]);

  return {
    scan: filteredScan,
    fileInsights,
    signals,
    evidencePack,
    noiseSignals: unique(noiseSignals),
    rejectedEvidence,
    filterNotes,
    deepDiveTargets: filteredDeepDiveTargets
  };
}

export function buildStructuredFallbackAnalysis(context: StructuredAnalysisContext): StructuredAnalysis {
  const { locale, scan, model, repoType, domain, signals, modules, outline, deepDiveTargets } = context;
  const repoTypeEvidence = unique(
    evidenceFromModel(model)
      .concat(scan.manifests.slice(0, 2), scan.entrypoints.slice(0, 2))
      .filter((file) => isPrimaryEvidencePath(file))
  );
  const domainEvidence = unique(
    collectEvidenceFiles(model.evidence)
      .concat(scan.docs.slice(0, 2))
      .filter((file) => isPrimaryEvidencePath(file))
  );
  const topInsightEvidence = unique(
    context.fileInsights.slice(0, 6).flatMap((item) => item.evidence).filter((file) => isPrimaryEvidencePath(file)).slice(0, 8)
  );

  const repoTypeSummary = fallbackSummary(
    locale,
    "repoType",
    locale === "zh-CN"
      ? `根据入口文件、manifest 和文件摘要判断，这个仓库看起来像是 ${repoType.label}。`
      : `Based on manifests, entrypoints, and file summaries, this repository looks like a ${repoType.label}.`,
    repoType.confidence,
    repoTypeEvidence,
    repoType.reasons
  );

  const domainSummary = fallbackSummary(
    locale,
    "domain",
    locale === "zh-CN"
      ? `结合文件名、内容关键词和上下文信号，推断业务领域为 ${domain.label}。`
      : `File names, content keywords, and context signals suggest ${domain.label}.`,
    domain.confidence,
    domainEvidence,
    domain.reasons
  );

  const technicalSummary = fallbackSummary(
    locale,
    "technicalSummary",
    locale === "zh-CN"
      ? "这个仓库已经识别出入口、配置和模块边界，但更细的业务含义仍需要代码证据继续验证。"
      : "The repository has identifiable entrypoints, configuration, and module boundaries, but the finer business interpretation still needs code evidence.",
    Math.min(repoType.confidence, domain.confidence),
    [...repoTypeEvidence, ...context.fileInsights.slice(0, 4).flatMap((item) => item.evidence)],
    [
      ...(signals.slice(0, 4).map((signal) => `${signal.label}: ${signal.value}`))
    ]
  );

  const businessSummary = fallbackSummary(
    locale,
    "businessSummary",
    locale === "zh-CN"
      ? "这个仓库看起来像一个围绕业务流程或编排构建的系统，其价值在于连接接入、校验、路由和结果交付。"
      : "This repository looks like a system built around business workflow or orchestration, whose value is to connect intake, validation, routing, and outcome delivery.",
    Math.min(repoType.confidence, domain.confidence),
    [...domainEvidence, ...topInsightEvidence],
    [
      ...(signals.slice(0, 4).map((signal) => `${signal.label}: ${signal.value}`))
    ]
  );

  const entities = model.entities.map((entity) =>
    fallbackClaim(
      entity.name,
      entity.description,
      entity.confidence,
      entity.evidence,
      locale === "zh-CN"
        ? `这个实体是围绕 ${entity.name} 的路径和内容信号反复出现而推断出来的。`
        : `This entity was inferred from repeated path and content signals around ${entity.name}.`
    )
  );

  const flows = model.flows.map((flow) =>
    fallbackClaim(
      flow.title,
      flow.description,
      flow.confidence,
      flow.evidence,
      locale === "zh-CN"
        ? "这个流程步骤来自入口、测试和文件摘要中的顺序信号。"
        : "The flow step comes from ordering signals found in entrypoints, tests, and file summaries."
    )
  );

  const rules = model.rules.map((rule) =>
    fallbackClaim(
      rule.rule,
      rule.rationale,
      rule.confidence,
      rule.evidence,
      locale === "zh-CN"
        ? "这个规则语句是根据约束类表述和测试线索重建出来的。"
        : "The rule statement is reconstructed from constraint-like statements and test cues."
    )
  );

  const moduleClaims = modules.map((module) =>
    fallbackClaim(
      module.module,
      module.role,
      0.6,
      module.evidence,
      locale === "zh-CN"
        ? "模块职责是根据目录分组和命名模式推断出来的。"
        : "The module role is inferred from directory grouping and naming patterns."
    )
  );

  const riskClaims = model.unknowns.slice(0, 5).map((unknown, index) =>
    fallbackClaim(
      locale === "zh-CN" ? `未知项 ${index + 1}` : `Unknown ${index + 1}`,
      unknown,
      0.4,
      [...scan.docs.slice(0, 2), ...scan.tests.slice(0, 2)],
      locale === "zh-CN"
        ? "这是一个仍需进一步验证的低置信度结论。"
        : "This item remains a low-confidence statement that needs further validation."
    )
  );

  const evidenceItems: EvidenceItem[] = model.evidence.length > 0
    ? model.evidence
        .map((item) => ({
          ...item,
          files: unique(item.files.filter((file) => isPrimaryEvidencePath(file)))
        }))
        .filter((item) => item.files.length > 0)
    : context.fileInsights.slice(0, 8).map((item) => ({
        claim: item.summary,
        files: unique([item.path, ...item.evidence].filter((file) => isPrimaryEvidencePath(file))).slice(0, 4),
        confidence: item.confidence,
        notes: item.signals.join("; ")
      }));

  return {
    repoType: repoTypeSummary,
    domain: domainSummary,
    technicalSummary,
    businessSummary,
    entities,
    flows,
    rules,
    modules: moduleClaims,
    risks: riskClaims,
    evidenceItems,
    unknowns: unique([
      ...model.unknowns,
      ...(scan.tests.length === 0
        ? [locale === "zh-CN" ? "未发现测试文件，行为边界仍需验证。" : "No tests were found, so behavior boundaries still need validation."]
        : [])
    ]),
    recommendations: unique([
      ...(locale === "zh-CN"
        ? [
            "先确认入口和运行命令是否与 README 说明一致。",
            "用真实测试或样例输入验证关键流程。"
          ]
        : [
            "Confirm that the entrypoints and run commands match the README guidance.",
            "Validate the key flows with real tests or sample inputs."
          ]),
      ...model.outline.slice(0, 3)
    ]),
    reportOutline: unique([...outline, ...context.deepDiveTargets.map((item) => `${locale === "zh-CN" ? "??" : "Deep dive"}: ${item}`)]),
    qaNotes: unique(model.evidence.map((item) => item.notes).filter(Boolean).map((note) => truncate(note, 180)))
  };
}

export function normalizeStructuredAnalysis(
  raw: unknown,
  fallback: StructuredAnalysis,
  allowedEvidenceFiles: Set<string>,
  locale: LocaleCode
): StructuredAnalysis {
  const parsed = structuredAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    return fallback;
  }

  const value = parsed.data;
  return {
    repoType: normalizeSummary(value.repoType, allowedEvidenceFiles, locale, "repoType"),
    domain: normalizeSummary(value.domain, allowedEvidenceFiles, locale, "domain"),
    technicalSummary: normalizeSummary(value.technicalSummary, allowedEvidenceFiles, locale, "technicalSummary"),
    businessSummary: normalizeSummary(value.businessSummary, allowedEvidenceFiles, locale, "businessSummary"),
    entities: value.entities.map((item) => normalizeClaim(item, allowedEvidenceFiles)).filter((item) => !isLikelyNoise(item.title)),
    flows: value.flows.map((item) => normalizeClaim(item, allowedEvidenceFiles)).filter((item) => !isLikelyNoise(item.title)),
    rules: value.rules.map((item) => normalizeClaim(item, allowedEvidenceFiles)).filter((item) => !isLikelyNoise(item.title)),
    modules: value.modules.map((item) => normalizeClaim(item, allowedEvidenceFiles)).filter((item) => !isLikelyNoise(item.title)),
    risks: value.risks.map((item) => normalizeClaim(item, allowedEvidenceFiles)).filter((item) => !isLikelyNoise(item.title)),
    evidenceItems: value.evidenceItems.map((item) => ({
      claim: truncate(item.claim, 180),
      files: unique(item.files.filter((file) => (allowedEvidenceFiles.size === 0 || allowedEvidenceFiles.has(file)) && isPrimaryEvidencePath(file))),
      confidence: clampConfidence(item.confidence),
      notes: truncate(item.notes, 220)
    })).filter((item) => item.files.length > 0),
    unknowns: unique(value.unknowns.map((item) => truncate(item, 220))),
    recommendations: unique(value.recommendations.map((item) => truncate(item, 220))),
    reportOutline: unique(value.reportOutline.map((item) => truncate(item, 160))),
    qaNotes: unique(value.qaNotes.map((item) => truncate(item, 220)))
  };
}

export function buildEvidencePack(context: StructuredAnalysisContext): StructuredEvidencePack {
  const topInsights = [...context.fileInsights]
    .filter((item) => isPrimaryEvidencePath(item.path))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 18)
    .map((item) => ({
      path: item.path,
      category: item.category,
      summary: item.summary,
      signals: item.signals.slice(0, 8),
      evidence: item.evidence.slice(0, 5),
      confidence: item.confidence
    }));

  const selectedSourceFiles = context.scan.files.filter((file) => isPrimaryEvidencePath(file.relativePath));
  const selectedFiles = [...(selectedSourceFiles.length > 0 ? selectedSourceFiles : context.scan.files)]
    .sort((a, b) => {
      const aPriority = (context.scan.entrypoints.includes(a.relativePath) ? 4 : 0) + (context.scan.manifests.includes(a.relativePath) ? 3 : 0) + (context.scan.tests.includes(a.relativePath) ? 2 : 0) + (context.scan.docs.includes(a.relativePath) ? 1 : 0);
      const bPriority = (context.scan.entrypoints.includes(b.relativePath) ? 4 : 0) + (context.scan.manifests.includes(b.relativePath) ? 3 : 0) + (context.scan.tests.includes(b.relativePath) ? 2 : 0) + (context.scan.docs.includes(b.relativePath) ? 1 : 0);
      return bPriority - aPriority || b.size - a.size;
    })
    .slice(0, 20)
    .map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      category: file.category,
      sample: file.sample.slice(0, 1600),
      hash: file.hash,
      size: file.size
    }));

  return {
    repoName: context.scan.rootName,
    repoPath: context.scan.rootPath,
    fingerprint: context.scan.fingerprint,
    fileCount: context.scan.files.length,
    directoryCount: context.scan.directories.length,
    repoType: context.repoType,
    domain: context.domain,
    signals: context.signals,
    fileInsights: topInsights,
    files: selectedFiles,
    manifests: context.scan.manifests.slice(0, 20),
    configs: context.scan.configs.slice(0, 20),
    tests: context.scan.tests.slice(0, 20),
    entrypoints: context.scan.entrypoints.slice(0, 20),
    docs: context.scan.docs.slice(0, 20),
    modules: context.modules.slice(0, 12),
    outline: context.outline,
    deepDiveTargets: context.deepDiveTargets
  };
}
