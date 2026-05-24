import type { ProviderConfig } from "../providerConfig.js";
import type { StructuredAnalysis } from "../domain.js";
import type { StructuredEvidencePack } from "./structured.js";

export interface ModelInvocationInput {
  provider: ProviderConfig["provider"];
  apiKey: string;
  baseUrl: string;
  model: string;
  locale: "en" | "zh-CN";
  evidencePack: StructuredEvidencePack;
  baseline: unknown;
}

export interface ModelInvocationResult {
  rawText: string;
  parsed: unknown;
  requestId?: string;
}

// ── Quality Judge ────────────────────────────────────────
export interface QualityJudgeInput {
  locale: "en" | "zh-CN";
  evidencePack: StructuredEvidencePack;
  structuredAnalysis: StructuredAnalysis;
  rewriteAttempts: number;
  maxRewriteAttempts: number;
}

export interface QualityJudgeResult {
  issues: string[];
  needsRewrite: boolean;
  deepDiveTargetFiles: string[];
  overallConfidence: number;
}

// ── Report Generation ────────────────────────────────────
export interface ReportGenerationInput {
  locale: "en" | "zh-CN";
  repoName: string;
  repoPath: string;
  fileCount: number;
  directoryCount: number;
  structuredAnalysis: StructuredAnalysis;
  evidencePack: StructuredEvidencePack;
  fileInsights: Array<{
    path: string;
    category: string;
    summary: string;
    signals: string[];
    evidence: string[];
    confidence: number;
  }>;
  qaIssues: string[];
  generatedAt: string;
}

export interface ReportGenerationResult {
  technicalMarkdown: string;
  businessMarkdown: string;
}

const NL = "\n";

