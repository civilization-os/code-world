import type {
  EvidenceItem,
  FileInsight,
  ReportSection,
  RepoScanResult,
  RepoTypePrediction,
  RepositoryAnalysis,
  StructuredAnalysis,
  StructuredClaim,
  StructuredSummary
} from "../domain.js";
import type { LocaleCode } from "../i18n.js";

export interface ReportBundle {
  sections: ReportSection[];
  technicalMarkdown: string;
  businessMarkdown: string;
  reportMarkdown: string;
}

export interface ReportBundleInput {
  locale: LocaleCode;
  repoName: string;
  repoPath: string;
  fingerprint: string;
  fileCount: number;
  directoryCount: number;
  scan: RepoScanResult;
  repoType: RepoTypePrediction;
  domain: RepoTypePrediction;
  structuredAnalysis: StructuredAnalysis;
  analysisMode: RepositoryAnalysis["analysisMode"];
  cacheHit: boolean;
  fileCacheHits: number;
  fileCacheMisses: number;
  qaIssues: string[];
  qaPasses: number;
  generatedAt: string;
  signals: Array<{ label: string; value: string; confidence: number; evidence: string[] }>;
  modules: Array<{ module: string; role: string; evidence: string[] }>;
  fileInsights: FileInsight[];
}

const NL = "\n";
const DOUBLE_NL = "\n\n";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function bulletList(values: string[], emptyText: string): string {
  const items = values.length > 0 ? values : [emptyText];
  return items.map((value) => `- ${escapeMarkdown(value)}`).join(NL);
}

function renderEvidenceTable(items: EvidenceItem[]): string {
  if (items.length === 0) {
    return "- 暂无证据项。";
  }
  const rows = items.slice(0, 12).map((item) =>
    `| ${escapeMarkdown(item.claim)} | ${pct(item.confidence)} | ${item.files.slice(0, 4).map((f) => `\`${f}\``).join(", ")} |`
  );
  return [
    "| 主张 | 置信度 | 文件 |",
    "| --- | --- | --- |",
    ...rows
  ].join(NL);
}

function renderFileInsights(items: FileInsight[]): string {
  if (items.length === 0) {
    return "- 暂无额外文件洞察。";
  }
  return items
    .slice(0, 10)
    .map((item) => `- \`${item.path}\` — ${escapeMarkdown(item.summary)}`)
    .join(NL);
}

function buildConclusion(input: ReportBundleInput): string {
  const zh = input.locale === "zh-CN";
  const typeLabel = input.structuredAnalysis.repoType.overview || input.repoType.label;
  const domainLabel = input.structuredAnalysis.domain.overview || input.domain.label;
  const typeConf = input.structuredAnalysis.repoType.confidence || input.repoType.confidence;
  const domainConf = input.structuredAnalysis.domain.confidence || input.domain.confidence;
  const techSummary = input.structuredAnalysis.technicalSummary.overview;

  if (typeConf < 0.3 && domainConf < 0.3) {
    return zh
      ? "证据不足以形成可靠结论，以下内容仅供参考。"
      : "Insufficient evidence for a reliable conclusion. The following is for reference only.";
  }

  if (zh) {
    let text = `这是一个 **${input.repoType.label}** 项目`;
    if (typeConf >= 0.3) text += `（置信度 ${pct(typeConf)}）`;
    text += `，业务领域为 **${input.domain.label}**`;
    if (domainConf >= 0.3) text += `（置信度 ${pct(domainConf)}）`;
    text += "。";
    if (techSummary && techSummary.length > 20) {
      text += ` ${techSummary}`;
    }
    return text;
  }

  let text = `This is a **${input.repoType.label}** project`;
  if (typeConf >= 0.3) text += ` (${pct(typeConf)} confidence)`;
  text += ` in the **${input.domain.label}** domain`;
  if (domainConf >= 0.3) text += ` (${pct(domainConf)} confidence)`;
  text += ".";
  if (techSummary && techSummary.length > 20) {
    text += ` ${techSummary}`;
  }
  return text;
}

