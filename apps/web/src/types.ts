import type { LocaleCode } from "./i18n";

export type JobStatus = "queued" | "running" | "completed" | "failed";
export type ProviderKind = "openai" | "anthropic";

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

export interface RepoScanResult {
  rootName: string;
  rootPath: string;
  files: Array<{
    path: string;
    relativePath: string;
    extension: string;
    size: number;
    mtimeMs: number;
    isText: boolean;
    hash: string | null;
    category: string;
    sample: string;
  }>;
  directories: string[];
  manifests: string[];
  configs: string[];
  tests: string[];
  entrypoints: string[];
  docs: string[];
  ignored: number;
  fingerprint: string;
}

export interface EvidenceItem {
  claim: string;
  files: string[];
  confidence: number;
  notes: string;
}

export interface ReportSection {
  id: string;
  title: string;
  markdown: string;
}

export type StructuredStatus = "confirmed" | "provisional" | "unconfirmed";
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

export interface RepositoryAnalysis {
  analysisVersion: number;
  analysisMode: string;
  analysisProfileKey: string;
  locale: LocaleCode;
  repoPath: string;
  repoName: string;
  fingerprint: string;
  fileCount: number;
  directoryCount: number;
  scan: RepoScanResult;
  fileInsights: Array<{
    path: string;
    category: string;
    summary: string;
    signals: string[];
    evidence: string[];
    confidence: number;
    tokenHints: string[];
    reusedFromCache: boolean;
  }>;
  signals: Array<{
    label: string;
    value: string;
    confidence: number;
    evidence: string[];
  }>;
  repoType: RepoTypePrediction;
  domain: RepoTypePrediction;
  worldModel: WorldModel;
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
  qaIssues: string[];
  qaPasses: number;
  generatedAt: string;
}

export interface JobSnapshot {
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

export interface ProviderConfig {
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  updatedAt: string;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: ProviderKind;
  endpoint: string;
  model: string;
  availableModels: string[];
  selectedModelFound: boolean;
  message: string;
  statusCode?: number;
  requestId?: string;
}

export interface ProviderConfigResponse {
  config: ProviderConfig;
  endpoint: string;
  supportedProviders: ProviderKind[];
  message: string;
}

export type ReportView = "combined" | "technical" | "business";