function defaultTimeoutMs(): number {
  const raw = Number(process.env.REPORT_MODEL_TIMEOUT_MS ?? 120000);
  return Number.isFinite(raw) && raw > 0 ? raw : 120000;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function buildSystemPrompt(locale: "en" | "zh-CN"): string {
  const languageRule =
    locale === "zh-CN"
      ? "Write all user-facing summary, entity, flow, rule, risk, and recommendation text in clear Simplified Chinese."
      : "Write all user-facing summary, entity, flow, rule, risk, and recommendation text in English.";

  return [
    "You are a repository analysis engine. Analyze the provided code evidence and return structured JSON.",
    "In the description and rationale fields, write specific, concrete details about what the code does.",
    "Be precise — mention actual function names, API endpoints, data models, or framework patterns you observe.",
    "Every claim must include evidenceFiles, confidence, status, and rationale.",
    "evidenceFiles must only reference file paths that appear in the provided repository payload.",
    "Ignore logs, caches, generated artifacts, screenshots, build output, and runtime traces.",
    "If evidence is weak, set status to provisional rather than making things up.",
    languageRule
  ].join(NL);
}

function buildUserPrompt(input: ModelInvocationInput): string {
  const schemaHint = {
    repoType: {
      headline: "Repository type assessment",
      overview: "One-sentence repository type conclusion.",
      status: "confirmed|provisional|unconfirmed",
      confidence: 0.85,
      evidenceFiles: ["path/to/file.ts"],
      bullets: ["Key supporting signal"]
    },
    domain: {
      headline: "Business domain assessment",
      overview: "One-sentence business/domain conclusion.",
      status: "confirmed|provisional|unconfirmed",
      confidence: 0.8,
      evidenceFiles: ["path/to/file.ts"],
      bullets: ["Domain-specific signal"]
    },
    technicalSummary: {
      headline: "Technical summary",
      overview: "How the repository is organized and where the boundaries are.",
      status: "confirmed|provisional|unconfirmed",
      confidence: 0.8,
      evidenceFiles: ["path/to/file.ts"],
      bullets: ["entrypoints", "configuration", "module boundaries"]
    },
    businessSummary: {
      headline: "Business summary",
      overview: "What the system appears to do and why it exists.",
      status: "confirmed|provisional|unconfirmed",
      confidence: 0.8,
      evidenceFiles: ["path/to/file.ts"],
      bullets: ["business value", "core capability", "remaining risks"]
    },
    entities: [
      {
        title: "User account",
        description: "核心业务对象，对应 User 模型和 userService 中的增删改查操作，涉及 login/session 管理。",
        status: "confirmed",
        confidence: 0.8,
        evidenceFiles: ["src/models/User.ts", "src/services/userService.ts"],
        rationale: "从 model 定义、service 层 CRUD、login 路由中反复出现的 user 相关代码推断。"
      }
    ],
    flows: [
      {
        title: "用户注册",
        description: "用户通过 /api/register 提交信息，service 层校验后写入数据库，返回 token。",
        status: "confirmed",
        confidence: 0.8,
        evidenceFiles: ["src/routes/auth.ts", "src/services/userService.ts"],
        rationale: "路由、校验逻辑、持久化步骤一致指向该流程。"
      }
    ],
    rules: [
      {
        title: "权限校验",
        description: "所有 /api/admin 路由必须携带有效 JWT，并在 middleware 中校验 role 字段。",
        status: "confirmed",
        confidence: 0.75,
        evidenceFiles: ["src/middleware/auth.ts"],
        rationale: "middleware 中的 guard 条件和路由组配置表明该规则。"
      }
    ],
    modules: [
      {
        title: "用户模块",
        description: "负责用户注册、登录、信息管理，包含 model、service、controller 三层。",
        status: "confirmed",
        confidence: 0.75,
        evidenceFiles: ["src/models/User.ts", "src/services/userService.ts", "src/controllers/userController.ts"],
        rationale: "Directory grouping and entrypoint references indicate this responsibility."
      }
    ],
    risks: [
      {
        title: "External dependency risk",
        description: "Use Redis for session storage, if Redis goes down all users are logged out.",
        status: "provisional",
        confidence: 0.6,
        evidenceFiles: ["src/config/redis.ts", "src/services/sessionService.ts"],
        rationale: "Redis config 和 sessionService 中看到了缓存依赖。"
      }
    ],
    evidenceItems: [
      {
        claim: "Main API entrypoint",
        files: ["src/index.ts"],
        confidence: 0.85,
        notes: "Express app 在此启动，挂载了所有路由。"
      }
    ],
    unknowns: ["缺少错误处理中间件，无法确定全局异常是否被妥善捕获"],
    recommendations: ["补充 README 中的 API 文档和本地启动步骤"],
    reportOutline: ["1. 概述", "2. 核心对象", "3. 主流程", "4. 模块架构", "5. 部署运维"],
    qaNotes: ["部分低置信度结论来自单一文件证据，需要更多测试用例验证"]
  };

  const payload = {
    repository: {
      repoName: input.evidencePack.repoName,
      repoPath: input.evidencePack.repoPath,
      fingerprint: input.evidencePack.fingerprint,
      fileCount: input.evidencePack.fileCount,
      directoryCount: input.evidencePack.directoryCount
    },
    locale: input.locale,
    baseline: input.baseline,
    repoType: input.evidencePack.repoType,
    domain: input.evidencePack.domain,
    signals: input.evidencePack.signals,
    manifests: input.evidencePack.manifests,
    configs: input.evidencePack.configs,
    tests: input.evidencePack.tests,
    entrypoints: input.evidencePack.entrypoints,
    docs: input.evidencePack.docs,
    modules: input.evidencePack.modules,
    outline: input.evidencePack.outline,
    deepDiveTargets: input.evidencePack.deepDiveTargets,
    fileInsights: input.evidencePack.fileInsights,
    files: input.evidencePack.files,
    schemaHint
  };

  return [
    "Produce one JSON object that matches the schema shown in schemaHint.",
    "Rules:",
    "1. Keep only evidence-backed items as confirmed.",
    "2. Use provisional or unconfirmed for weakly supported items.",
    "3. Do not invent file paths or entities.",
    "4. Put unresolved gaps into unknowns, risks, or qaNotes.",
    "5. Write specific, concrete descriptions — mention actual code patterns, APIs, or data structures observed.",
    "",
    "Repository payload:",
    JSON.stringify(payload, null, 2)
  ].join(NL);
}

// ── Quality Judge Prompts ───────────────────────────────
function buildQualityJudgeSystemPrompt(locale: "en" | "zh-CN"): string {
  const languageRule =
    locale === "zh-CN"
      ? "Write issues, suggestions, and rationale in clear Simplified Chinese."
      : "Write issues, suggestions, and rationale in English.";
  return [
    "You are a quality assessment judge for repository analysis results.",
    "Evaluate the quality and completeness of a structured analysis based on the available evidence.",
    "Identify:",
    "1. Missing or weak evidence claims — conclusions without sufficient file evidence",
    "2. Coverage gaps — entities, flows, or rules that the analysis may have missed",
    "3. Low-confidence conclusions that need deeper investigation",
    "4. Specific files that should be re-examined to strengthen the analysis",
    "",
    "Output ONLY valid JSON with this exact schema:",
    "{",
    '  "issues": ["string — each issue must be specific and actionable"],',
    '  "needsRewrite": true | false,',
    '  "deepDiveTargetFiles": ["file/paths/to/re-examine"],',
    '  "overallConfidence": 0.0-1.0',
    "}",
    "",
    "Rules:",
    "- deepDiveTargetFiles must be paths that exist in the provided evidence pack files list",
    "- Set needsRewrite to true only if rewriting would meaningfully improve the analysis",
    "- Cap deepDiveTargetFiles at 8 paths maximum",
    "- Be strict: mark issues only when evidence is genuinely insufficient",
    languageRule
  ].join(NL);
}

function buildQualityJudgeUserPrompt(input: QualityJudgeInput): string {
  const filesList = input.evidencePack.files
    .map((f) => `  ${f.relativePath} (${f.category})`)
    .join(NL);
  const fileInsightsSummary = input.evidencePack.fileInsights
    .map((fi) => `  ${fi.path} — ${fi.summary} (confidence: ${fi.confidence})`)
    .join(NL);
  const zh = input.locale === "zh-CN";

  return [
    zh
      ? "请评估以下仓库结构化分析的质量："
      : "Evaluate the quality of the following structured repository analysis:",
    "",
    `Repository: ${input.evidencePack.repoName}`,
    `Type: ${input.evidencePack.repoType.label} (${Math.round(input.evidencePack.repoType.confidence * 100)}%)`,
    `Domain: ${input.evidencePack.domain.label} (${Math.round(input.evidencePack.domain.confidence * 100)}%)`,
    `Files: ${input.evidencePack.fileCount}, Directories: ${input.evidencePack.directoryCount}`,
    `Rewrite attempts: ${input.rewriteAttempts} / ${input.maxRewriteAttempts}`,
    "",
    zh ? "=== 结构化分析 ===" : "=== Structured Analysis ===",
    JSON.stringify(input.structuredAnalysis, null, 2),
    "",
    zh ? "=== 可用证据文件 ===" : "=== Available Evidence Files ===",
    filesList,
    "",
    zh ? "=== 文件洞察摘要 ===" : "=== File Insights Summary ===",
    fileInsightsSummary
  ].join(NL);
}

// ── Report Generation Prompts ──────────────────────────
function buildReportGenSystemPrompt(locale: "en" | "zh-CN"): string {
  if (locale === "zh-CN") {
    return [
      "你是一个技术文档撰写专家。根据仓库结构化分析数据，撰写清晰、连贯的 Markdown 技术文档。",
      "",
      "写作要求：",
      "1. 使用专业的技术文档风格，写成连贯的叙述性文章，不要简单罗列条目",
      "2. 只引用分析数据中明确存在的结论和文件路径",
      "3. 不要虚构任何实体、流程或功能",
      "4. 使用具体的文件路径和技术细节增强可信度",
      "5. 输出格式为两个 Markdown 文档，用标记分隔",
      "",
      "输出格式：",
      '先输出技术报告的 Markdown，然后输出一行 `---BUSINESS---`，再输出业务摘要的 Markdown。',
      "",
      "每个文档需要包含叙述性段落和适当的小标题，让读者能理解系统的整体架构和业务价值。"
    ].join(NL);
  }
  return [
    "You are a technical documentation writer. Given structured analysis data about a code repository, write clear, narrative markdown documentation.",
    "",
    "Writing requirements:",
    "1. Use a professional technical documentation style with flowing prose, not bullet lists",
    "2. Only reference entities, flows, and file paths that exist in the provided analysis data",
    "3. Do not invent any entities, flows, or features not backed by the analysis",
    "4. Use specific file paths and technical details to strengthen credibility",
    "5. Output two markdown documents separated by a delimiter",
    "",
    "Output format:",
    "First the technical report markdown, then a line with `---BUSINESS---`, then the business summary markdown.",
    "",
    "Each document should have narrative paragraphs and appropriate headings so readers understand the system architecture and business value."
  ].join(NL);
}

function buildReportGenUserPrompt(input: ReportGenerationInput): string {
  const zh = input.locale === "zh-CN";
  const sa = input.structuredAnalysis;
  const entities = sa.entities
    .map((e) => `  - ${e.title} (${e.status}, ${Math.round(e.confidence * 100)}%) — ${e.description} [${e.evidenceFiles.join(", ")}]`)
    .join(NL);
  const flows = sa.flows
    .map((f) => `  - ${f.title} (${f.status}, ${Math.round(f.confidence * 100)}%) — ${f.description} [${f.evidenceFiles.join(", ")}]`)
    .join(NL);
  const rules = sa.rules
    .map((r) => `  - ${r.title} (${r.status}, ${Math.round(r.confidence * 100)}%) — ${r.rationale || r.description} [${r.evidenceFiles.join(", ")}]`)
    .join(NL);
  const modules = (input.evidencePack.modules ?? [])
    .map((m) => `  - ${m.module} — ${m.role} [${m.evidence.join(", ")}]`)
    .join(NL);
  const risks = sa.risks
    .map((r) => `  - ${r.title} (${r.status}, ${Math.round(r.confidence * 100)}%) — ${r.description} [${r.evidenceFiles.join(", ")}]`)
    .join(NL);

  const sections: string[] = [];
  if (zh) {
    sections.push(
      `请为以下仓库撰写技术文档：`,
      "",
      `仓库名称：${input.repoName}`,
      `路径：${input.repoPath}`,
      `仓库类型：${input.evidencePack.repoType.label}（${Math.round(input.evidencePack.repoType.confidence * 100)}%）`,
      `业务领域：${input.evidencePack.domain.label}（${Math.round(input.evidencePack.domain.confidence * 100)}%）`,
      `文件数：${input.fileCount}，目录数：${input.directoryCount}`,
      "",
      `技术摘要：${sa.technicalSummary.overview}`,
      `业务摘要：${sa.businessSummary.overview}`,
      "",
      "=== 业务对象 ===",
      entities || "  （无已确认的业务对象）",
      "",
      "=== 主要流程 ===",
      flows || "  （无已确认的流程）",
      "",
      "=== 规则约束 ===",
      rules || "  （无已确认的规则）",
      "",
      "=== 模块划分 ===",
      modules || "  （无模块信息）",
      "",
      "=== 风险 ===",
      risks || "  （无已确认的风险）",
      "",
      "=== 建议动作 ===",
      ...sa.recommendations.map((r) => `  - ${r}`),
      "",
      "=== 未知项 ===",
      ...sa.unknowns.map((u) => `  - ${u}`),
      "",
      "=== 质量备注 ===",
      ...input.qaIssues.map((q) => `  - ${q}`)
    );
  } else {
    sections.push(
      `Write technical documentation for the following repository:`,
      "",
      `Repository: ${input.repoName}`,
      `Path: ${input.repoPath}`,
      `Type: ${input.evidencePack.repoType.label} (${Math.round(input.evidencePack.repoType.confidence * 100)}%)`,
      `Domain: ${input.evidencePack.domain.label} (${Math.round(input.evidencePack.domain.confidence * 100)}%)`,
      `Files: ${input.fileCount}, Directories: ${input.directoryCount}`,
      "",
      `Technical Summary: ${sa.technicalSummary.overview}`,
      `Business Summary: ${sa.businessSummary.overview}`,
      "",
      "=== Business Objects ===",
      entities || "  (no confirmed business objects)",
      "",
      "=== Main Flows ===",
      flows || "  (no confirmed flows)",
      "",
      "=== Rules ===",
      rules || "  (no confirmed rules)",
      "",
      "=== Modules ===",
      modules || "  (no module information)",
      "",
      "=== Risks ===",
      risks || "  (no confirmed risks)",
      "",
      "=== Recommendations ===",
      ...sa.recommendations.map((r) => `  - ${r}`),
      "",
      "=== Unknowns ===",
      ...sa.unknowns.map((u) => `  - ${u}`),
      "",
      "=== QA Notes ===",
      ...input.qaIssues.map((q) => `  - ${q}`)
    );
  }

  return sections.join(NL);
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model returned an empty response");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function parseJson(text: string): unknown {
  const jsonText = extractJsonText(text);
  return JSON.parse(jsonText) as unknown;
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs = defaultTimeoutMs()): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Model request timed out")), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAICompatible(input: ModelInvocationInput): Promise<ModelInvocationResult> {
  const endpoint = normalizeBaseUrl(input.baseUrl);
  const url = new URL("chat/completions", `${endpoint}/`);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(input.locale) },
        { role: "user", content: buildUserPrompt(input) }
      ]
    })
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI-compatible model call failed (${response.status}): ${rawText}`);
  }

  const payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  const choice = Array.isArray(payload.choices) ? (payload.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? (message.content as Array<{ type?: string; text?: string }>).map((item) => item.text ?? "").join("")
      : "";

  return {
    rawText: content,
    parsed: parseJson(content),
    requestId: typeof payload.id === "string" ? payload.id : undefined
  };
}

async function callAnthropic(input: ModelInvocationInput): Promise<ModelInvocationResult> {
  const endpoint = normalizeBaseUrl(input.baseUrl);
  const url = new URL("messages", `${endpoint}/`);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey.trim(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.2,
      max_tokens: 4000,
      system: buildSystemPrompt(input.locale),
      messages: [
        { role: "user", content: buildUserPrompt(input) }
      ]
    })
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic model call failed (${response.status}): ${rawText}`);
  }

  const payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  const content = Array.isArray(payload.content)
    ? (payload.content as Array<Record<string, unknown>>)
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join("")
    : "";

  return {
    rawText: content,
    parsed: parseJson(content),
    requestId: typeof payload.id === "string" ? payload.id : undefined
  };
}