function buildTechnicalMarkdown(input: ReportBundleInput): string {
  const zh = input.locale === "zh-CN";
  const structured = input.structuredAnalysis;

  const pages = [
    `# ${input.repoName} · ${zh ? "仓库业务还原报告" : "Repository Analysis Report"}`,
    `> ${zh ? "生成时间" : "Generated at"}: ${input.generatedAt}`,
    "",
    "## " + (zh ? "一句话结论" : "Summary"),
    buildConclusion(input),
    "",
    "## " + (zh ? "项目概览" : "Overview"),
    `- ${zh ? "仓库类型" : "Type"}: **${input.repoType.label}** (${pct(input.repoType.confidence)})`,
    `- ${zh ? "业务领域" : "Domain"}: **${input.domain.label}** (${pct(input.domain.confidence)})`,
    `- ${zh ? "文件" : "Files"}: ${input.fileCount} ${zh ? "个文件" : "files"}, ${input.directoryCount} ${zh ? "个目录" : "directories"}`,
  ];

  if (input.scan.entrypoints.length > 0) {
    pages.push(`- ${zh ? "入口" : "Entrypoints"}: ${input.scan.entrypoints.slice(0, 4).map((f) => `\`${f}\``).join(", ")}`);
  }

  if (input.signals.length > 0) {
    const techSignals = input.signals.filter((s) => s.label === "manifest" || s.label === "entrypoints" || s.label === "configuration");
    if (techSignals.length > 0) {
      pages.push(`- ${zh ? "构建信息" : "Build info"}: ${techSignals.map((s) => s.value).join("; ")}`);
    }
  }

  // 核心业务对象
  const confirmedEntities = structured.entities.filter((item) => item.status !== "unconfirmed");
  if (confirmedEntities.length > 0) {
    pages.push(
      "",
      "## " + (zh ? "核心业务对象" : "Business Objects"),
      ...confirmedEntities.map((e) => {
        const files = e.evidenceFiles.length > 0 ? ` (${e.evidenceFiles.slice(0, 3).map((f) => `\`${f}\``).join(", ")})` : "";
        return `- **${escapeMarkdown(e.title)}**${files} — ${escapeMarkdown(e.description)}`;
      })
    );
  }

  // 主流程
  const confirmedFlows = structured.flows.filter((item) => item.status !== "unconfirmed");
  if (confirmedFlows.length > 0) {
    pages.push(
      "",
      "## " + (zh ? "主要流程" : "Main Flows"),
      ...confirmedFlows.map((f, i) => {
        const files = f.evidenceFiles.length > 0 ? ` (${f.evidenceFiles.slice(0, 3).map((fn) => `\`${fn}\``).join(", ")})` : "";
        return `${i + 1}. **${escapeMarkdown(f.title)}**${files} — ${escapeMarkdown(f.description)}`;
      })
    );
  }

  // 模块与职责
  if (input.modules.length > 0) {
    pages.push(
      "",
      "## " + (zh ? "模块与职责" : "Modules"),
      ...input.modules.slice(0, 12).map((m) => {
        const files = m.evidence.length > 0 ? ` (${m.evidence.slice(0, 2).map((f) => `\`${f}\``).join(", ")})` : "";
        return `- \`${escapeMarkdown(m.module)}\` — ${escapeMarkdown(m.role)}${files}`;
      })
    );
  }

  // 规则约束
  const confirmedRules = structured.rules.filter((item) => item.status !== "unconfirmed");
  if (confirmedRules.length > 0) {
    pages.push(
      "",
      "## " + (zh ? "规则约束" : "Rules"),
      ...confirmedRules.map((r) => `- ${escapeMarkdown(r.title)}`)
    );
  }

  // 未知与风险
  const hasUnknowns = structured.unknowns.length > 0 || input.qaIssues.length > 0;
  const hasRisks = structured.risks.some((r) => r.status !== "unconfirmed");
  if (hasUnknowns || hasRisks) {
    pages.push("", "## " + (zh ? "未知与风险" : "Risks & Unknowns"));
    if (hasRisks) {
      structured.risks.filter((r) => r.status !== "unconfirmed").forEach((r) => {
        pages.push(`- **${escapeMarkdown(r.title)}**: ${escapeMarkdown(r.description)}`);
      });
    }
    const allUnknowns = [...structured.unknowns, ...input.qaIssues];
    if (allUnknowns.length > 0) {
      allUnknowns.slice(0, 5).forEach((u) => pages.push(`- ${escapeMarkdown(u)}`));
    }
  }

  // 建议动作
  if (structured.recommendations.length > 0) {
    pages.push(
      "",
      "## " + (zh ? "建议动作" : "Recommendations"),
      ...structured.recommendations.map((r) => `- ${escapeMarkdown(r)}`)
    );
  }

  // 附录
  pages.push(
    "",
    "---",
    "## " + (zh ? "附录：证据详情" : "Appendix: Evidence"),
    renderEvidenceTable(structured.evidenceItems),
    "",
    "### " + (zh ? "文件洞察" : "File Insights"),
    renderFileInsights(input.fileInsights)
  );

  return pages.join(DOUBLE_NL);
}

