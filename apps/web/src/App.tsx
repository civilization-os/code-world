import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  connectJobStream,
  createJob,
  deleteJob,
  downloadAnalysisJson,
  downloadMarkdown,
  loadProviderConfig,
  listJobs,
  rerunJob,
  saveProviderConfig,
  testProviderConfig
} from "./api";
import { detectLocale, persistLocale, uiText, type LocaleCode } from "./i18n";
import type { AnalysisStage, JobSnapshot, ProviderConfig, ProviderTestResult, RepositoryAnalysis, ReportView } from "./types";

type BannerTone = "info" | "success" | "warning" | "error";
type SurfaceMode = "workspace" | "history";

type BannerMessage = {
  tone: BannerTone;
  text: string;
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTimelineDuration(startedAt?: string, endedAt?: string): string {
  if (!startedAt) {
    return "—";
  }

  const started = new Date(startedAt).getTime();
  const finished = endedAt ? new Date(endedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, finished - started);

  if (!Number.isFinite(elapsedMs)) {
    return "—";
  }

  const totalSeconds = Math.round(elapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatSignedDelta(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

type HistoryDeltaMetric = {
  label: string;
  value: string;
  detail: string;
};

type HistoryDeltaSummary = {
  title: string;
  subtitle: string;
  summary: string;
  metrics: HistoryDeltaMetric[];
};

function buildHistoryDelta(
  snapshot: JobSnapshot,
  analysis: RepositoryAnalysis | null,
  previousJob: JobSnapshot | null,
  locale: LocaleCode,
  ui: ReturnType<typeof uiText>
): HistoryDeltaSummary | null {
  if (!analysis) {
    return {
      title: locale === "zh-CN" ? "版本差异" : "Version delta",
      subtitle: locale === "zh-CN" ? "当前记录还在生成中，暂时没有完整分析可对比。" : "This record is still materializing, so there is no finished analysis to compare yet.",
      summary:
        locale === "zh-CN"
          ? "你仍然可以先看时间线和当前状态。"
          : "You can still inspect the timeline and current status.",
      metrics: [
        {
          label: locale === "zh-CN" ? "当前阶段" : "Current stage",
          value: runtimeStageLabel(snapshot.currentStage, ui),
          detail: ui.statusLabels[snapshot.status]
        },
        {
          label: locale === "zh-CN" ? "进度" : "Progress",
          value: `${snapshot.progress}%`,
          detail: snapshot.error ?? snapshot.currentLabel
        }
      ]
    };
  }

  if (!previousJob || !previousJob.analysis) {
    return {
      title: locale === "zh-CN" ? "版本差异" : "Version delta",
      subtitle: locale === "zh-CN" ? "这是原始记录，没有上一版完整分析可对比。" : "This is the original run, with no prior completed analysis to compare.",
      summary:
        locale === "zh-CN"
          ? "它会作为后续修订的基线。"
          : "It will act as the baseline for later revisions.",
      metrics: [
        {
          label: locale === "zh-CN" ? "修订版" : "Revision",
          value: snapshot.revision > 1 ? `r${snapshot.revision}` : "r1",
          detail: snapshot.sourceJobId ? `${ui.derivedFrom} ${snapshot.sourceJobId.slice(0, 8)}` : ui.originalRun
        },
        {
          label: locale === "zh-CN" ? "文件数" : "Files",
          value: String(analysis.fileCount),
          detail: `${analysis.directoryCount} ${locale === "zh-CN" ? "目录" : "folders"}`
        }
      ]
    };
  }

  const previousAnalysis = previousJob.analysis;
  const previousRevisionLabel = previousJob.revision > 1 ? `r${previousJob.revision}` : "r1";
  const currentRevisionLabel = snapshot.revision > 1 ? `r${snapshot.revision}` : "r1";
  const fileDelta = analysis.fileCount - previousAnalysis.fileCount;
  const unknownDelta = analysis.unknowns.length - previousAnalysis.unknowns.length;
  const qaDelta = analysis.qaPasses - previousAnalysis.qaPasses;
  const typeChanged = analysis.repoType.label !== previousAnalysis.repoType.label;
  const domainChanged = analysis.domain.label !== previousAnalysis.domain.label;

  const summaryParts = [];
  if (typeChanged || domainChanged) {
    summaryParts.push(
      locale === "zh-CN"
        ? `分析焦点从 ${previousAnalysis.domain.label} 调整到 ${analysis.domain.label}`
        : `Focus shifted from ${previousAnalysis.domain.label} to ${analysis.domain.label}`
    );
  } else {
    summaryParts.push(
      locale === "zh-CN"
        ? `分析焦点继续停留在 ${analysis.domain.label}`
        : `The analysis focus stays on ${analysis.domain.label}`
    );
  }

  if (fileDelta !== 0) {
    summaryParts.push(
      locale === "zh-CN"
        ? `文件数 ${formatSignedDelta(fileDelta)}`
        : `${formatSignedDelta(fileDelta)} files`
    );
  }

  if (unknownDelta !== 0) {
    summaryParts.push(
      locale === "zh-CN"
        ? `未知项 ${formatSignedDelta(unknownDelta)}`
        : `${formatSignedDelta(unknownDelta)} unknowns`
    );
  }

  if (qaDelta !== 0) {
    summaryParts.push(
      locale === "zh-CN"
        ? `QA 通过数 ${formatSignedDelta(qaDelta)}`
        : `${formatSignedDelta(qaDelta)} QA passes`
    );
  }

  return {
    title: locale === "zh-CN" ? "版本差异" : "Version delta",
    subtitle:
      locale === "zh-CN"
        ? `对比 ${previousRevisionLabel} → ${currentRevisionLabel}`
        : `Compared with ${previousRevisionLabel} → ${currentRevisionLabel}`,
    summary:
      summaryParts.length > 0
        ? summaryParts.join(locale === "zh-CN" ? " · " : " · ")
        : locale === "zh-CN"
          ? "与上一版相比，结论基本保持一致。"
          : "The result stays broadly consistent with the previous revision.",
    metrics: [
      {
        label: locale === "zh-CN" ? "世界类型" : "World type",
        value: analysis.repoType.label,
        detail: previousAnalysis.repoType.label
      },
      {
        label: locale === "zh-CN" ? "业务域" : "Business domain",
        value: analysis.domain.label,
        detail: previousAnalysis.domain.label
      },
      {
        label: locale === "zh-CN" ? "文件数" : "Files",
        value: `${analysis.fileCount}`,
        detail: `${previousAnalysis.fileCount} (${formatSignedDelta(fileDelta)})`
      },
      {
        label: locale === "zh-CN" ? "未知项" : "Unknowns",
        value: `${analysis.unknowns.length}`,
        detail: `${previousAnalysis.unknowns.length} (${formatSignedDelta(unknownDelta)})`
      },
      {
        label: locale === "zh-CN" ? "QA 通过" : "QA passes",
        value: `${analysis.qaPasses}`,
        detail: `${previousAnalysis.qaPasses} (${formatSignedDelta(qaDelta)})`
      }
    ]
  };
}

function defaultProviderBaseUrl(provider: ProviderConfig["provider"]): string {
  return provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
}

function resolveProviderBaseUrl(config: Pick<ProviderConfig, "provider" | "baseUrl">): string {
  const trimmed = config.baseUrl.trim();
  return trimmed.length > 0 ? trimmed : defaultProviderBaseUrl(config.provider);
}

function stageTone(status: string): string {
  return (
    {
      done: "stage done",
      running: "stage running",
      error: "stage error",
      pending: "stage pending"
    }[status] || "stage pending"
  );
}

function runtimeStatusLabel(status: string, locale: LocaleCode): string {
  const labels =
    locale === "zh-CN"
      ? {
          pending: "待形成",
          running: "形成中",
          done: "已固化",
          error: "受阻"
        }
      : {
          pending: "forming",
          running: "thinking",
          done: "settled",
          error: "blocked"
        };
  return labels[status as keyof typeof labels] ?? status;
}

function runtimeStageLabel(stage: AnalysisStage, ui: ReturnType<typeof uiText>): string {
  return ui.stageLabels[stage] ?? stage;
}

async function markdownToHtml(markdown: string): Promise<string> {
  return String(await Promise.resolve(marked.parse(markdown, { breaks: true })));
}

function SummaryCard({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail?: string;
}): JSX.Element {
  return (
    <div className="summary-card">
      <div className="summary-label">{label}</div>
      <div className="summary-value">{value}</div>
      {detail ? <div className="summary-detail">{detail}</div> : null}
    </div>
  );
}

type FocusKind = "root" | "domain" | "module" | "entity" | "flow" | "rule" | "evidence" | "unknown";

type FocusNode = {
  id: string;
  kind: FocusKind;
  label: string;
  detail: string;
  confidence?: number;
  evidence: string[];
  notes?: string;
};

function confidenceLabel(value?: number): string {
  return typeof value === "number" ? formatPercent(value) : "—";
}

function buildFocusNodes(analysis: RepositoryAnalysis | null, ui: ReturnType<typeof uiText>): FocusNode[] {
  if (!analysis) {
    return [];
  }

  if (analysis.worldModel?.nodes?.length) {
    const kindMap: Record<string, FocusKind> = {
      repository: "root",
      domain: "domain",
      service: "module",
      entity: "entity",
      flow: "flow",
      rule: "rule",
      dependency: "module",
      risk: "unknown",
      evidence: "evidence"
    };

    return analysis.worldModel.nodes.map((node) => ({
      id: `world-${node.id}`,
      kind: kindMap[node.kind] ?? "unknown",
      label: node.label,
      detail: node.description,
      confidence: node.confidence,
      evidence: node.evidenceFiles,
      notes: node.description
    }));
  }

  return [
    {
      id: "root",
      kind: "root",
      label: analysis.repoName,
      detail: analysis.repoType.label,
      confidence: analysis.repoType.confidence,
      evidence: analysis.repoType.reasons,
      notes: ui.analysisSummary
    },
    {
      id: "domain",
      kind: "domain",
      label: analysis.domain.label,
      detail: ui.businessDomain,
      confidence: analysis.domain.confidence,
      evidence: analysis.domain.reasons,
      notes: analysis.domain.reasons.join(" · ")
    },
    ...analysis.modules.slice(0, 6).map((module, index) => ({
      id: `module-${index}-${module.module}`,
      kind: "module" as const,
      label: module.module,
      detail: module.role,
      confidence: undefined,
      evidence: module.evidence,
      notes: module.role
    })),
    ...analysis.entities.slice(0, 8).map((entity, index) => ({
      id: `entity-${index}-${entity.name}`,
      kind: "entity" as const,
      label: entity.name,
      detail: entity.kind,
      confidence: entity.confidence,
      evidence: entity.evidence,
      notes: entity.description
    })),
    ...analysis.flows.slice(0, 8).map((flow, index) => ({
      id: `flow-${index}-${flow.id}`,
      kind: "flow" as const,
      label: flow.title,
      detail: flow.description,
      confidence: flow.confidence,
      evidence: flow.evidence,
      notes: `${flow.order}. ${flow.description}`
    })),
    ...analysis.rules.slice(0, 8).map((rule, index) => ({
      id: `rule-${index}-${rule.rule}`,
      kind: "rule" as const,
      label: rule.rule,
      detail: rule.rationale,
      confidence: rule.confidence,
      evidence: rule.evidence,
      notes: rule.rationale
    })),
    ...analysis.evidence.slice(0, 8).map((item, index) => ({
      id: `evidence-${index}-${item.claim}`,
      kind: "evidence" as const,
      label: item.claim,
      detail: item.notes,
      confidence: item.confidence,
      evidence: item.files,
      notes: item.notes
    })),
    ...analysis.unknowns.slice(0, 8).map((unknown, index) => ({
      id: `unknown-${index}-${unknown}`,
      kind: "unknown" as const,
      label: unknown,
      detail: ui.unknowns,
      confidence: undefined,
      evidence: [],
      notes: unknown
    }))
  ];
}

function kindLabel(kind: FocusKind, ui: ReturnType<typeof uiText>): string {
  const labels: Record<FocusKind, string> = {
    root: ui.repoType,
    domain: ui.businessDomain,
    module: ui.moduleMap,
    entity: ui.coreObjects,
    flow: ui.flows,
    rule: "Rules",
    evidence: "Evidence",
    unknown: ui.unknowns
  };
  return labels[kind];
}

function KnowledgeTree({
  analysis,
  focusId,
  onFocus,
  ui
}: {
  analysis: RepositoryAnalysis | null;
  focusId: string | null;
  onFocus: (node: FocusNode) => void;
  ui: ReturnType<typeof uiText>;
}): JSX.Element {
  const nodes = buildFocusNodes(analysis, ui);
  const root = nodes[0];
  const groups = [
    { label: ui.moduleMap, kind: "module" as const },
    { label: ui.coreObjects, kind: "entity" as const },
    { label: ui.flows, kind: "flow" as const },
    { label: "Rules", kind: "rule" as const },
    { label: "Evidence", kind: "evidence" as const },
    { label: ui.unknowns, kind: "unknown" as const }
  ];

  return (
    <div className="panel tree-panel">
      <div className="panel-head">
        <div>
          <h2>{ui.analysisSummary}</h2>
          <span className="hint">{analysis ? analysis.repoName : ui.noJob}</span>
        </div>
      </div>

      <div className="tree-root">
        <button type="button" className={`tree-root-node ${focusId === "root" ? "active" : ""}`} onClick={() => root && onFocus(root)}>
          <strong>{analysis ? analysis.repoName : ui.noJob}</strong>
          <span>{analysis ? analysis.repoType.label : ui.analysisTimeline}</span>
        </button>
      </div>

      <div className="tree-stream">
        {groups.map((group) => {
          const children = nodes.filter((node) => node.kind === group.kind);
          if (children.length === 0) {
            return null;
          }
          return (
            <details key={group.kind} open className="tree-group">
              <summary>
                <span>{group.label}</span>
                <small>{children.length}</small>
              </summary>
              <div className="tree-children">
                {children.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className={`tree-node ${focusId === node.id ? "active" : ""}`}
                    onClick={() => onFocus(node)}
                  >
                    <strong>{node.label}</strong>
                    <span>{node.detail}</span>
                    <small>{kindLabel(node.kind, ui)}</small>
                  </button>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function EvidenceBrowser({
  analysis,
  reportHtml,
  reportView,
  setReportView,
  focus,
  locale,
  ui
}: {
  analysis: RepositoryAnalysis | null;
  reportHtml: string;
  reportView: ReportView;
  setReportView: (view: ReportView) => void;
  focus: FocusNode | null;
  locale: LocaleCode;
  ui: ReturnType<typeof uiText>;
}): JSX.Element {
  const [tab, setTab] = useState<"evidence" | "code" | "narrative">("narrative");

  useEffect(() => {
    if (!analysis) {
      setTab("evidence");
      return;
    }
    setTab("narrative");
  }, [analysis]);

  const selectedFiles = focus?.evidence ?? [];
  const matchedInsights = analysis
    ? analysis.fileInsights.filter((item) => selectedFiles.some((file) => item.evidence.includes(file) || item.path.includes(file) || file.includes(item.path)))
    : [];

  return (
    <div className="panel evidence-panel">
      <div className="panel-head">
        <div>
          <h2>{analysis ? focus?.label ?? ui.reportTitle : ui.reportTitle}</h2>
          <span className="hint">{focus ? `${kindLabel(focus.kind, ui)} · ${confidenceLabel(focus.confidence)}` : ui.renderedLocally}</span>
        </div>
        <div className="report-view-switch" role="tablist" aria-label={ui.reportViewTitle}>
          {(["code", "evidence", "narrative"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? "secondary active" : "secondary"}
              onClick={() => setTab(item)}
            >
              {item === "code"
                ? locale === "zh-CN"
                  ? "认知"
                  : "World"
                : item === "evidence"
                  ? locale === "zh-CN"
                    ? "证据"
                    : "Evidence"
                  : locale === "zh-CN"
                    ? "叙述"
                    : "Narrative"}
            </button>
          ))}
        </div>
      </div>

      {tab === "code" ? (
        <div className="evidence-browser cognition-browser">
          <div className="evidence-hero cognition-hero">
            <span>{ui.analysisTimeline}</span>
            <strong>{focus ? focus.label : analysis?.repoName ?? ui.noJob}</strong>
            <p>{focus?.detail ?? ui.heroCopy}</p>
          </div>

          <div className="code-graph world-canvas">
            <div className="code-world">
              <span>{analysis ? analysis.repoType.label : ui.analysisSummary}</span>
              <strong>{analysis ? analysis.domain.label : ui.noJob}</strong>
              <small>{analysis ? `${analysis.entities.length} ${ui.coreObjects} · ${analysis.flows.length} ${ui.flows}` : ui.heroCopy}</small>
            </div>
            <div className="code-flow">
              {(analysis?.flows ?? []).slice(0, 6).map((flow) => (
                <div key={flow.id} className="code-flow-node">
                  <strong>{flow.title}</strong>
                  <span>{flow.description}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="evidence-metrics world-metrics">
            <SummaryCard
              label={ui.confidence}
              value={confidenceLabel(focus?.confidence)}
              detail={focus?.kind ? kindLabel(focus.kind, ui) : ui.analysisSummary}
            />
            <SummaryCard
              label={ui.unknownsCount}
              value={analysis ? String(analysis.unknowns.length) : "0"}
              detail={analysis?.unknowns[0] ?? ui.summaryDetail.noUnknowns}
            />
          </div>

          <div className="evidence-lists">
            <div className="evidence-block">
              <h3>{ui.coreObjects}</h3>
              <ul>
                {(analysis?.entities ?? []).slice(0, 8).map((entity) => (
                  <li key={entity.name} className={focus?.label === entity.name ? "active" : ""}>
                    <strong>{entity.name}</strong>
                    <span>{entity.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="evidence-block">
              <h3>{ui.flows}</h3>
              <ul>
                {(analysis?.flows ?? []).slice(0, 8).map((flow) => (
                  <li key={flow.id} className={focus?.label === flow.title ? "active" : ""}>
                    <strong>{flow.title}</strong>
                    <span>{formatPercent(flow.confidence)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="evidence-block">
              <h3>{ui.moduleMap}</h3>
              <ul>
                {(analysis?.modules ?? []).slice(0, 8).map((module) => (
                  <li key={module.module} className={focus?.label === module.module ? "active" : ""}>
                    <strong>{module.module}</strong>
                    <span>{module.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {matchedInsights.length > 0 ? (
            <div className="evidence-clip">
              <h3>{ui.analysisSummary}</h3>
              {matchedInsights.slice(0, 4).map((item) => (
                <div key={item.path} className="clip-card">
                  <div className="clip-top">
                    <strong>{item.path}</strong>
                    <span>{formatPercent(item.confidence)}</span>
                  </div>
                  <p>{item.summary}</p>
                  <small>{item.evidence.join(" · ")}</small>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : tab === "evidence" ? (
        <div className="evidence-browser">
          <div className="evidence-summary">
            <div className="evidence-hero">
              <span>{ui.analysisTimeline}</span>
              <strong>{focus ? focus.label : analysis?.repoName ?? ui.noJob}</strong>
              <p>{focus?.detail ?? ui.heroCopy}</p>
            </div>
            <div className="evidence-metrics">
              <SummaryCard
                label={ui.confidence}
                value={confidenceLabel(focus?.confidence)}
                detail={focus?.kind ? kindLabel(focus.kind, ui) : ui.analysisSummary}
              />
              <SummaryCard
                label={ui.unknownsCount}
                value={analysis ? String(analysis.unknowns.length) : "0"}
                detail={analysis?.unknowns[0] ?? ui.summaryDetail.noUnknowns}
              />
            </div>
          </div>

          <div className="evidence-lists">
            <div className="evidence-block">
              <h3>{ui.coreObjects}</h3>
              <ul>
                {(analysis?.entities ?? []).slice(0, 8).map((entity) => (
                  <li key={entity.name} className={focus?.label === entity.name ? "active" : ""}>
                    <strong>{entity.name}</strong>
                    <span>{entity.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="evidence-block">
              <h3>{ui.flows}</h3>
              <ul>
                {(analysis?.flows ?? []).slice(0, 8).map((flow) => (
                  <li key={flow.id} className={focus?.label === flow.title ? "active" : ""}>
                    <strong>{flow.title}</strong>
                    <span>{formatPercent(flow.confidence)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {matchedInsights.length > 0 ? (
            <div className="evidence-clip">
              <h3>{ui.analysisSummary}</h3>
              {matchedInsights.slice(0, 4).map((item) => (
                <div key={item.path} className="clip-card">
                  <div className="clip-top">
                    <strong>{item.path}</strong>
                    <span>{formatPercent(item.confidence)}</span>
                  </div>
                  <p>{item.summary}</p>
                  <small>{item.evidence.join(" · ")}</small>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="narrative-shell">
          <div className="report-view-switch narrative-switch" role="tablist" aria-label={ui.reportViewTitle}>
            {(Object.keys(ui.reportViews) as ReportView[]).map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={reportView === view}
                className={reportView === view ? "secondary active" : "secondary"}
                onClick={() => setReportView(view)}
              >
                {ui.reportViews[view]}
              </button>
            ))}
          </div>
          <article className="report-content narrative-view" dangerouslySetInnerHTML={{ __html: reportHtml }} />
        </div>
      )}
    </div>
  );
}
function RuntimeMonitor({
  snapshot,
  analysis,
  reportView,
  ui,
  locale
}: {
  snapshot: JobSnapshot | null;
  analysis: RepositoryAnalysis | null;
  reportView: ReportView;
  ui: ReturnType<typeof uiText>;
  locale: LocaleCode;
}): JSX.Element {
  if (!snapshot) {
    return (
      <section className="runtime-stage" aria-label={ui.analysisTimeline}>
        <div className="panel runtime-monitor empty">
          <div className="panel-head runtime-head">
            <div>
              <p className="eyebrow runtime-eyebrow">{ui.appTagline}</p>
              <h2>{ui.analysisTimeline}</h2>
            </div>
            <span className="status-pill queued">{ui.statusLabels.queued}</span>
          </div>
          <div className="runtime-empty-grid">
            <div className="runtime-empty-card">
              <span>{ui.heroNoteStrong}</span>
              <strong>{ui.heroNoteTail}</strong>
              <p>{ui.noJob}</p>
            </div>
            <div className="runtime-empty-card muted">
              <span>{ui.reportTitle}</span>
              <strong>{ui.reportViews.combined}</strong>
              <p>{ui.heroCopy}</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const topConfidence = analysis ? Math.min(analysis.repoType.confidence, analysis.domain.confidence) : 0;

  return (
    <section className="runtime-stage" aria-label={ui.analysisTimeline}>
      <div className="panel runtime-monitor">
        <div className="panel-head runtime-head">
          <div>
            <p className="eyebrow runtime-eyebrow">{ui.appTagline}</p>
            <h2>{ui.analysisTimeline}</h2>
          </div>
          <div className="runtime-head-meta">
            <span className={`status-pill ${snapshot.status}`}>{ui.statusLabels[snapshot.status]}</span>
            <span className="hint">{runtimeStageLabel(snapshot.currentStage, ui)}</span>
          </div>
        </div>

        <div className="runtime-grid">
          <div className="runtime-stat runtime-stat-hero">
            <span>{ui.analysisTimeline}</span>
            <strong>{runtimeStageLabel(snapshot.currentStage, ui)}</strong>
            <small>{snapshot.currentLabel}</small>
          </div>
          <div className="runtime-stat">
            <span>{ui.statusLabels[snapshot.status]}</span>
            <strong>{snapshot.progress}%</strong>
            <small>{snapshot.currentStage}</small>
          </div>
          <div className="runtime-stat">
            <span>{ui.confidence}</span>
            <strong>{analysis ? formatPercent(topConfidence) : "—"}</strong>
            <small>{analysis ? `${analysis.unknowns.length} ${ui.unknownsCount}` : ui.noJob}</small>
          </div>
        </div>

        <div className="progress-shell" aria-label={ui.analysisTimeline}>
          <div className="progress-bar" style={{ width: `${snapshot.progress}%` }} />
        </div>

        <div className="runtime-timeline-grid">
          {snapshot.timeline.map((step) => (
            <div key={step.stage} className={`runtime-step-card ${stageTone(step.status)}${step.stage === snapshot.currentStage ? " current" : ""}`}>
              <div className="timeline-top">
                <strong>{runtimeStageLabel(step.stage, ui)}</strong>
                <span>{runtimeStatusLabel(step.status, locale)}</span>
              </div>
              {step.message ? <p>{step.message}</p> : null}
            </div>
          ))}
        </div>

        {analysis ? <div className="runtime-summary"><AnalysisOverview analysis={analysis} ui={ui} /></div> : null}

        {snapshot.error ? (
          <div className="error-banner">
            <strong>{snapshot.status === "failed" ? ui.statusLabels.failed : ui.errors.analysisFailed}</strong>{" "}
            {snapshot.error}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AnalysisOverview({
  analysis,
  ui
}: {
  analysis: RepositoryAnalysis;
  ui: ReturnType<typeof uiText>;
}): JSX.Element {
  const topConfidence = Math.min(analysis.repoType.confidence, analysis.domain.confidence);
  return (
    <div className="overview-grid">
      <SummaryCard label={ui.repoType} value={analysis.repoType.label} detail={formatPercent(analysis.repoType.confidence)} />
      <SummaryCard label={ui.businessDomain} value={analysis.domain.label} detail={formatPercent(analysis.domain.confidence)} />
      <SummaryCard
        label={ui.filesScanned}
        value={String(analysis.fileCount)}
        detail={`${analysis.directoryCount} ${ui.summaryDetail.directories}`}
      />
      <SummaryCard
        label={ui.unknownsCount}
        value={String(analysis.unknowns.length)}
        detail={analysis.unknowns[0] ? analysis.unknowns[0] : ui.summaryDetail.noUnknowns}
      />
    </div>
  );
}

type WorldGraphNode = {
  id: string;
  focusId: string | null;
  label: string;
  subtitle: string;
  confidence: number;
  tone: string;
  level: "core" | "macro" | "meso" | "micro";
  x: number;
  y: number;
  chips: string[];
  evidence: string[];
  notes: string;
};

type WorldGraphLink = {
  id: string;
  from: string;
  to: string;
  tone: string;
  kind: string;
  level: "macro" | "meso" | "micro";
  dashed?: boolean;
};

type CognitionNodeData = {
  graph: WorldGraphNode;
  active: boolean;
  focused: boolean;
  onFocusId: (nodeId: string | null) => void;
};

type CognitionFlowNode = Node<CognitionNodeData, "cognition">;

function CognitionNode({ data, selected }: NodeProps<CognitionFlowNode>): JSX.Element {
  const node = data.graph;
  return (
    <button
      type="button"
      className={`graph-node readable-node flow-node tone-${node.tone}${data.focused || selected ? " active" : ""}${node.level === "core" ? " core" : ""}${data.active ? " live" : ""}`}
      onClick={() => data.onFocusId(node.focusId)}
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Right} className="flow-handle" />
      <div className="graph-node-head">
        <strong>{node.label}</strong>
        <span>{formatPercent(node.confidence)}</span>
      </div>
      <small>{node.subtitle}</small>
      <div className="graph-chip-row">
        {node.chips.slice(0, 3).map((chip) => (
          <em key={chip}>{chip}</em>
        ))}
      </div>
    </button>
  );
}

const cognitionNodeTypes = { cognition: CognitionNode };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function shortEvidenceLabel(path: string): string {
  return basename(path).replace(/\.(tsx?|jsx?|py|java|json|md|yml|yaml|toml)$/i, "");
}

function providerConfidenceLabel(analysis: RepositoryAnalysis): string {
  return analysis.analysisProfileKey || "Runtime";
}

function isPathLikeLabel(label: string): boolean {
  return /[\\/]/.test(label) || /^\.[a-z0-9_-]+$/i.test(label) || /\.[a-z0-9]{1,6}$/i.test(label);
}

function graphNodeLevel(kind: string, label: string, level: "macro" | "meso" | "micro"): WorldGraphNode["level"] {
  if (kind === "repository") {
    return "core";
  }

  if (isPathLikeLabel(label)) {
    return "micro";
  }

  if (kind === "domain" || kind === "service" || kind === "dependency") {
    return "macro";
  }

  if (kind === "entity" || kind === "flow" || kind === "risk") {
    return "meso";
  }

  if (kind === "rule" || kind === "evidence") {
    return "micro";
  }

  return level;
}

function graphNodePriority(node: { confidence: number; status: string; kind: string }): number {
  const statusBoost = node.status === "confirmed" ? 1 : node.status === "provisional" ? 0.35 : -0.8;
  const kindBoost = node.kind === "domain" ? 0.4 : node.kind === "service" ? 0.25 : node.kind === "repository" ? 0.5 : 0;
  return node.confidence + statusBoost + kindBoost;
}

function isReadableGraphNode(node: { kind: string; label: string; confidence: number; status: string }): boolean {
  if (node.kind === "repository") {
    return true;
  }

  const label = node.label.trim();
  const looksLikePath = isPathLikeLabel(label);
  const weakRule = node.kind === "rule" && node.status !== "confirmed";

  if (looksLikePath || weakRule) {
    return node.confidence >= 0.86;
  }

  return node.status !== "unconfirmed" || node.confidence >= 0.72;
}

function graphPosition(level: WorldGraphNode["level"], index: number): { x: number; y: number } {
  const macro = [
    { x: 50, y: 18 },
    { x: 25, y: 30 },
    { x: 75, y: 30 },
    { x: 22, y: 55 },
    { x: 78, y: 55 },
    { x: 38, y: 72 },
    { x: 62, y: 72 },
    { x: 50, y: 84 }
  ];
  const meso = [
    { x: 30, y: 24 },
    { x: 70, y: 24 },
    { x: 20, y: 45 },
    { x: 80, y: 45 },
    { x: 32, y: 66 },
    { x: 68, y: 66 },
    { x: 50, y: 82 }
  ];
  const micro = [
    { x: 18, y: 22 },
    { x: 38, y: 20 },
    { x: 62, y: 20 },
    { x: 82, y: 22 },
    { x: 18, y: 50 },
    { x: 82, y: 50 },
    { x: 30, y: 76 },
    { x: 50, y: 80 },
    { x: 70, y: 76 }
  ];

  const positions = level === "macro" ? macro : level === "meso" ? meso : micro;
  return positions[index % positions.length];
}

function topKinds(analysis: RepositoryAnalysis | null, ui: ReturnType<typeof uiText>) {
  if (!analysis) {
    return [];
  }

  const groups = [
    { label: ui.moduleMap, kind: "module" as const, items: analysis.modules.slice(0, 5) },
    { label: ui.coreObjects, kind: "entity" as const, items: analysis.entities.slice(0, 5) },
    { label: ui.flows, kind: "flow" as const, items: analysis.flows.slice(0, 5) },
    { label: "Evidence", kind: "evidence" as const, items: analysis.evidence.slice(0, 4) }
  ];

  return groups.filter((group) => group.items.length > 0);
}

function buildWorldGraph(analysis: RepositoryAnalysis | null, nodes: FocusNode[]): { graphNodes: WorldGraphNode[]; graphLinks: WorldGraphLink[] } {
  if (!analysis) {
    return { graphNodes: [], graphLinks: [] };
  }

  const toneOrder = ["mint", "cyan", "blue", "violet", "amber", "rose"];
  if (analysis.worldModel?.nodes?.length) {
    const focusByLabel = new Map(nodes.map((node) => [node.label, node.id]));
    const repositoryNode = analysis.worldModel.nodes.find((node) => node.kind === "repository") ?? analysis.worldModel.nodes[0];
    const candidates = analysis.worldModel.nodes
      .filter((node) => node.id !== repositoryNode?.id)
      .filter(isReadableGraphNode)
      .map((node) => ({ node, level: graphNodeLevel(node.kind, node.label, node.level) }))
      .filter((item) => item.level !== "core");
    const macroNodes = candidates
      .filter((item) => item.level === "macro")
      .sort((a, b) => graphNodePriority(b.node) - graphNodePriority(a.node))
      .slice(0, 8);
    const mesoNodes = candidates
      .filter((item) => item.level === "meso")
      .sort((a, b) => graphNodePriority(b.node) - graphNodePriority(a.node))
      .slice(0, 8);
    const microNodes = candidates
      .filter((item) => item.level === "micro")
      .sort((a, b) => graphNodePriority(b.node) - graphNodePriority(a.node))
      .slice(0, 9);
    const selected = [
      ...(repositoryNode ? [{ node: repositoryNode, level: "core" as const }] : []),
      ...macroNodes,
      ...mesoNodes,
      ...microNodes
    ];

    const levelIndex = { macro: 0, meso: 0, micro: 0 };
    const graphNodes = selected.map(({ node, level }, index) => {
      const isRepository = node.kind === "repository";
      const position = isRepository ? { x: 50, y: 45 } : graphPosition(level, levelIndex[level as keyof typeof levelIndex]++);
      return {
        id: node.id,
        focusId: focusByLabel.get(node.label) ?? null,
        label: node.label,
        subtitle: node.kind,
        confidence: node.confidence,
        tone: isRepository ? "core" : toneOrder[index % toneOrder.length],
        level,
        x: position.x,
        y: position.y,
        chips: node.tags.slice(0, 3),
        evidence: node.evidenceFiles,
        notes: node.description
      };
    });

    const knownNodeIds = new Set(graphNodes.map((node) => node.id));
    const graphLinks = analysis.worldModel.edges
      .filter((edge) => knownNodeIds.has(edge.from) && knownNodeIds.has(edge.to))
      .map((edge, index) => {
        const fromNode = graphNodes.find((node) => node.id === edge.from);
        const toNode = graphNodes.find((node) => node.id === edge.to);
        const edgeLevel = fromNode?.level === "core" ? toNode?.level : fromNode?.level;
        return {
          id: edge.id.replace(/[^a-zA-Z0-9_-]/g, "-"),
          from: edge.from,
          to: edge.to,
          tone: fromNode?.tone === "core" ? toneOrder[index % toneOrder.length] : fromNode?.tone ?? toneOrder[index % toneOrder.length],
          kind: edge.kind,
          level: edge.kind === "evidenced_by" ? "micro" as const : edgeLevel === "core" ? "macro" as const : edgeLevel ?? "meso" as const,
          dashed: edge.kind === "evidenced_by" || edge.kind === "raises_risk"
        };
      })
      .slice(0, 28);

    return { graphNodes, graphLinks };
  }

  const focusMap = new Map(nodes.map((node) => [node.label, node.id]));
  const modulePositions = [
    { x: 12, y: 18 },
    { x: 72, y: 12 },
    { x: 88, y: 30 },
    { x: 64, y: 54 },
    { x: 16, y: 48 }
  ];

  const graphNodes: WorldGraphNode[] = [
    {
      id: "world-core",
      focusId: "root",
      label: analysis.repoName,
      subtitle: analysis.domain.label,
      confidence: clamp((analysis.repoType.confidence + analysis.domain.confidence) / 2, 0, 1),
      tone: "core",
      level: "core",
      x: 41,
      y: 29,
      chips: analysis.modules.slice(0, 2).map((module) => shortEvidenceLabel(module.module)),
      evidence: analysis.repoType.reasons,
      notes: analysis.domain.reasons.join(" · ")
    }
  ];

  const graphLinks: WorldGraphLink[] = [];

  analysis.modules.slice(0, 5).forEach((module, index) => {
    const relatedEntity = analysis.entities.find((entity) => entity.evidence.some((item) => module.evidence.includes(item)));
    const relatedFlow = analysis.flows[index];
    const pos = modulePositions[index] ?? { x: 14 + index * 11, y: 12 + index * 7 };
    const confidence = relatedEntity?.confidence ?? relatedFlow?.confidence ?? clamp(0.9 - index * 0.08, 0.42, 0.96);
    const label = module.module;

    graphNodes.push({
      id: `module-${index}`,
      focusId: focusMap.get(label) ?? null,
      label,
      subtitle: module.role,
      confidence,
      tone: toneOrder[index % toneOrder.length],
      level: "macro",
      x: pos.x,
      y: pos.y,
      chips: module.evidence.slice(0, 3).map(shortEvidenceLabel),
      evidence: module.evidence,
      notes: module.role
    });

    graphLinks.push({
      id: `module-link-${index}`,
      from: `module-${index}`,
      to: "world-core",
      tone: toneOrder[index % toneOrder.length],
      kind: relatedFlow?.title ?? module.role,
      level: "macro"
    });
  });

  const entityPositions = [
    { x: 22, y: 30 },
    { x: 26, y: 58 },
    { x: 56, y: 22 },
    { x: 74, y: 44 },
    { x: 48, y: 66 }
  ];

  analysis.entities.slice(0, 5).forEach((entity, index) => {
    const pos = entityPositions[index] ?? { x: 20 + index * 8, y: 18 + index * 6 };
    const sourceModule = analysis.modules[index % Math.max(analysis.modules.length, 1)];
    graphNodes.push({
      id: `entity-${index}`,
      focusId: focusMap.get(entity.name) ?? null,
      label: entity.name,
      subtitle: entity.kind,
      confidence: entity.confidence,
      tone: toneOrder[(index + 1) % toneOrder.length],
      level: "meso",
      x: pos.x,
      y: pos.y,
      chips: entity.evidence.slice(0, 2).map(shortEvidenceLabel),
      evidence: entity.evidence,
      notes: entity.description
    });

    graphLinks.push({
      id: `entity-link-${index}`,
      from: sourceModule ? `module-${index % Math.max(analysis.modules.length, 1)}` : "world-core",
      to: `entity-${index}`,
      tone: toneOrder[(index + 1) % toneOrder.length],
      kind: entity.kind,
      level: "meso",
      dashed: !sourceModule
    });
  });

  const infraSources = [...analysis.scan.manifests, ...analysis.scan.configs, ...analysis.scan.entrypoints]
    .filter((item, index, items) => items.indexOf(item) === index)
    .slice(0, 4);
  const infraPositions = [
    { x: 20, y: 60 },
    { x: 40, y: 68 },
    { x: 62, y: 60 },
    { x: 42, y: 76 }
  ];

  infraSources.forEach((item, index) => {
    const tone = ["rose", "violet", "blue", "amber"][index % 4];
    graphNodes.push({
      id: `infra-${index}`,
      focusId: null,
      label: shortEvidenceLabel(item),
      subtitle: basename(item),
      confidence: clamp(0.88 - index * 0.08, 0.45, 0.92),
      tone,
      level: "micro",
      x: infraPositions[index]?.x ?? 18 + index * 18,
      y: infraPositions[index]?.y ?? 64,
      chips: [],
      evidence: [item],
      notes: item
    });

    graphLinks.push({
      id: `infra-link-${index}`,
      from: `infra-${index}`,
      to: "world-core",
      tone,
      kind: "dependency",
      level: "micro",
      dashed: true
    });
  });

  return { graphNodes, graphLinks };
}

function pickActivationTrail(
  snapshot: JobSnapshot,
  analysis: RepositoryAnalysis | null,
  focus: FocusNode | null,
  graphNodes: WorldGraphNode[]
): string[] {
  if (!analysis || graphNodes.length === 0) {
    return [];
  }

  const byLevel = {
    macro: graphNodes.filter((node) => node.level === "macro"),
    meso: graphNodes.filter((node) => node.level === "meso"),
    micro: graphNodes.filter((node) => node.level === "micro")
  };

  const focusNode = focus ? graphNodes.find((node) => node.focusId === focus.id) : null;
  const macroNode = focusNode?.level === "macro" ? focusNode : byLevel.macro[0];
  const mesoNode = focusNode?.level === "meso" ? focusNode : byLevel.meso[0];
  const microNode = focusNode?.level === "micro" ? focusNode : byLevel.micro[0];

  switch (snapshot.currentStage) {
    case "scanRepo":
    case "classifySignals":
      return [microNode?.id ?? "world-core", "world-core", macroNode?.id ?? "world-core"];
    case "filterEvidence":
    case "qualityCheck":
      return [microNode?.id ?? "world-core", mesoNode?.id ?? "world-core", "world-core"];
    case "inferRepository":
      return [macroNode?.id ?? "world-core", "world-core", mesoNode?.id ?? "world-core"];
    case "reconstructBusiness":
    case "draftReport":
      return [macroNode?.id ?? "world-core", mesoNode?.id ?? "world-core", "world-core"];
    case "deepDive":
      return [mesoNode?.id ?? "world-core", microNode?.id ?? "world-core", "world-core"];
    case "finalizeReport":
    default:
      return [macroNode?.id ?? "world-core", "world-core", microNode?.id ?? "world-core"];
  }
}

function RuntimeSidebar({
  analysis,
  snapshot,
  focusId,
  onFocus,
  ui,
  locale
}: {
  analysis: RepositoryAnalysis | null;
  snapshot: JobSnapshot | null;
  focusId: string | null;
  onFocus: (node: FocusNode) => void;
  ui: ReturnType<typeof uiText>;
  locale: LocaleCode;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const nodes = buildFocusNodes(analysis, ui);
  const root = nodes[0] ?? null;
  const groups = topKinds(analysis, ui)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => JSON.stringify(item).toLowerCase().includes(normalized))
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="world-sidebar">
      <div className="panel brand-panel">
        <div className="brand-mark">
          <span className="brand-orb" />
          <div>
            <strong>Code World</strong>
            <small>AI</small>
          </div>
        </div>

        <div className="sidebar-context-card">
          <strong>{analysis?.repoName ?? "Intelligence-Coder"}</strong>
          <span>{analysis?.repoType.label ?? "frontend-application"}</span>
        </div>

        <div className="sidebar-context-card compact">
          <strong>{analysis ? providerConfidenceLabel(analysis) : "DeepSeek-V3"}</strong>
          <span>{snapshot ? ui.statusLabels[snapshot.status] : ui.statusLabels.queued}</span>
        </div>
      </div>

      <div className="panel nav-panel">
        <div className="nav-project-row">
          <strong>{analysis?.repoType.label ?? "frontend-application"}</strong>
          <span className="nav-chip">{analysis?.repoName ? "main" : "idle"}</span>
        </div>

        <div className="nav-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={locale === "zh-CN" ? "搜索领域 / 模块 / 文件" : "Search domains / modules / files"}
            spellCheck={false}
          />
        </div>

        <div className="nav-section">
          <div className="nav-section-head">
            <h3>{locale === "zh-CN" ? "业务领域" : "Domains"}</h3>
            <span>{analysis ? formatPercent(analysis.domain.confidence) : "—"}</span>
          </div>
          <div className="nav-domain-list">
            {groups.map((group) => (
              <details key={group.label} open className="nav-group">
                <summary>
                  <span>{group.label}</span>
                  <small>{group.items.length}</small>
                </summary>
                <div className="nav-group-items">
                  {group.items.map((item, index) => {
                    const label = "module" in item ? item.module : "name" in item ? item.name : "title" in item ? item.title : item.claim;
                    const detail = "role" in item ? item.role : "kind" in item ? item.kind : "description" in item ? item.description : item.notes;
                    const node = nodes.find((candidate) => candidate.label === label);
                    const confidence = "confidence" in item ? item.confidence : undefined;
                    return (
                      <button
                        key={`${group.label}-${label}-${index}`}
                        type="button"
                        className={`nav-domain-item ${node?.id === focusId ? "active" : ""}`}
                        onClick={() => node && onFocus(node)}
                      >
                        <span className="dot" />
                        <div>
                          <strong>{label}</strong>
                          <small>{detail}</small>
                        </div>
                        <em>{confidence ? formatPercent(confidence) : "—"}</em>
                      </button>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        </div>

        <div className="nav-section">
          <div className="nav-section-head">
            <h3>{locale === "zh-CN" ? "基础设施" : "Infrastructure"}</h3>
            <span>{analysis?.scan.configs.length ?? 0}</span>
          </div>
          <div className="infra-list">
            {[...(analysis?.scan.manifests ?? []), ...(analysis?.scan.configs ?? []), ...(analysis?.scan.entrypoints ?? [])]
              .filter((item, index, items) => items.indexOf(item) === index)
              .slice(0, 6)
              .map((item) => (
                <div key={item} className="infra-item">
                  <span className="dot muted" />
                  <div>
                    <strong>{shortEvidenceLabel(item)}</strong>
                    <small>{basename(item)}</small>
                  </div>
                </div>
              ))}
          </div>
        </div>

        <div className="nav-section">
          <div className="nav-section-head">
            <h3>{locale === "zh-CN" ? "AI 代理" : "Agents"}</h3>
            <span>{snapshot?.timeline.length ?? 0}</span>
          </div>
          <div className="agent-list">
            {(snapshot?.timeline ?? []).slice(0, 6).map((step) => (
              <div key={step.stage} className={`agent-item ${stageTone(step.status)}`}>
                <div>
                  <strong>{runtimeStageLabel(step.stage, ui)}</strong>
                  <small>{step.message ?? step.label}</small>
                </div>
                <span>{runtimeStatusLabel(step.status, locale)}</span>
              </div>
            ))}
          </div>
        </div>

        {root ? (
          <button type="button" className={`tree-root-node world-root ${focusId === root.id ? "active" : ""}`} onClick={() => onFocus(root)}>
            <strong>{root.label}</strong>
            <span>{root.detail}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RuntimeInspector({
  analysis,
  reportHtml,
  reportView,
  setReportView,
  focus,
  locale,
  ui
}: {
  analysis: RepositoryAnalysis | null;
  reportHtml: string;
  reportView: ReportView;
  setReportView: (view: ReportView) => void;
  focus: FocusNode | null;
  locale: LocaleCode;
  ui: ReturnType<typeof uiText>;
}): JSX.Element {
  const [tab, setTab] = useState<"overview" | "evidence" | "narrative">("narrative");

  useEffect(() => {
    setTab("narrative");
  }, [focus?.id]);

  const selectedFiles = focus?.evidence ?? [];
  const matchedInsights = analysis
    ? analysis.fileInsights.filter((item) => selectedFiles.some((file) => item.evidence.includes(file) || item.path.includes(file) || file.includes(item.path)))
    : [];
  const relatedEntities = analysis?.entities.filter((entity) => selectedFiles.some((file) => entity.evidence.includes(file))).slice(0, 6) ?? [];
  const relatedModules = analysis?.modules.filter((module) => selectedFiles.some((file) => module.evidence.includes(file))).slice(0, 6) ?? [];
  const relatedFlows = analysis?.flows.filter((flow) => selectedFiles.some((file) => flow.evidence.includes(file))).slice(0, 4) ?? [];

  return (
    <div className="panel inspector-panel">
      <div className="panel-head inspector-head">
        <div>
          <h2>{focus?.label ?? ui.reportTitle}</h2>
          <span className="hint">{focus ? `${kindLabel(focus.kind, ui)} · ${confidenceLabel(focus.confidence)}` : ui.renderedLocally}</span>
        </div>
        <div className="inspector-tabs" role="tablist" aria-label={ui.reportViewTitle}>
          {([
            ["overview", locale === "zh-CN" ? "概览" : "Overview"],
            ["evidence", locale === "zh-CN" ? "证据" : "Evidence"],
            ["narrative", locale === "zh-CN" ? "叙述" : "Narrative"]
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? "secondary active" : "secondary"}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" ? (
        <div className="inspector-body">
          <div className="inspector-hero">
            <div>
              <strong>{focus?.label ?? analysis?.repoName ?? ui.noJob}</strong>
              <p>{focus?.notes ?? analysis?.domain.reasons.join(" · ") ?? ui.heroCopy}</p>
            </div>
            <span className="inspector-score">{confidenceLabel(focus?.confidence ?? analysis?.domain.confidence)}</span>
          </div>

          <div className="inspector-metrics">
            <SummaryCard label={locale === "zh-CN" ? "证据数" : "Evidence"} value={String(selectedFiles.length || matchedInsights.length)} detail={kindLabel(focus?.kind ?? "root", ui)} />
            <SummaryCard label={ui.coreObjects} value={String(relatedEntities.length || analysis?.entities.length || 0)} detail={locale === "zh-CN" ? "关联实体" : "Related entities"} />
            <SummaryCard label={ui.moduleMap} value={String(relatedModules.length || analysis?.modules.length || 0)} detail={locale === "zh-CN" ? "服务 / 模块" : "Services / modules"} />
            <SummaryCard label={ui.unknownsCount} value={String(analysis?.unknowns.length ?? 0)} detail={analysis?.unknowns[0] ?? ui.summaryDetail.noUnknowns} />
          </div>

          <div className="inspector-list">
            <h3>{locale === "zh-CN" ? "核心服务" : "Core services"}</h3>
            {(relatedModules.length > 0 ? relatedModules : analysis?.modules.slice(0, 5) ?? []).map((module) => (
              <div key={module.module} className="inspector-row">
                <div>
                  <strong>{module.module}</strong>
                  <small>{module.role}</small>
                </div>
                <span>{module.evidence.length} files</span>
              </div>
            ))}
          </div>

          <div className="inspector-list">
            <h3>{locale === "zh-CN" ? "推理链" : "Reasoning chain"}</h3>
            {(relatedFlows.length > 0 ? relatedFlows : analysis?.flows.slice(0, 4) ?? []).map((flow) => (
              <div key={flow.id} className="inspector-row">
                <div>
                  <strong>{flow.title}</strong>
                  <small>{flow.description}</small>
                </div>
                <span>{formatPercent(flow.confidence)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : tab === "evidence" ? (
        <div className="inspector-body">
          <div className="inspector-list">
            <h3>{locale === "zh-CN" ? "证据片段" : "Evidence clips"}</h3>
            {matchedInsights.length > 0 ? (
              matchedInsights.slice(0, 6).map((item) => (
                <div key={item.path} className="clip-card">
                  <div className="clip-top">
                    <strong>{item.path}</strong>
                    <span>{formatPercent(item.confidence)}</span>
                  </div>
                  <p>{item.summary}</p>
                  <small>{item.evidence.join(" · ")}</small>
                </div>
              ))
            ) : (
              <div className="history-empty">{locale === "zh-CN" ? "当前节点还没有可钻取证据。" : "No drillable evidence yet for this node."}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="narrative-shell inspector-body">
          <div className="report-view-switch narrative-switch" role="tablist" aria-label={ui.reportViewTitle}>
            {(Object.keys(ui.reportViews) as ReportView[]).map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={reportView === view}
                className={reportView === view ? "secondary active" : "secondary"}
                onClick={() => setReportView(view)}
              >
                {ui.reportViews[view]}
              </button>
            ))}
          </div>
          <article className="report-content narrative-view" dangerouslySetInnerHTML={{ __html: reportHtml }} />
        </div>
      )}
    </div>
  );
}

function RuntimeWorld({
  snapshot,
  analysis,
  focus,
  onFocusId,
  timelineOpen,
  ui,
  locale
}: {
  snapshot: JobSnapshot | null;
  analysis: RepositoryAnalysis | null;
  focus: FocusNode | null;
  onFocusId: (nodeId: string | null) => void;
  timelineOpen: boolean;
  ui: ReturnType<typeof uiText>;
  locale: LocaleCode;
}): JSX.Element {
  const [layer, setLayer] = useState<"macro" | "meso" | "micro">("macro");
  const focusNodes = useMemo(() => buildFocusNodes(analysis, ui), [analysis, ui]);
  const { graphNodes, graphLinks } = useMemo(() => buildWorldGraph(analysis, focusNodes), [analysis, focusNodes]);

  if (!snapshot) {
    return (
      <section className="runtime-stage" aria-label={ui.analysisTimeline}>
        <div className="panel runtime-monitor empty">
          <div className="world-hud">
            <div>
              <p className="eyebrow runtime-eyebrow">{ui.appTagline}</p>
              <h2>{locale === "zh-CN" ? "AI 认知空间 / 代码世界" : "AI cognition space / code world"}</h2>
              <p className="world-subtitle">{ui.heroCopy}</p>
            </div>
            <div className="world-status-chip idle">{ui.statusLabels.queued}</div>
          </div>
          <div className="empty-world">
            <div className="empty-world-card">
              <strong>{ui.noJob}</strong>
              <p>{ui.heroNoteTail}</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const topConfidence = analysis ? Math.min(analysis.repoType.confidence, analysis.domain.confidence) : 0;
  const currentStepStatus = snapshot.timeline.find((step) => step.stage === snapshot.currentStage)?.status ?? "running";
  const activationTrail = pickActivationTrail(snapshot, analysis, focus, graphNodes);
  const activeSet = new Set(activationTrail.filter(Boolean));
  const visibleNodeSet = new Set(
    graphNodes
      .filter((node) => node.level === "core" || layer === "micro" || node.level === layer)
      .map((node) => node.id)
  );
  const visibleLinks = graphLinks.filter((link) => visibleNodeSet.has(link.from) && visibleNodeSet.has(link.to));
  const flowNodes = graphNodes
    .filter((node) => visibleNodeSet.has(node.id))
    .map((node): CognitionFlowNode => ({
      id: node.id,
      type: "cognition",
      position: {
        x: (node.x - 50) * 15,
        y: (node.y - 45) * 10
      },
      data: {
        graph: node,
        active: activeSet.has(node.id),
        focused: focus?.id === node.focusId,
        onFocusId
      },
      selected: focus?.id === node.focusId
    }));
  const flowEdges = visibleLinks.map((link): Edge => {
    const active = activeSet.has(link.from) || activeSet.has(link.to);
    return {
      id: link.id,
      source: link.from,
      target: link.to,
      type: "smoothstep",
      animated: active,
      className: `react-flow-link tone-${link.tone}${link.dashed ? " dashed" : ""}${active ? " active" : ""}`,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16
      },
      style: {
        strokeWidth: active ? 2.6 : 1.8
      }
    };
  });
  const stageFocusMap: Partial<Record<AnalysisStage, string | null>> = {
    scanRepo: activationTrail[0] ?? null,
    classifySignals: activationTrail[0] ?? null,
    filterEvidence: activationTrail[1] ?? null,
    inferRepository: activationTrail[0] ?? null,
    reconstructBusiness: activationTrail[1] ?? null,
    draftReport: activationTrail[1] ?? null,
    qualityCheck: activationTrail[2] ?? null,
    deepDive: activationTrail[2] ?? null,
    finalizeReport: "root"
  };

  return (
    <section className="runtime-stage" aria-label={ui.analysisTimeline}>
      <div className="panel runtime-monitor runtime-world-panel">
        <div className="world-hud">
          <div>
            <p className="eyebrow runtime-eyebrow">{ui.appTagline}</p>
            <h2>{locale === "zh-CN" ? "AI 认知空间 / 代码世界" : "AI cognition space / code world"}</h2>
            <p className="world-subtitle">{snapshot.currentLabel}</p>
          </div>
          <div className="world-hud-stats">
            <div className="world-mini-stat active">
              <span>{runtimeStageLabel(snapshot.currentStage, ui)}</span>
              <strong>{runtimeStatusLabel(currentStepStatus, locale)}</strong>
              <small>{snapshot.progress}%</small>
            </div>
          </div>
        </div>

        <div className="world-toolbar">
          <div className="world-legend">
            {([
              ["macro", locale === "zh-CN" ? "Macro / 业务域" : "Macro / Domains"],
              ["meso", locale === "zh-CN" ? "Meso / 结构层" : "Meso / Structures"],
              ["micro", locale === "zh-CN" ? "Micro / 代码证据" : "Micro / Code evidence"]
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`secondary world-layer-pill ${layer === key ? "active" : ""}`}
                onClick={() => setLayer(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="world-controls">
            <span className="hint">{locale === "zh-CN" ? "点击节点钻取 · 切换层级阅读" : "Select nodes to inspect · Switch layers to read"}</span>
          </div>
        </div>

        <div className="world-canvas-panel readable-canvas">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={cognitionNodeTypes}
            fitView
            fitViewOptions={{ padding: 0.24, maxZoom: 1.08 }}
            minZoom={0.35}
            maxZoom={1.45}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, node) => onFocusId((node.data as CognitionNodeData).graph.focusId)}
          >
            <Background gap={34} size={1} color="rgba(255,255,255,0.08)" />
            <MiniMap
              pannable
              zoomable
              className="world-minimap"
              nodeColor={(node) => {
                const tone = (node.data as CognitionNodeData).graph.tone;
                return tone === "rose" ? "#ff7f6d" : tone === "amber" ? "#f4b64b" : tone === "violet" ? "#a376ff" : tone === "blue" ? "#55a6ff" : tone === "cyan" ? "#29d3dd" : "#71d1b9";
              }}
            />
            <Controls className="world-flow-controls" showInteractive={false} />
          </ReactFlow>
        </div>

        {timelineOpen ? (
        <div className="timeline-dock">
          <div className="timeline-dock-head">
            <div>
              <h3>{locale === "zh-CN" ? "AI 认知时间线" : "AI cognition timeline"}</h3>
              <span>{locale === "zh-CN" ? "实时流" : "Live flow"}</span>
            </div>
            <div className="timeline-dock-status">
              <span>{ui.statusLabels[snapshot.status]}</span>
              <strong>{snapshot.progress}%</strong>
            </div>
          </div>
          <div className="timeline-dock-track">
            {snapshot.timeline.map((step) => (
              <button
                key={step.stage}
                type="button"
                className={`timeline-dock-card ${stageTone(step.status)}${step.stage === snapshot.currentStage ? " current" : ""}`}
                onClick={() => onFocusId(stageFocusMap[step.stage] ?? null)}
              >
                <small>{step.startedAt ? new Date(step.startedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "..."}</small>
                <strong>{runtimeStageLabel(step.stage, ui)}</strong>
                <p>{step.message ?? step.label}</p>
                <span>{runtimeStatusLabel(step.status, locale)}</span>
              </button>
            ))}
          </div>
        </div>
        ) : null}
      </div>
    </section>
  );
}

export default function App(): JSX.Element {
  const [locale, setLocale] = useState<LocaleCode>(() => detectLocale());
  const [repoPath, setRepoPath] = useState("");
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({
    provider: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    updatedAt: new Date(0).toISOString()
  });
  const [providerTest, setProviderTest] = useState<ProviderTestResult | null>(null);
  const [providerBanner, setProviderBanner] = useState<BannerMessage | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [reportView, setReportView] = useState<ReportView>("combined");
  const [reportHtml, setReportHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyJobs, setHistoryJobs] = useState<JobSnapshot[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<JobSnapshot["status"] | "all">("all");
  const [rerunBusyId, setRerunBusyId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceFocus, setWorkspaceFocus] = useState<"config" | "repo" | "history" | "knowledge">("config");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("workspace");
  const [viewMode, setViewMode] = useState<"world" | "report">("world");
  const [worldIndexOpen, setWorldIndexOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reportRenderSeqRef = useRef(0);
  const knowledgeSectionRef = useRef<HTMLDivElement | null>(null);

  const ui = useMemo(() => uiText(locale), [locale]);
  const runtimeActive = Boolean(snapshot || busy);
  const showWelcome = surfaceMode !== "history" && !snapshot && !busy;
  const starterMarkdown = useMemo(
    () => `# ${ui.title}\n\n${ui.heroCopy}`,
    [ui.heroCopy, ui.title]
  );
  const workspaceAnalysis = snapshot?.analysis ?? null;
  const workspaceHint = surfaceMode !== "history" && !workspaceAnalysis
    ? locale === "zh-CN"
      ? "在右上角打开侧栏后配置模型与仓库路径"
      : "Open the sidebar to configure the model and repository path"
    : null;

  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await loadProviderConfig();
        setProviderConfig(response.config);
        setProviderBanner(response.message ? { tone: "info", text: response.message } : null);
      } catch (loadError) {
        setProviderBanner({ tone: "error", text: loadError instanceof Error ? loadError.message : ui.errors.network });
      }
    })();
  }, [ui.errors.network]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!workspaceOpen) {
      return;
    }
    if (!busy && !snapshot?.analysis) {
      return;
    }
    const timer = window.setTimeout(() => setWorkspaceOpen(false), 1200);
    return () => window.clearTimeout(timer);
  }, [busy, snapshot?.analysis, workspaceOpen]);

  useEffect(() => {
    if (!workspaceOpen || workspaceFocus !== "knowledge" || !knowledgeSectionRef.current) {
      return;
    }

    knowledgeSectionRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [workspaceFocus, workspaceOpen, snapshot?.id, snapshot?.analysis?.analysisVersion]);

  useEffect(() => {
    void (async () => {
      await refreshHistory();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusNodes = useMemo(() => buildFocusNodes(workspaceAnalysis, ui), [workspaceAnalysis, ui]);
  const focusNode = useMemo(() => focusNodes.find((node) => node.id === focusId) ?? focusNodes[0] ?? null, [focusNodes, focusId]);
  const reportMarkdown = useMemo(() => {
    if (!workspaceAnalysis) {
      return starterMarkdown;
    }
    if (reportView === "technical") {
      return workspaceAnalysis.technicalMarkdown || workspaceAnalysis.reportMarkdown || starterMarkdown;
    }
    if (reportView === "business") {
      return workspaceAnalysis.businessMarkdown || workspaceAnalysis.reportMarkdown || starterMarkdown;
    }
    if (workspaceAnalysis.reportMarkdown) {
      return workspaceAnalysis.reportMarkdown;
    }
    if (workspaceAnalysis.technicalMarkdown || workspaceAnalysis.businessMarkdown) {
      return `${workspaceAnalysis.technicalMarkdown}\n\n---\n\n${workspaceAnalysis.businessMarkdown}`;
    }
    return starterMarkdown;
  }, [workspaceAnalysis, reportView, starterMarkdown]);

  useEffect(() => {
    const seq = ++reportRenderSeqRef.current;
    void (async () => {
      const nextHtml = await markdownToHtml(reportMarkdown);
      if (reportRenderSeqRef.current === seq) {
        setReportHtml(nextHtml);
      }
    })();
  }, [reportMarkdown]);

  useEffect(() => {
    if (!workspaceAnalysis) {
      setFocusId(null);
      setEvidenceOpen(false);
      return;
    }
    if (!focusNodes.some((node) => node.id === focusId)) {
      setFocusId(focusNodes[0]?.id ?? null);
    }
  }, [workspaceAnalysis, focusId, focusNodes]);

  const providerEndpoint = useMemo(
    () => resolveProviderBaseUrl(providerConfig),
    [providerConfig]
  );
  const visibleHistoryJobs = useMemo(() => {
    if (!snapshot) {
      return historyJobs;
    }
    if (historyJobs.some((job) => job.id === snapshot.id)) {
      return historyJobs;
    }
    return [snapshot, ...historyJobs];
  }, [historyJobs, snapshot]);
  const historySurface = surfaceMode === "history";
  const shellTabs = useMemo(
    () =>
      [
        {
          key: "analyze",
          label: locale === "zh-CN" ? "分析" : "Analyze",
          active: surfaceMode === "workspace" && viewMode === "world" && !workspaceOpen,
          onClick: () => {
            setSurfaceMode("workspace");
            setViewMode("world");
            setWorkspaceOpen(false);
            setWorkspaceFocus("config");
          }
        },
        ...(workspaceAnalysis ? [{
          key: "report",
          label: locale === "zh-CN" ? "报告" : "Report",
          active: surfaceMode === "workspace" && viewMode === "report",
          onClick: () => {
            setSurfaceMode("workspace");
            setViewMode("report");
            setWorkspaceOpen(false);
            setWorkspaceFocus("config");
          }
        }] : []),
        {
          key: "history",
          label: locale === "zh-CN" ? "历史" : "History",
          active: surfaceMode === "history",
          onClick: () => {
            setHistoryQuery("");
            setHistoryStatusFilter("all");
            setSurfaceMode("history");
            setWorkspaceOpen(false);
            setWorkspaceFocus("history");
          }
        }
      ] as const,
    [locale, surfaceMode, viewMode, workspaceOpen, workspaceFocus, snapshot, workspaceAnalysis]
  );

  async function refreshHistory(): Promise<void> {
    setHistoryBusy(true);
    try {
      const jobs = await listJobs(8);
      setHistoryJobs(jobs);
    } catch {
      // Keep the UI usable even if history fetch fails.
    } finally {
      setHistoryBusy(false);
  }
}

function HistoryRecordLayout({
  snapshot,
  historyJobs,
  reportHtml,
  reportView,
  setReportView,
  onOpenJob,
  onReturnToWorkspace,
  onRerunHistoryJob,
  onDeleteJob,
  rerunBusyId,
  deleteBusyId,
  historyQuery,
  setHistoryQuery,
  historyStatusFilter,
  setHistoryStatusFilter,
  locale,
  ui
}: {
  snapshot: JobSnapshot | null;
  historyJobs: JobSnapshot[];
  reportHtml: string;
  reportView: ReportView;
  setReportView: (view: ReportView) => void;
  onOpenJob: (job: JobSnapshot) => void;
  onReturnToWorkspace: () => void;
  onRerunHistoryJob: (job: JobSnapshot) => Promise<void>;
  onDeleteJob: (job: JobSnapshot) => Promise<void>;
  rerunBusyId: string | null;
  deleteBusyId: string | null;
  historyQuery: string;
  setHistoryQuery: (value: string) => void;
  historyStatusFilter: JobSnapshot["status"] | "all";
  setHistoryStatusFilter: (value: JobSnapshot["status"] | "all") => void;
  locale: LocaleCode;
  ui: ReturnType<typeof uiText>;
}): JSX.Element {
  const analysis = snapshot?.analysis ?? null;
  const timeline = snapshot?.timeline ?? [];
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [selectedTimelineStage, setSelectedTimelineStage] = useState<AnalysisStage | null>(null);

  useEffect(() => {
    setTimelineExpanded(false);
  }, [snapshot?.id]);

  useEffect(() => {
    setSelectedTimelineStage(snapshot?.currentStage ?? timeline[0]?.stage ?? null);
  }, [snapshot?.id, snapshot?.currentStage, timeline]);

  const visibleTimeline = timelineExpanded ? timeline : timeline.slice(0, 3);
  const selectedTimelineStep = timeline.find((step) => step.stage === selectedTimelineStage) ?? timeline[0] ?? null;
  const previousJob = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    const bySource = historyJobs.find((job) => job.id === snapshot.sourceJobId) ?? null;
    if (bySource) {
      return bySource;
    }

    const candidates = historyJobs
      .filter((job) => job.repoPath === snapshot.repoPath && job.id !== snapshot.id && job.revision < snapshot.revision)
      .sort((left, right) => right.revision - left.revision || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

    return candidates[0] ?? null;
  }, [historyJobs, snapshot]);

  const historyDelta = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    return buildHistoryDelta(snapshot, analysis, previousJob, locale, ui);
  }, [analysis, locale, previousJob, snapshot, ui]);

  const filteredJobs = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    return historyJobs.filter((job) => {
      if (historyStatusFilter !== "all" && job.status !== historyStatusFilter) {
        return false;
      }
      if (query.length === 0) {
        return true;
      }

      const haystack = [
        job.repoName,
        job.repoPath,
        job.currentLabel,
        job.sourceJobId ?? "",
        job.revision > 1 ? `r${job.revision}` : "r1",
        ui.statusLabels[job.status],
        job.analysis?.repoType.label ?? "",
        job.analysis?.domain.label ?? ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [historyJobs, historyQuery, historyStatusFilter, ui]);

  useEffect(() => {
    if (snapshot || filteredJobs.length === 0) {
      return;
    }

    void onOpenJob(filteredJobs[0]);
  }, [filteredJobs, onOpenJob, snapshot]);
  const summaryCards = snapshot
    ? analysis
      ? [
          {
            label: locale === "zh-CN" ? "状态" : "Status",
            value: ui.statusLabels[snapshot.status],
            detail: `${snapshot.progress}% · ${runtimeStatusLabel(snapshot.status, locale)}`
          },
          {
            label: locale === "zh-CN" ? "修订版" : "Revision",
            value: snapshot.revision > 1 ? `r${snapshot.revision}` : "r1",
            detail: snapshot.sourceJobId ? `${ui.derivedFrom} ${snapshot.sourceJobId.slice(0, 8)}` : ui.originalRun
          },
          {
            label: locale === "zh-CN" ? "文件数" : "Files",
            value: String(analysis.fileCount),
            detail: `${analysis.directoryCount} ${locale === "zh-CN" ? "目录" : "folders"}`
          },
          {
            label: ui.unknownsCount,
            value: String(analysis.unknowns.length),
            detail: `${analysis.qaPasses} ${locale === "zh-CN" ? "检查通过" : "checks passed"}`
          }
        ]
      : [
          {
            label: locale === "zh-CN" ? "状态" : "Status",
            value: ui.statusLabels[snapshot.status],
            detail: snapshot.currentLabel
          },
          {
            label: locale === "zh-CN" ? "进度" : "Progress",
            value: `${snapshot.progress}%`,
            detail: snapshot.error ?? snapshot.currentStage
          },
          {
            label: locale === "zh-CN" ? "更新时间" : "Updated",
            value: new Date(snapshot.updatedAt).toLocaleDateString(locale, { month: "short", day: "numeric" }),
            detail: new Date(snapshot.updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
          },
          {
            label: locale === "zh-CN" ? "时间线" : "Timeline",
            value: String(timeline.length),
            detail: locale === "zh-CN" ? "尚未固化报告" : "Report not yet materialized"
          }
        ]
    : [
        {
          label: locale === "zh-CN" ? "记录" : "Records",
          value: String(historyJobs.length),
          detail: locale === "zh-CN" ? "从左侧选择一条记录" : "Select a record from the archive"
        },
        {
          label: locale === "zh-CN" ? "时间线" : "Timeline",
          value: "—",
          detail: locale === "zh-CN" ? "打开记录后查看" : "Open a record to inspect"
        },
        {
          label: locale === "zh-CN" ? "报告" : "Report",
          value: "—",
          detail: locale === "zh-CN" ? "尚未选中记录" : "No record selected"
        },
        {
          label: locale === "zh-CN" ? "操作" : "Actions",
          value: "—",
          detail: locale === "zh-CN" ? "可在列表中直接重跑或导出" : "Rerun or export from the archive"
        }
      ];

  return (
    <main className="history-layout">
      <section className="history-column history-archive-column">
        <div className="panel history-archive-panel">
          <div className="panel-head">
            <div>
              <h2>{ui.historyTitle}</h2>
              <span className="hint">
                {locale === "zh-CN"
                  ? `历史记录档案 · ${filteredJobs.length}/${historyJobs.length}`
                  : `Analysis archive · ${filteredJobs.length}/${historyJobs.length}`}
              </span>
            </div>
          </div>

          <div className="history-filter-bar">
            <label className="history-search">
              <span>{locale === "zh-CN" ? "搜索" : "Search"}</span>
              <input
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder={locale === "zh-CN" ? "仓库、路径、修订版、标签" : "Repo, path, revision, label"}
                spellCheck={false}
              />
            </label>
            <div className="history-filter-pills" role="tablist" aria-label={locale === "zh-CN" ? "记录筛选" : "Record filters"}>
              {(
                [
                  ["all", locale === "zh-CN" ? "全部" : "All"],
                  ["queued", ui.statusLabels.queued],
                  ["running", ui.statusLabels.running],
                  ["completed", ui.statusLabels.completed],
                  ["failed", ui.statusLabels.failed]
                ] as const
              ).map(([status, label]) => (
                <button
                  key={status}
                  type="button"
                  className={historyStatusFilter === status ? "secondary active" : "secondary"}
                  onClick={() => setHistoryStatusFilter(status)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="history-archive-list history-list">
            {filteredJobs.length > 0 ? (
              filteredJobs.map((job) => (
                <div key={job.id} className={`history-item ${snapshot?.id === job.id ? "active" : ""}`}>
                  <button type="button" className="history-main history-main-record" onClick={() => onOpenJob(job)}>
                    <strong>{job.repoName}</strong>
                    <span>
                      {ui.statusLabels[job.status]} · {new Date(job.updatedAt).toLocaleString(locale)}
                    </span>
                    <small>
                      {job.revision > 1 ? `${ui.revisionLabel} ${job.revision}` : ui.originalRun}
                      {job.sourceJobId ? ` · ${ui.derivedFrom} ${job.sourceJobId.slice(0, 8)}` : ""}
                    </small>
                  </button>
                  <div className="history-actions history-actions-record">
                    <button
                      type="button"
                      className="secondary history-rerun"
                      onClick={() => void onRerunHistoryJob(job)}
                      disabled={rerunBusyId === job.id}
                    >
                      {rerunBusyId === job.id ? ui.analyzing : ui.rerun}
                    </button>
                    <button
                      type="button"
                      className="secondary history-export-json"
                      onClick={() => void downloadAnalysisJson(job.id, "combined", locale)}
                      disabled={!job.analysis}
                    >
                      {ui.exportJson}
                    </button>
                    <button
                      type="button"
                      className="secondary history-export-md"
                      onClick={() => void downloadMarkdown(job.id, "combined", job.locale)}
                      disabled={!job.analysis}
                    >
                      {ui.exportMarkdown}
                    </button>
                    <button
                      type="button"
                      className="secondary history-delete"
                      onClick={() => void onDeleteJob(job)}
                      disabled={deleteBusyId === job.id || job.status === "queued" || job.status === "running"}
                    >
                      {deleteBusyId === job.id ? ui.analyzing : locale === "zh-CN" ? "删除" : "Delete"}
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="history-empty">
                {locale === "zh-CN" ? "没有匹配的历史记录" : "No matching records"}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="history-column history-detail-column">
        <div className="panel history-detail-panel">
          <div className="panel-head history-detail-head">
            <div>
              <h2>{snapshot?.repoName ?? (locale === "zh-CN" ? "未打开记录" : "No record open")}</h2>
              <span className="hint">
                {snapshot
                  ? `${snapshot.repoPath} · ${new Date(snapshot.updatedAt).toLocaleString(locale)}`
                  : locale === "zh-CN"
                    ? "从左侧选中一条历史记录"
                    : "Select a record from the archive on the left"}
              </span>
            </div>
            <div className="record-head-actions">
              {snapshot ? (
                <button
                  type="button"
                  onClick={() => void onRerunHistoryJob(snapshot)}
                  disabled={rerunBusyId === snapshot.id}
                >
                  {rerunBusyId === snapshot.id ? ui.analyzing : ui.rerun}
                </button>
              ) : null}
            </div>
          </div>

          {snapshot ? (
            <>
              <div className="record-hero">
                <div className="record-hero-copy">
                  <span className="record-kicker">
                    {analysis ? analysis.repoType.label : ui.historyTitle}
                  </span>
                  <strong>{analysis ? analysis.domain.label : snapshot.currentLabel}</strong>
                  <p>
                    {analysis
                      ? analysis.repoPath
                      : snapshot.error ?? (locale === "zh-CN" ? "这条记录尚未生成完整分析。" : "This record has not materialized a full analysis yet.")}
                  </p>
                </div>
                <div className={`world-status-chip ${snapshot.status}`}>{ui.statusLabels[snapshot.status]}</div>
              </div>

              {historyDelta ? (
                <div className="record-delta-card">
                  <div className="drawer-section-head record-delta-head">
                    <div>
                      <h3>{historyDelta.title}</h3>
                      <span className="hint">{historyDelta.subtitle}</span>
                    </div>
                    <span className="history-delta-flag">
                      {snapshot.revision > 1 ? `r${snapshot.revision}` : "r1"}
                    </span>
                  </div>
                  <p className="record-delta-summary">{historyDelta.summary}</p>
                  <div className="record-delta-grid">
                    {historyDelta.metrics.map((metric) => (
                      <div key={metric.label} className="record-delta-item">
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                        <small>{metric.detail}</small>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {analysis ? (
                <>
                  <div className="report-view-switch compact record-switch" role="tablist" aria-label={ui.reportViewTitle}>
                    {(Object.keys(ui.reportViews) as ReportView[]).map((view) => (
                      <button
                        key={view}
                        type="button"
                        role="tab"
                        aria-selected={reportView === view}
                        className={reportView === view ? "secondary active" : "secondary"}
                        onClick={() => setReportView(view)}
                      >
                        {ui.reportViews[view]}
                      </button>
                    ))}
                  </div>
                  <article className="report-content record-content" dangerouslySetInnerHTML={{ __html: reportHtml }} />
                </>
              ) : (
                <div className="record-empty-state">
                  <strong>{locale === "zh-CN" ? "该记录还没有完整分析结果" : "This record has no materialized analysis yet"}</strong>
                  <p>
                    {locale === "zh-CN"
                      ? "你仍然可以查看它的时间线、状态和重新运行操作。"
                      : "You can still inspect its timeline, status, and rerun actions."}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="record-empty-state">
              <strong>{locale === "zh-CN" ? "打开一条历史记录" : "Open a history record"}</strong>
              <p>
                {locale === "zh-CN"
                  ? "中间区域会显示记录摘要、报告正文和修订信息。"
                  : "The center panel will show the record summary, report body, and revision info."}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="history-column history-side-column">
        <div className="panel history-side-panel">
          <div className="panel-head">
            <div>
              <h2>{locale === "zh-CN" ? "时间线" : "Timeline"}</h2>
              <span className="hint">
                {snapshot ? snapshot.currentLabel : locale === "zh-CN" ? "当前未选中记录" : "No record selected"}
              </span>
            </div>
          </div>

          {snapshot ? (
            <div className="record-side-strip">
              <span className="workspace-pill">{ui.statusLabels[snapshot.status]}</span>
              <span className="workspace-pill">{snapshot.revision > 1 ? `${ui.revisionLabel} ${snapshot.revision}` : ui.originalRun}</span>
              <span className="workspace-pill">{runtimeStageLabel(snapshot.currentStage, ui)}</span>
            </div>
          ) : null}

          <div className="record-timeline history-timeline">
            {timeline.length > 0 ? (
              visibleTimeline.map((step) => (
                <button
                  key={step.stage}
                  type="button"
                  className={`timeline-dock-card timeline-step-button ${stageTone(step.status)}${step.stage === snapshot?.currentStage ? " current" : ""}${step.stage === selectedTimelineStage ? " selected" : ""}`}
                  onClick={() => setSelectedTimelineStage(step.stage)}
                  aria-pressed={step.stage === selectedTimelineStage}
                >
                  <small>
                    {step.startedAt
                      ? new Date(step.startedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
                      : "..."}
                  </small>
                  <strong>{runtimeStageLabel(step.stage, ui)}</strong>
                  <p>{step.message ?? step.label}</p>
                  <span>{runtimeStatusLabel(step.status, locale)}</span>
                </button>
              ))
            ) : (
              <div className="history-empty">
                {locale === "zh-CN" ? "打开记录后，这里会显示执行时间线。" : "The execution timeline appears here after opening a record."}
              </div>
            )}
          </div>

          {selectedTimelineStep ? (
            <div className="timeline-drilldown-card">
              <div className="drawer-section-head timeline-drilldown-head">
                <div>
                  <h3>{runtimeStageLabel(selectedTimelineStep.stage, ui)}</h3>
                  <span className="hint">{selectedTimelineStep.label}</span>
                </div>
                <span className={`status-pill ${selectedTimelineStep.status}`}>{runtimeStatusLabel(selectedTimelineStep.status, locale)}</span>
              </div>
              <div className="timeline-drilldown-grid">
                <div>
                  <span>{locale === "zh-CN" ? "开始" : "Started"}</span>
                  <strong>
                    {selectedTimelineStep.startedAt
                      ? new Date(selectedTimelineStep.startedAt).toLocaleString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>{locale === "zh-CN" ? "结束" : "Ended"}</span>
                  <strong>
                    {selectedTimelineStep.endedAt
                      ? new Date(selectedTimelineStep.endedAt).toLocaleString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                      : selectedTimelineStep.status === "running"
                        ? locale === "zh-CN"
                          ? "进行中"
                          : "In progress"
                        : "—"}
                  </strong>
                </div>
                <div>
                  <span>{locale === "zh-CN" ? "耗时" : "Duration"}</span>
                  <strong>{formatTimelineDuration(selectedTimelineStep.startedAt, selectedTimelineStep.endedAt)}</strong>
                </div>
              </div>
              <p className="timeline-drilldown-message">
                {selectedTimelineStep.message ?? (locale === "zh-CN" ? "这一步没有额外说明。" : "No extra note was recorded for this step.")}
              </p>
            </div>
          ) : null}

          {timeline.length > 3 ? (
            <button type="button" className="secondary history-timeline-toggle" onClick={() => setTimelineExpanded((current) => !current)}>
              {timelineExpanded
                ? locale === "zh-CN"
                  ? "收起时间线"
                  : "Collapse timeline"
                : locale === "zh-CN"
                  ? `展开全部 ${timeline.length} 步`
                  : `Show all ${timeline.length} steps`}
            </button>
          ) : null}

          {snapshot ? (
            <div className="record-actions-card">
              <div className="drawer-section-head">
                <h3>{locale === "zh-CN" ? "记录操作" : "Record actions"}</h3>
                <span className="hint">{ui.statusLabels[snapshot.status]}</span>
              </div>
              <div className="actions record-actions-grid">
                <button type="button" onClick={() => void onRerunJob(snapshot)} disabled={rerunBusyId === snapshot.id}>
                  {rerunBusyId === snapshot.id ? ui.analyzing : ui.rerun}
                </button>
                <button type="button" className="secondary" onClick={() => downloadAnalysisJson(snapshot.id, "combined", locale)} disabled={!snapshot.analysis}>
                  {ui.exportJson}
                </button>
                <button type="button" className="secondary" onClick={() => downloadMarkdown(snapshot.id, "combined", snapshot.locale)} disabled={!snapshot.analysis}>
                  {ui.exportMarkdown}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void onDeleteJob(snapshot)}
                  disabled={deleteBusyId === snapshot.id || snapshot.status === "queued" || snapshot.status === "running"}
                >
                  {deleteBusyId === snapshot.id ? ui.analyzing : locale === "zh-CN" ? "删除" : "Delete"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

  function attachJobStream(job: JobSnapshot): void {
    eventSourceRef.current?.close();
    eventSourceRef.current = connectJobStream(
      job.id,
      (next) => {
        setSnapshot(next);
        if (next.status === "completed" || next.status === "failed") {
          setBusy(false);
          setRerunBusyId(null);
          if (next.status === "failed") {
            setError(ui.errors.analysisFailed);
          }
        }
        if (next.status === "completed" || next.status === "failed") {
          void refreshHistory();
        }
      },
      (status) => {
        if (status === "failed") {
          setError(ui.errors.analysisFailed);
        }
        setBusy(false);
        setRerunBusyId(null);
        void refreshHistory();
      }
    );
  }

  async function openHistoryJob(job: JobSnapshot): Promise<void> {
    setError(null);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setBusy(false);
    setRerunBusyId(null);
    setWorkspaceOpen(false);
    setSurfaceMode("history");
    setViewMode("world");
    setFocusId(null);
    setSnapshot(job);
    if (job.analysis) {
      setReportView("combined");
    }
    await refreshHistory();
  }

  async function persistProviderConfig(): Promise<void> {
    setProviderBanner(null);
    setProviderBusy(true);
    try {
      const saved = await saveProviderConfig(providerConfig);
      setProviderConfig(saved.config);
      setProviderBanner({ tone: "success", text: saved.message || ui.configSaved });
    } catch (saveError) {
      setProviderBanner({ tone: "error", text: saveError instanceof Error ? saveError.message : ui.errors.network });
    } finally {
      setProviderBusy(false);
    }
  }

  async function checkProviderConfig(): Promise<void> {
    setProviderBanner(null);
    setProviderBusy(true);
    try {
      const result = await testProviderConfig(providerConfig);
      setProviderTest(result);
      setProviderBanner({
        tone: result.ok ? (result.selectedModelFound || !result.model.trim() ? "success" : "warning") : "error",
        text: result.ok
          ? result.selectedModelFound || !result.model.trim()
            ? ui.testOk
            : `${ui.testOk}: ${result.message}`
          : `${ui.testFail}: ${result.message}`
      });
      if (result.ok && result.availableModels.length > 0 && !providerConfig.model.trim()) {
        setProviderConfig((current) => ({ ...current, model: result.availableModels[0] }));
      }
    } catch (testError) {
      setProviderTest(null);
      setProviderBanner({ tone: "error", text: testError instanceof Error ? testError.message : ui.errors.network });
    } finally {
      setProviderBusy(false);
    }
  }

  async function startAnalysis(): Promise<void> {
    setError(null);
    setBusy(true);
    setRerunBusyId(null);
    setWorkspaceOpen(false);
    setSurfaceMode("workspace");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setSnapshot(null);
    setFocusId(null);
    setReportView("combined");
    setReportHtml("");
    try {
      const job = await createJob(repoPath.trim(), locale);
      setSnapshot(job);
      if (job.status === "completed" || job.status === "failed") {
        setBusy(false);
        if (job.status === "failed") {
          setError(ui.errors.analysisFailed);
        }
      } else {
        attachJobStream(job);
      }
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : ui.errors.startFailed);
      setBusy(false);
    }
  }

  async function rerunSelectedJob(job: JobSnapshot): Promise<void> {
    setError(null);
    setBusy(true);
    setRerunBusyId(job.id);
    setWorkspaceOpen(false);
    try {
      const nextJob = await rerunJob(job.id, locale);
      setSnapshot(nextJob);
      setFocusId(null);
      setReportView("combined");
      if (nextJob.status === "completed" || nextJob.status === "failed") {
        setBusy(false);
        setRerunBusyId(null);
        if (nextJob.status === "failed") {
          setError(ui.errors.analysisFailed);
        }
      } else {
        attachJobStream(nextJob);
      }
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : ui.errors.startFailed);
      setBusy(false);
      setRerunBusyId(null);
    }
  }

  async function rerunHistorySelectedJob(job: JobSnapshot): Promise<void> {
    setError(null);
    setBusy(true);
    setRerunBusyId(job.id);
    setWorkspaceOpen(false);
    setSurfaceMode("history");
    try {
      const nextJob = await rerunJob(job.id, locale);
      setSnapshot(nextJob);
      setFocusId(null);
      setReportView("combined");
      if (nextJob.status === "completed" || nextJob.status === "failed") {
        setBusy(false);
        setRerunBusyId(null);
        if (nextJob.status === "failed") {
          setError(ui.errors.analysisFailed);
        }
      } else {
        attachJobStream(nextJob);
      }
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : ui.errors.startFailed);
      setBusy(false);
      setRerunBusyId(null);
    }
  }

  async function deleteSelectedJob(job: JobSnapshot): Promise<void> {
    const confirmMessage =
      locale === "zh-CN"
        ? `确定删除记录「${job.repoName}」吗？删除后无法恢复。`
        : `Delete record "${job.repoName}"? This cannot be undone.`;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    setError(null);
    setDeleteBusyId(job.id);
    try {
      await deleteJob(job.id, locale);
      if (snapshot?.id === job.id) {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        setSnapshot(null);
        setReportView("combined");
        setFocusId(null);
        setSurfaceMode("workspace");
        setViewMode("world");
      }
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : ui.errors.network);
    } finally {
      setDeleteBusyId(null);
    }
  }

  return (
    <div className="app-shell">
      <div className="backdrop backdrop-a" />
      <div className="backdrop backdrop-b" />
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-mark topbar-mark">
            <span className="brand-orb" />
          </span>
          <div className="topbar-brand-copy">
            <strong>Intelligence-Coder</strong>
            <span>{ui.appTagline}</span>
          </div>
        </div>
        <nav className="topbar-tabs" aria-label={locale === "zh-CN" ? "主导航" : "Primary navigation"}>
          {shellTabs.map((tab) => (
            <button key={tab.key} type="button" className={tab.active ? "secondary active" : "secondary"} onClick={tab.onClick}>
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <button type="button" className="secondary topbar-action" onClick={() => setWorkspaceOpen((current) => !current)}>
            {workspaceOpen ? (locale === "zh-CN" ? "收起侧栏" : "Hide sidebar") : (locale === "zh-CN" ? "打开侧栏" : "Open sidebar")}
          </button>
          <button type="button" className="topbar-action" onClick={startAnalysis} disabled={busy || repoPath.trim().length === 0}>
            {busy ? ui.analyzing : ui.startAnalysis}
          </button>
        </div>
      </header>

      {(showWelcome && !workspaceOpen) ? null : (
      <section className={`workspace-strip ${runtimeActive ? "active" : ""}`} aria-label={locale === "zh-CN" ? "工作台上下文" : "Workspace context"}>
        <div className="workspace-shell-copy">
          <span className="workspace-shell-title">
            {historySurface && snapshot
              ? locale === "zh-CN"
                ? "打开的记录"
                : "Opened record"
              : locale === "zh-CN"
                ? "工作区"
                : "Workspace"}
          </span>
          <div className="workspace-shell-meta">
            {historySurface && snapshot ? (
              <>
                <span className="workspace-pill">{snapshot.repoName}</span>
                <span className="workspace-pill">{ui.statusLabels[snapshot.status]}</span>
                <span className="workspace-pill">{snapshot.revision > 1 ? `${ui.revisionLabel} ${snapshot.revision}` : ui.originalRun}</span>
                <span className="workspace-pill">
                  {new Date(snapshot.updatedAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </>
            ) : runtimeActive ? (
              <>
                <span className="workspace-pill">{snapshot?.repoName ?? (repoPath.trim() || "—")}</span>
                <span className="workspace-pill">{snapshot ? ui.statusLabels[snapshot.status] : ui.statusLabels.queued}</span>
                <span className="workspace-pill">{snapshot?.currentStage ? snapshot.currentStage : ui.statusLabels.queued}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="workspace-actions">
          {historySurface && snapshot ? (
            <button type="button" className="secondary" onClick={() => setSurfaceMode("workspace")}>
              {locale === "zh-CN" ? "返回工作区" : "Back to workspace"}
            </button>
          ) : workspaceAnalysis ? (
            <div className="workspace-mode-toggle">
              <button
                type="button"
                className={`secondary workspace-mode-button ${viewMode === "world" ? "active" : ""}`}
                onClick={() => setViewMode("world")}
              >
                {locale === "zh-CN" ? "图谱" : "Graph"}
              </button>
              <button
                type="button"
                className={`secondary workspace-mode-button ${viewMode === "report" ? "active" : ""}`}
                onClick={() => setViewMode("report")}
              >
                {locale === "zh-CN" ? "报告" : "Report"}
              </button>
            </div>
          ) : null}
        </div>
      </section>
      )}

      {workspaceOpen ? (
        <aside className="workspace-drawer">
          <div className="panel drawer-panel">
            <div className="panel-head">
              <h2>{locale === "zh-CN" ? "工作台上下文" : "Workspace Context"}</h2>
              <button type="button" className="secondary" onClick={() => setWorkspaceOpen(false)}>
                {locale === "zh-CN" ? "收起" : "Close"}
              </button>
            </div>

            <div className="drawer-sections">
              <div className="drawer-section">
                <div className="drawer-section-head">
                  <h3>{ui.modelConfigTitle}</h3>
                  <span className="hint">{ui.endpoint}</span>
                </div>
                <div className="field">
                  <span>{ui.configPath}</span>
                </div>
                <div className="field">
                  <span>{ui.provider}</span>
                  <select
                    value={providerConfig.provider}
                    onChange={(event) => {
                      const provider = event.target.value as ProviderConfig["provider"];
                      setProviderConfig((current) => ({
                        ...current,
                        provider,
                        baseUrl:
                          current.baseUrl.trim().length === 0 ||
                          current.baseUrl === "https://api.openai.com/v1" ||
                          current.baseUrl === "https://api.anthropic.com/v1"
                            ? defaultProviderBaseUrl(provider)
                            : current.baseUrl,
                        updatedAt: current.updatedAt
                      }));
                      setProviderTest(null);
                    }}
                    aria-label={ui.provider}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </div>
                <label className="field">
                  <span>{ui.apiKey}</span>
                  <input
                    type="password"
                    value={providerConfig.apiKey}
                    onChange={(event) => {
                      setProviderConfig((current) => ({ ...current, apiKey: event.target.value }));
                      setProviderTest(null);
                    }}
                    placeholder="sk-..."
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>{ui.model}</span>
                  <input
                    value={providerConfig.model}
                    onChange={(event) => {
                      setProviderConfig((current) => ({ ...current, model: event.target.value }));
                      setProviderTest(null);
                    }}
                    placeholder={providerConfig.provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4.1-mini"}
                    spellCheck={false}
                  />
                </label>
                <div className="field">
                  <span>{ui.baseUrlLabel}</span>
                  <input
                    value={providerConfig.baseUrl}
                    onChange={(event) => {
                      setProviderConfig((current) => ({ ...current, baseUrl: event.target.value }));
                      setProviderTest(null);
                    }}
                    placeholder={providerEndpoint}
                    spellCheck={false}
                  />
                </div>
                <div className="actions">
                  <button type="button" onClick={() => void persistProviderConfig()} disabled={providerBusy}>
                    {providerBusy ? ui.analyzing : ui.saveConfig}
                  </button>
                  <button type="button" className="secondary" onClick={() => void checkProviderConfig()} disabled={providerBusy}>
                    {providerBusy ? ui.analyzing : ui.testConnection}
                  </button>
                </div>
                {providerBanner ? <div className={`notice-banner ${providerBanner.tone}`}>{providerBanner.text}</div> : null}
                {providerTest ? (
                  <div className="provider-test">
                    <div className="mini-grid compact">
                      <div className="mini-block">
                        <h3>{ui.provider}</h3>
                        <ul>
                          <li>
                            <strong>{providerTest.provider}</strong>
                            <span>{providerTest.endpoint}</span>
                          </li>
                        </ul>
                      </div>
                      <div className="mini-block">
                        <h3>{ui.selectedModel}</h3>
                        <ul>
                          <li>
                            <strong>{providerTest.model || providerConfig.model || "—"}</strong>
                            <span>{providerTest.selectedModelFound ? ui.testOk : ui.testFail}</span>
                          </li>
                        </ul>
                      </div>
                    </div>
                    {providerTest.availableModels.length > 0 ? (
                      <div className="provider-models">
                        <span className="hint">{ui.loadModels}</span>
                        <div className="model-tags">
                          {providerTest.availableModels.slice(0, 8).map((model) => (
                            <span key={model} className="model-tag">
                              {model}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="drawer-section">
                <div className="drawer-section-head">
                  <h3>{ui.repoPathTitle}</h3>
                  <span className="hint">{ui.localOnly}</span>
                </div>
                <div className="field">
                  <span>{ui.localeLabel}</span>
                  <select
                    value={locale}
                    onChange={(event) => setLocale(event.target.value as LocaleCode)}
                    aria-label={ui.localeLabel}
                  >
                    <option value="en">{ui.localeOptions.en}</option>
                    <option value="zh-CN">{ui.localeOptions["zh-CN"]}</option>
                  </select>
                </div>
                <label className="field">
                  <span>{ui.repoPathLabel}</span>
                  <input
                    value={repoPath}
                    onChange={(event) => setRepoPath(event.target.value)}
                    placeholder="C:\\Projects\\my-repo"
                    spellCheck={false}
                  />
                </label>
                <div className="actions">
                  <button type="button" onClick={startAnalysis} disabled={busy || repoPath.trim().length === 0}>
                    {busy ? ui.analyzing : ui.startAnalysis}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => snapshot?.id && void downloadMarkdown(snapshot.id, reportView, snapshot.locale)}
                    disabled={!snapshot?.analysis?.reportMarkdown}
                  >
                    {ui.downloadMarkdown}
                  </button>
                </div>
                {error ? <div className="error-banner">{error}</div> : null}
              </div>

              <div ref={knowledgeSectionRef} className="drawer-section knowledge-section">
                <div className="drawer-section-head">
                  <h3>{locale === "zh-CN" ? "知识库" : "Knowledge base"}</h3>
                  <span className="hint">
                    {workspaceAnalysis
                      ? locale === "zh-CN"
                        ? `${workspaceAnalysis.signals.length} 条信号 · ${workspaceAnalysis.evidence.length} 条证据`
                        : `${workspaceAnalysis.signals.length} signals · ${workspaceAnalysis.evidence.length} evidence items`
                      : locale === "zh-CN"
                        ? "先打开一条记录再看知识库"
                        : "Open a record to inspect its knowledge base"}
                  </span>
                </div>
                {workspaceAnalysis ? (
                  <div className="knowledge-browser">
                    <div className="knowledge-summary-grid">
                      <div className="knowledge-summary-card">
                        <span>{locale === "zh-CN" ? "世界类型" : "World type"}</span>
                        <strong>{workspaceAnalysis.repoType.label}</strong>
                        <small>{formatPercent(workspaceAnalysis.repoType.confidence)}</small>
                      </div>
                      <div className="knowledge-summary-card">
                        <span>{locale === "zh-CN" ? "业务域" : "Domain"}</span>
                        <strong>{workspaceAnalysis.domain.label}</strong>
                        <small>{formatPercent(workspaceAnalysis.domain.confidence)}</small>
                      </div>
                      <div className="knowledge-summary-card">
                        <span>{locale === "zh-CN" ? "缓存" : "Cache"}</span>
                        <strong>{workspaceAnalysis.cacheHit ? ui.cacheHit : ui.cacheMiss}</strong>
                        <small>
                          {workspaceAnalysis.fileCacheHits}/{workspaceAnalysis.fileCacheMisses} {ui.summaryDetail.cacheHits}/{ui.summaryDetail.cacheMisses}
                        </small>
                      </div>
                    </div>
                    <div className="knowledge-lists">
                      <div className="knowledge-block">
                        <h4>{locale === "zh-CN" ? "信号" : "Signals"}</h4>
                        <div className="knowledge-tags">
                          {workspaceAnalysis.signals.slice(0, 6).map((signal) => (
                            <span key={`${signal.label}-${signal.value}`} className="knowledge-tag">
                              {signal.label} · {signal.value}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="knowledge-block">
                        <h4>{locale === "zh-CN" ? "模块" : "Modules"}</h4>
                        <div className="knowledge-tags">
                          {workspaceAnalysis.modules.slice(0, 6).map((module) => (
                            <span key={module.module} className="knowledge-tag">
                              {module.module}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="knowledge-block">
                        <h4>{locale === "zh-CN" ? "证据" : "Evidence"}</h4>
                        <div className="knowledge-tags">
                          {workspaceAnalysis.evidence.slice(0, 6).map((item) => (
                            <span key={item.claim} className="knowledge-tag">
                              {item.claim}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="history-empty">
                    {locale === "zh-CN"
                      ? "这里会汇总当前仓库的信号、模块和证据。"
                      : "This area will summarize the current repository's signals, modules, and evidence."}
                  </div>
                )}
              </div>

              <div className="drawer-section">
                <div className="drawer-section-head">
                  <h3>{ui.historyTitle}</h3>
                  <span className="hint">
                    {historyBusy
                      ? ui.loadingHistory
                      : locale === "zh-CN"
                        ? `最近 ${historyJobs.length} 条记录`
                        : `Latest ${historyJobs.length} records`}
                  </span>
                </div>
                <div className="history-list">
                  {historyJobs.length > 0 ? (
                    historyJobs.map((job) => (
                      <div key={job.id} className={`history-item ${snapshot?.id === job.id ? "active" : ""}`}>
                        <button type="button" className="history-main" onClick={() => void openHistoryJob(job)}>
                          <strong>{job.repoName}</strong>
                          <span>
                            {ui.statusLabels[job.status]} · {new Date(job.updatedAt).toLocaleString(locale)}
                          </span>
                          <small>
                            {job.revision > 1 ? `${ui.revisionLabel} ${job.revision}` : ui.originalRun}
                            {job.sourceJobId ? ` · ${ui.derivedFrom} ${job.sourceJobId.slice(0, 8)}` : ""}
                          </small>
                        </button>
                        <div className="history-actions">
                          <button
                            type="button"
                            className="secondary history-rerun"
                            onClick={() => void rerunSelectedJob(job)}
                            disabled={rerunBusyId === job.id}
                          >
                            {rerunBusyId === job.id ? ui.analyzing : ui.rerun}
                          </button>
                          <button
                            type="button"
                            className="secondary history-export-json"
                            onClick={() => void downloadAnalysisJson(job.id, "combined", locale)}
                            disabled={!job.analysis}
                          >
                            {ui.exportJson}
                          </button>
                          <button
                            type="button"
                            className="secondary history-export-md"
                            onClick={() => void downloadMarkdown(job.id, "combined", job.locale)}
                            disabled={!job.analysis}
                          >
                            {ui.exportMarkdown}
                          </button>
                          <button
                            type="button"
                            className="secondary history-delete"
                            onClick={() => void deleteSelectedJob(job)}
                            disabled={deleteBusyId === job.id || job.status === "queued" || job.status === "running"}
                          >
                            {deleteBusyId === job.id ? ui.analyzing : locale === "zh-CN" ? "删除" : "Delete"}
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="history-empty">{ui.historyEmpty}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>
      ) : null}

      {showWelcome ? (
        <main className="welcome-view" role="main">
          <div className="welcome-card">
            <div className="welcome-brand">
              <span className="brand-mark" style={{ width: 48, height: 48, borderRadius: 8, background: "var(--accent-subtle)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <span className="brand-orb" style={{ width: 16, height: 16 }} />
              </span>
              <div>
                <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: "1.5rem", letterSpacing: "-0.02em" }}>Intelligence-Coder</h1>
                <p className="hint" style={{ marginTop: 4 }}>{locale === "zh-CN" ? "仓库业务分析工具" : "Repository business intelligence"}</p>
              </div>
            </div>
            <p className="welcome-description">
              {locale === "zh-CN"
                ? "提交一个代码仓库，AI 会自动分析它的业务领域、核心实体、数据流和业务规则，生成结构化认知报告。"
                : "Analyze any codebase to uncover its business domain, core entities, data flows, and business rules — delivered as a structured cognition graph and report."}
            </p>
            <div className="welcome-actions">
              <button type="button" onClick={() => { setWorkspaceOpen(true); setWorkspaceFocus("config"); }}>
                {locale === "zh-CN" ? "开始分析" : "Start analysis"}
              </button>
              <button type="button" className="secondary" onClick={() => { setSurfaceMode("history"); setWorkspaceOpen(false); }}>
                {locale === "zh-CN" ? "查看历史记录" : "View history"}
              </button>
            </div>
            {historyJobs.length > 0 ? (
              <div className="welcome-recent">
                <div className="nav-section-head">
                  <h3>{locale === "zh-CN" ? "最近记录" : "Recent analyses"}</h3>
                </div>
                <div className="welcome-recent-list">
                  {historyJobs.slice(0, 4).map((job) => (
                    <button key={job.id} type="button" className="welcome-recent-item" onClick={() => void openHistoryJob(job)}>
                      <strong>{job.repoName}</strong>
                      <span>{ui.statusLabels[job.status]} · {new Date(job.updatedAt).toLocaleDateString(locale)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </main>
      ) : historySurface ? (
        <HistoryRecordLayout
          snapshot={snapshot}
          historyJobs={visibleHistoryJobs}
          reportHtml={reportHtml}
          reportView={reportView}
          setReportView={setReportView}
          onOpenJob={(job) => void openHistoryJob(job)}
          onReturnToWorkspace={() => {
            setSurfaceMode("workspace");
            setWorkspaceOpen(false);
          }}
          onRerunHistoryJob={(job) => rerunHistorySelectedJob(job)}
          onDeleteJob={(job) => deleteSelectedJob(job)}
          rerunBusyId={rerunBusyId}
          deleteBusyId={deleteBusyId}
          historyQuery={historyQuery}
          setHistoryQuery={setHistoryQuery}
          historyStatusFilter={historyStatusFilter}
          setHistoryStatusFilter={setHistoryStatusFilter}
          locale={locale}
          ui={ui}
        />
      ) : viewMode === "report" && workspaceAnalysis ? (
        <main className="world-layout report-mode">
          <section className="report-column">
            <div className="panel report-panel">
              <div className="panel-head">
                <div>
                  <h2>{focusNode?.label ?? ui.reportTitle}</h2>
                  <span className="hint">{workspaceAnalysis.repoName}</span>
                </div>
                <div className="report-view-switch compact" role="tablist" aria-label={ui.reportViewTitle}>
                  {(Object.keys(ui.reportViews) as ReportView[]).map((view) => (
                    <button
                      key={view}
                      type="button"
                      role="tab"
                      aria-selected={reportView === view}
                      className={reportView === view ? "secondary active" : "secondary"}
                      onClick={() => setReportView(view)}
                    >
                      {ui.reportViews[view]}
                    </button>
                  ))}
                </div>
              </div>
              <article className="report-content" dangerouslySetInnerHTML={{ __html: reportHtml }} />
            </div>
          </section>
        </main>
      ) : (
        <main className={`world-layout canvas-mode ${worldIndexOpen ? "index-open" : ""} ${evidenceOpen ? "evidence-open" : ""} ${timelineOpen ? "timeline-open" : ""}`}>
          <div className="canvas-floating-actions" aria-label={locale === "zh-CN" ? "图谱辅助工具" : "Graph tools"}>
            <button type="button" className={worldIndexOpen ? "secondary active" : "secondary"} onClick={() => setWorldIndexOpen((current) => !current)}>
              {locale === "zh-CN" ? "索引" : "Index"}
            </button>
            <button type="button" className={evidenceOpen ? "secondary active" : "secondary"} onClick={() => setEvidenceOpen((current) => !current)}>
              {locale === "zh-CN" ? "证据" : "Evidence"}
            </button>
            <button type="button" className={timelineOpen ? "secondary active" : "secondary"} onClick={() => setTimelineOpen((current) => !current)}>
              {locale === "zh-CN" ? "时间线" : "Timeline"}
            </button>
          </div>

          <section className="tree-column canvas-index-panel" aria-hidden={!worldIndexOpen}>
            <RuntimeSidebar
              analysis={workspaceAnalysis}
              snapshot={snapshot}
              focusId={focusNode?.id ?? null}
              onFocus={(node) => {
                setFocusId(node.id);
                setEvidenceOpen(true);
              }}
              ui={ui}
              locale={locale}
            />
          </section>

          <section className="runtime-column">
            <RuntimeWorld
              snapshot={snapshot}
              analysis={workspaceAnalysis}
              focus={focusNode}
              timelineOpen={timelineOpen}
              onFocusId={(nodeId) => {
                setFocusId(nodeId);
                if (nodeId) {
                  setEvidenceOpen(true);
                }
              }}
              ui={ui}
              locale={locale}
            />
          </section>

          <section className="evidence-column canvas-evidence-drawer" aria-hidden={!evidenceOpen}>
            <button type="button" className="drawer-close secondary" onClick={() => setEvidenceOpen(false)}>
              {locale === "zh-CN" ? "关闭" : "Close"}
            </button>
            <RuntimeInspector
              analysis={workspaceAnalysis}
              reportHtml={reportHtml}
              reportView={reportView}
              setReportView={setReportView}
              focus={focusNode}
              locale={locale}
              ui={ui}
            />
          </section>
        </main>
      )}
    </div>
  );
}
