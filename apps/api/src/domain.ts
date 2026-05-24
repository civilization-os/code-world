import type { LocaleCode } from "./i18n.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type StepStatus = "pending" | "running" | "done" | "error";

export type AnalysisStage =
  | "scanRepo"
  | "classifySignals"
  | "filterEvidence"
  | "inferRepository"
  | "reconstructBusiness"
  | "draftReport"
  | "qualityCheck"
  | "deepDive"
  | "finalizeReport";

export interface TimelineEntry {
  stage: AnalysisStage;
  label: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  message?: string;
}

export interface RepoFileRecord {
  path: string;
  relativePath: string;
  extension: string;
  size: number;
  mtimeMs: number;
  isText: boolean;
  hash: string | null;
  category: string;
  sample: string;
}

export interface FileInsight {
  path: string;
  category: string;
  summary: string;
  signals: string[];
  evidence: string[];
  confidence: number;
  tokenHints: string[];
  reusedFromCache: boolean;
}

export interface RepoSignal {
  label: string;
  value: string;
  confidence: number;
  evidence: string[];
}

export interface RepoTypePrediction {
  label: string;
  confidence: number;
  reasons: string[];
}

export interface BusinessEntity {
  name: string;
  kind: string;
  description: string;
  evidence: string[];
  confidence: number;
}

export interface FlowStep {
  id: string;
  title: string;
  description: string;
  evidence: string[];
  confidence: number;
  order: number;
}

export interface RuleItem {
  rule: string;
  rationale: string;
  evidence: string[];
  confidence: number;
}

export interface EvidenceReviewItem {
  kind: "file" | "signal" | "claim";
  action: "keep" | "downrank" | "reject";
  label: string;
  reason: string;
  files: string[];
}

export interface ReportSection {
  id: string;
  title: string;
  markdown: string;
}

export interface EvidenceItem {
  claim: string;
  files: string[];
  confidence: number;
  notes: string;
}

export type StructuredStatus = "confirmed" | "provisional" | "unconfirmed";

export interface StructuredClaim {
  title: string;
  description: string;
  status: StructuredStatus;
  confidence: number;
  evidenceFiles: string[];
  rationale: string;
}

export interface StructuredSummary {
  headline: string;
  overview: string;
  status: StructuredStatus;
  confidence: number;
  evidenceFiles: string[];
  bullets: string[];
}

export interface StructuredAnalysis {
  repoType: StructuredSummary;
  domain: StructuredSummary;
  technicalSummary: StructuredSummary;
  businessSummary: StructuredSummary;
  entities: StructuredClaim[];
  flows: StructuredClaim[];
  rules: StructuredClaim[];
  modules: StructuredClaim[];
  risks: StructuredClaim[];
  evidenceItems: EvidenceItem[];
  unknowns: string[];
  recommendations: string[];
  reportOutline: string[];
  qaNotes: string[];
}

export type WorldNodeKind = "repository" | "domain" | "service" | "entity" | "flow" | "rule" | "dependency" | "risk" | "evidence";
export type WorldNodeLevel = "macro" | "meso" | "micro";
export type WorldEdgeKind = "contains" | "implements" | "uses" | "depends_on" | "evidenced_by" | "raises_risk";

export interface WorldModelNode {
  id: string;
  kind: WorldNodeKind;
  level: WorldNodeLevel;
  label: string;
  description: string;
  confidence: number;
  status: StructuredStatus;
  evidenceFiles: string[];
  tags: string[];
}

export interface WorldModelEdge {
  id: string;
  from: string;
  to: string;
  kind: WorldEdgeKind;
  confidence: number;
  rationale: string;
  evidenceFiles: string[];
}

export interface WorldEvidenceChain {
  id: string;
  claim: string;
  nodeIds: string[];
  files: string[];
  confidence: number;
  reasoning: string;
}

export interface WorldReasoningEvent {
  id: string;
  stage: AnalysisStage;
  title: string;
  description: string;
  nodeIds: string[];
  evidenceFiles: string[];
  confidence: number;
  timestamp: string;
}

export interface WorldModel {
  version: number;
  repoName: string;
  repoPath: string;
  generatedAt: string;
  summary: string;
  confidence: number;
  nodes: WorldModelNode[];
  edges: WorldModelEdge[];
  evidenceChains: WorldEvidenceChain[];
  reasoningEvents: WorldReasoningEvent[];
  uncertainties: string[];
}

export interface RepoScanResult {
  rootName: string;
  rootPath: string;
  files: RepoFileRecord[];
  directories: string[];
  manifests: string[];
  configs: string[];
  tests: string[];
  entrypoints: string[];
  docs: string[];
  ignored: number;
  fingerprint: string;
}

export type AnalysisMode = "model" | "fallback" | "cached";