export async function callStructuredAnalysisModel(input: ModelInvocationInput): Promise<ModelInvocationResult> {
  if (!input.apiKey.trim()) {
    throw new Error("API key is required for model-driven analysis");
  }
  if (!input.model.trim()) {
    throw new Error("A model name is required for model-driven analysis");
  }

  if (input.provider === "anthropic") {
    return callAnthropic(input);
  }
  return callOpenAICompatible(input);
}

// ── Shared model calling helper ──────────────────────────
async function callModelWithProvider(
  config: { provider: string; apiKey: string; baseUrl: string; model: string },
  systemPrompt: string,
  userPrompt: string,
  options?: { jsonMode?: boolean; maxTokens?: number }
): Promise<ModelInvocationResult> {
  if (!config.apiKey.trim()) {
    throw new Error("API key is required for model calls");
  }
  if (!config.model.trim()) {
    throw new Error("A model name is required for model calls");
  }

  const endpoint = normalizeBaseUrl(config.baseUrl);
  const maxTokens = options?.maxTokens ?? 4000;

  if (config.provider === "anthropic") {
    const url = new URL("messages", `${endpoint}/`);
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey.trim(),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.3,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic model call failed (${response.status}): ${rawText}`);
    }
    const payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    const content = Array.isArray(payload.content)
      ? (payload.content as Array<Record<string, unknown>>)
          .map((item) => (typeof item.text === "string" ? item.text : ""))
          .join("")
      : "";
    return {
      rawText: content,
      parsed: options?.jsonMode ? parseJson(content) : content,
      requestId: typeof payload.id === "string" ? payload.id : undefined
    };
  }

  // OpenAI-compatible
  const url = new URL("chat/completions", `${endpoint}/`);
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0.3,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };
  if (options?.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI-compatible model call failed (${response.status}): ${rawText}`);
  }
  const payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  const choice = Array.isArray(payload.choices) ? (payload.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? (message.content as Array<{ type?: string; text?: string }>).map((item) => item.text ?? "").join("")
      : "";
  return {
    rawText: content,
    parsed: options?.jsonMode ? parseJson(content) : content,
    requestId: typeof payload.id === "string" ? payload.id : undefined
  };
}