function buildBusinessMarkdown(input: ReportBundleInput): string {
  const zh = input.locale === "zh-CN";
  const structured = input.structuredAnalysis;

  const pages = [
    `# ${input.repoName} · ${zh ? "业务摘要" : "Business Summary"}`,
    "",
    "## " + (zh ? "一句话总结" : "Summary"),
    buildConclusion(input),
  ];

  // 业务价值
  if (structured.businessSummary.status !== "unconfirmed") {
    pages.push(
      "",
      "## " + (zh ? "业务价值" : "Business Value"),
      bulletList(
        structured.businessSummary.bullets.length > 0
          ? structured.businessSummary.bullets
          : [structured.businessSummary.overview],
        zh ? "暂无业务价值说明。" : "No business value information."
      )
    );
  }

  // 核心能力（已确认的流程）
  const confirmedFlows = structured.flows.filter((item) => item.status !== "unconfirmed");
  if (confirmedFlows.length > 0) {
    pages.push(
      "",
      "## " + (zh ? "核心能力" : "Capabilities"),
      ...confirmedFlows.map((f) => `- **${escapeMarkdown(f.title)}** — ${escapeMarkdown(f.description)}`)
    );
  }

  // 建议动作
  if (structured.recommendations.length > 0) {
    pages.push(
      "",
      "## " + (zh ? "建议动作" : "Recommendations"),
      ...structured.recommendations.map((r) => `- ${escapeMarkdown(r)}`)
    );
  }

  // 风险
  const activeRisks = structured.risks.filter((r) => r.status !== "unconfirmed");
  if (activeRisks.length > 0 || structured.unknowns.length > 0) {
    pages.push("", "## " + (zh ? "风险" : "Risks"));
    activeRisks.forEach((r) => pages.push(`- **${escapeMarkdown(r.title)}**: ${escapeMarkdown(r.description)}`));
    structured.unknowns.slice(0, 4).forEach((u) => pages.push(`- ${escapeMarkdown(u)}`));
  }

  // 附录
  pages.push(
    "",
    "---",
    "## " + (zh ? "附录：证据详情" : "Appendix: Evidence"),
    renderEvidenceTable(structured.evidenceItems),
    "",
    "### " + (zh ? "文件洞察" : "File Insights"),
    renderFileInsights(input.fileInsights)
  );

  return pages.join(DOUBLE_NL);
}

export function buildReportBundle(input: ReportBundleInput): ReportBundle {
  const technicalMarkdown = buildTechnicalMarkdown(input);
  const businessMarkdown = buildBusinessMarkdown(input);
  const zh = input.locale === "zh-CN";

  return {
    sections: [
      { id: "technical-conclusion", title: `${zh ? "技术报告" : "Technical Report"}`, markdown: technicalMarkdown },
      { id: "business-summary", title: `${zh ? "业务摘要" : "Business Summary"}`, markdown: businessMarkdown }
    ],
    technicalMarkdown,
    businessMarkdown,
    reportMarkdown: `${technicalMarkdown}${DOUBLE_NL}---${DOUBLE_NL}${businessMarkdown}`
  };
}