export interface RepositoryAnalysis {
  analysisVersion: number;
  analysisMode: AnalysisMode;
  analysisProfileKey: string;
  locale: LocaleCode;
  repoPath: string;
  repoName: string;
  fingerprint: string;
  fileCount: number;
  directoryCount: number;
  scan: RepoScanResult;
  fileInsights: FileInsight[];
  signals: RepoSignal[];
  repoType: RepoTypePrediction;
  domain: RepoTypePrediction;
  structuredAnalysis: StructuredAnalysis;
  worldModel: WorldModel;
  technicalMarkdown: string;
  businessMarkdown: string;
  entities: BusinessEntity[];
  flows: FlowStep[];
  rules: RuleItem[];
  evidence: EvidenceItem[];
  unknowns: string[];
  noiseSignals?: string[];
  rejectedEvidence?: EvidenceReviewItem[];
  filterNotes?: string[];
  modules: Array<{ module: string; role: string; evidence: string[] }>;
  outline: string[];
  sections: ReportSection[];
  reportMarkdown: string;
  cacheHit: boolean;
  fileCacheHits: number;
  fileCacheMisses: number;
  qaIssues: string[];
  qaPasses: number;
  generatedAt: string;
}

export interface AnalysisJobSnapshot {
  id: string;
  sourceJobId?: string;
  revision: number;
  locale: LocaleCode;
  status: JobStatus;
  repoPath: string;
  repoName: string;
  createdAt: string;
  updatedAt: string;
  currentStage: AnalysisStage;
  currentLabel: string;
  progress: number;
  error: string | null;
  timeline: TimelineEntry[];
  analysis: RepositoryAnalysis | null;
}

export const ANALYSIS_STAGES: Array<{
  stage: AnalysisStage;
  label: string;
  progress: number;
}> = [
  { stage: "scanRepo", label: "Scan repository", progress: 10 },
  { stage: "classifySignals", label: "Classify repository signals", progress: 25 },
  { stage: "filterEvidence", label: "Filter evidence and noise", progress: 35 },
  { stage: "inferRepository", label: "Infer repository type and domain", progress: 45 },
  { stage: "reconstructBusiness", label: "Reconstruct business objects and flows", progress: 60 },
  { stage: "qualityCheck", label: "Check report quality", progress: 75 },
  { stage: "deepDive", label: "Deep dive unknown areas", progress: 85 },
  { stage: "draftReport", label: "Draft report sections", progress: 95 },
  { stage: "finalizeReport", label: "Finalize report", progress: 100 }
];

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".repo-inspector",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "out",
  "target",
  "vendor",
  ".idea",
  ".vscode",
  ".venv"
]);

export const DEFAULT_TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".md",
  ".txt",
  ".csv",
  ".sql",
  ".env",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".bat",
  ".ps1",
  ".dockerfile",
  ".prisma",
  ".graphql",
  ".gql"
]);

export const MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "pyproject.toml",
  "requirements.txt",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "composer.json",
  "Gemfile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Makefile",
  "Procfile"
]);

export const ENTRYPOINT_HINTS = [
  "main",
  "index",
  "server",
  "app",
  "bootstrap",
  "start",
  "cli",
  "worker",
  "route",
  "routes",
  "handler",
  "controller",
  "command",
  "cmd",
  "shell",
  "daemon",
  "engine"
];

export const BUSINESS_DOMAIN_KEYWORDS: Record<string, string[]> = {
  ecommerce: [
    "order",
    "cart",
    "checkout",
    "payment",
    "invoice",
    "catalog",
    "inventory",
    "shipping",
    "fulfillment",
    "sku",
    "product",
    "merchant"
  ],
  workflow: [
    "approve",
    "approval",
    "review",
    "task",
    "workflow",
    "state",
    "transition",
    "queue",
    "assignment",
    "ticket",
    "request"
  ],
  content: [
    "document",
    "content",
    "article",
    "page",
    "cms",
    "media",
    "publish",
    "draft",
    "asset"
  ],
  support: [
    "message",
    "conversation",
    "chat",
    "ticket",
    "support",
    "inbox",
    "thread",
    "reply"
  ],
  identity: [
    "auth",
    "login",
    "token",
    "session",
    "permission",
    "role",
    "account",
    "access",
    "identity"
  ],
  analytics: [
    "dashboard",
    "metric",
    "report",
    "chart",
    "event",
    "telemetry",
    "analytics",
    "segment"
  ],
  finance: [
    "billing",
    "invoice",
    "payment",
    "ledger",
    "balance",
    "transaction",
    "payout",
    "refund"
  ],
  agent: [
    "agent",
    "graph",
    "checkpoint",
    "tool",
    "memory",
    "workflow",
    "state",
    "node",
    "task"
  ],
  devtool: [
    "plugin",
    "cli",
    "sdk",
    "build",
    "deploy",
    "release",
    "pipeline",
    "webhook",
    "template"
  ]
};

export const STOP_WORDS = new Set([
  "src",
  "lib",
  "dist",
  "build",
  "node_modules",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "spec",
  "specs",
  "story",
  "stories",
  "mock",
  "mocks",
  "helper",
  "helpers",
  "util",
  "utils",
  "common",
  "shared",
  "index",
  "main",
  "app",
  "server",
  "client",
  "public",
  "assets",
  "static",
  "tmp",
  "temp",
  "package",
  "config",
  "configs",
  "default",
  "base",
  "root",
  "data"
]);