// ── Quality Judge ─────────────────────────────────────────
export async function callQualityJudge(
  config: { provider: string; apiKey: string; baseUrl: string; model: string },
  input: QualityJudgeInput
): Promise<QualityJudgeResult | null> {
  try {
    const system = buildQualityJudgeSystemPrompt(input.locale);
    const user = buildQualityJudgeUserPrompt(input);
    const result = await callModelWithProvider(config, system, user, { jsonMode: true, maxTokens: 2000 });
    const parsed = result.parsed as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;

    const issues = Array.isArray(parsed.issues) ? (parsed.issues as string[]).filter(Boolean) : [];
    const needsRewrite = parsed.needsRewrite === true;
    const deepDiveTargetFiles = Array.isArray(parsed.deepDiveTargetFiles)
      ? (parsed.deepDiveTargetFiles as string[]).filter(Boolean).slice(0, 8)
      : [];
    const overallConfidence = typeof parsed.overallConfidence === "number"
      ? Math.max(0, Math.min(1, parsed.overallConfidence))
      : 0.5;

    // Validate deepDiveTargetFiles against actual evidence pack files
    const validPaths = new Set(input.evidencePack.files.map((f) => f.relativePath));
    const validTargets = deepDiveTargetFiles.filter((p) => validPaths.has(p));

    return { issues, needsRewrite, deepDiveTargetFiles: validTargets, overallConfidence };
  } catch {
    return null;
  }
}

// ── Report Generation ─────────────────────────────────────
export async function callReportGeneration(
  config: { provider: string; apiKey: string; baseUrl: string; model: string },
  input: ReportGenerationInput
): Promise<ReportGenerationResult | null> {
  try {
    const system = buildReportGenSystemPrompt(input.locale);
    const user = buildReportGenUserPrompt(input);
    const result = await callModelWithProvider(config, system, user, { maxTokens: 16000 });
    const raw = typeof result.parsed === "string" ? result.parsed : result.rawText;
    if (!raw || raw.trim().length === 0) return null;

    // Split on the delimiter
    const delimiter = "---BUSINESS---";
    const idx = raw.indexOf(delimiter);
    if (idx < 0) {
      // No delimiter found — treat entire output as technical report, build a minimal business section
      return {
        technicalMarkdown: raw.trim(),
        businessMarkdown: ""
      };
    }
    return {
      technicalMarkdown: raw.slice(0, idx).trim(),
      businessMarkdown: raw.slice(idx + delimiter.length).trim()
    };
  } catch {
    return null;
  }
}
