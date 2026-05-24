import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  BusinessEntity,
  EvidenceItem,
  FileInsight,
  FlowStep,
  RepoFileRecord,
  RepoScanResult,
  RepoSignal,
  RepoTypePrediction,
  RuleItem
} from "../domain.js";
import { BUSINESS_DOMAIN_KEYWORDS, STOP_WORDS } from "../domain.js";

const DOMAIN_LABELS: Record<string, string> = {
  ecommerce: "commerce / order handling",
  workflow: "workflow / approval processing",
  content: "content / document management",
  support: "support / messaging",
  identity: "identity / access management",
  analytics: "analytics / reporting",
  finance: "finance / billing",
  agent: "agent / orchestration",
  devtool: "developer tooling"
};

const REPO_TYPE_LABELS = [
  "workflow/agent system",
  "frontend application",
  "backend service",
  "CLI tool",
  "library/package",
  "data pipeline",
  "monorepo",
  "application"
];

const COMMON_VERBS = [
  "submit",
  "validate",
  "approve",
  "reject",
  "create",
  "update",
  "delete",
  "dispatch",
  "process",
  "publish",
  "notify",
  "sync",
  "retry",
  "complete",
  "archive",
  "cancel",
  "close",
  "open",
  "resolve",
  "schedule",
  "execute",
  "plan"
];

function titleCase(value: string): string {
  return value
    .split(/[\s._/-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/-]+/g, " ")
    .replace(/[^\w\s]+/g, " ")
    .toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 2 && !STOP_WORDS.has(item));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function trimLong(value: string, maxLength = 160): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function getFileKey(file: RepoFileRecord): string {
  return file.hash ?? `${file.relativePath}:${file.size}:${file.mtimeMs}`;
}

function pathWords(file: RepoFileRecord): string[] {
  return tokenize(file.relativePath).concat(tokenize(path.basename(file.relativePath)));
}

function scoreKeywords(text: string, keywords: string[]): number {
  const normalized = normalize(text);
  let score = 0;
  for (const keyword of keywords) {
    const matches = normalized.match(new RegExp(`\\b${keyword}\\b`, "g"));
    if (matches) {
      score += matches.length;
    }
  }
  return score;
}

function countPathSignals(files: RepoFileRecord[], keywords: string[]): Array<{ keyword: string; files: string[] }> {
  return keywords
    .map((keyword) => {
      const matches = files.filter((file) =>
        normalize(file.relativePath).includes(keyword) || normalize(file.sample).includes(keyword)
      );
      return {
        keyword,
        files: matches.slice(0, 5).map((file) => file.relativePath)
      };
    })
    .filter((item) => item.files.length > 0);
}

function findManifest(files: RepoFileRecord[], names: string[]): RepoFileRecord | undefined {
  return files.find((file) => names.includes(path.basename(file.relativePath)));
}

function extractTokensFromContent(content: string): string[] {
  return tokenize(content)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => token.length > 2);
}

function summarizeRepoType(
  scan: RepoScanResult,
  fileInsights: FileInsight[]
): RepoTypePrediction {
  const filePaths = scan.files.map((file) => file.relativePath.toLowerCase());
  const textCorpus = fileInsights.map((item) => `${item.summary} ${item.signals.join(" ")}`).join(" ").toLowerCase();
  const counts = new Map<string, number>();

  const addScore = (label: string, amount: number, reason: string) => {
    if (amount <= 0) {
      return;
    }
    counts.set(label, (counts.get(label) ?? 0) + amount);
  };

  const manifestText = filePaths.join(" ");
  if (manifestText.includes("package.json") || manifestText.includes("vite.config") || manifestText.includes("tsconfig")) {
    addScore("frontend application", 2, "web tooling present");
  }
  if (textCorpus.includes("express") || textCorpus.includes("fastify") || textCorpus.includes("nest") || textCorpus.includes("koa")) {
    addScore("backend service", 3, "server framework dependencies");
  }
  if (textCorpus.includes("cli") || textCorpus.includes("commander") || textCorpus.includes("yargs")) {
    addScore("CLI tool", 3, "cli-oriented dependencies");
  }
  if (textCorpus.includes("langgraph") || textCorpus.includes("checkpoint") || textCorpus.includes("agent")) {
    addScore("workflow/agent system", 4, "graph orchestration clues");
  }
  if (textCorpus.includes("dbt") || textCorpus.includes("airflow") || textCorpus.includes("pipeline") || textCorpus.includes("etl")) {
    addScore("data pipeline", 4, "pipeline-style dependencies");
  }
  if (scan.files.some((file) => file.relativePath.startsWith("apps/") || file.relativePath.startsWith("packages/"))) {
    addScore("monorepo", 3, "multiple top-level application directories");
  }
  if (scan.entrypoints.some((file) => normalize(file).includes("server") || normalize(file).includes("api"))) {
    addScore("backend service", 2, "service entrypoint found");
  }
  if (scan.entrypoints.some((file) => normalize(file).includes("app") || normalize(file).includes("index.html"))) {
    addScore("frontend application", 2, "frontend entrypoint found");
  }
  if (scan.tests.length > 0) {
    addScore("library/package", 1, "test coverage present");
  }
  if (filePaths.some((file) => file.endsWith("package.json")) && filePaths.some((file) => file.endsWith("index.ts"))) {
    addScore("library/package", 1, "library-like source layout");
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const best = sorted[0] ?? ["application", 1];
  const runnerUp = sorted[1]?.[1] ?? 0;
  const confidence = Math.max(0.3, Math.min(0.95, best[1] / Math.max(best[1] + runnerUp + 1, 2)));

  return {
    label: best[0],
    confidence,
    reasons: buildRepoTypeReasons(scan, fileInsights, best[0])
  };
}

function buildRepoTypeReasons(
  scan: RepoScanResult,
  fileInsights: FileInsight[],
  label: string
): string[] {
  const reasons: string[] = [];
  if (label === "frontend application") {
    if (scan.entrypoints.some((item) => item.toLowerCase().includes("index.html") || item.toLowerCase().includes("app"))) {
      reasons.push("frontend entrypoint files are present");
    }
    if (scan.manifests.some((item) => item.toLowerCase().includes("package.json"))) {
      reasons.push("package.json indicates a JavaScript/TypeScript app");
    }
    if (fileInsights.some((item) => item.summary.toLowerCase().includes("react") || item.summary.toLowerCase().includes("ui"))) {
      reasons.push("file summaries mention UI-oriented code");
    }
  }
  if (label === "backend service") {
    if (scan.entrypoints.some((item) => item.toLowerCase().includes("server") || item.toLowerCase().includes("api"))) {
      reasons.push("server or api entrypoints are present");
    }
    if (fileInsights.some((item) => item.summary.toLowerCase().includes("route") || item.summary.toLowerCase().includes("handler"))) {
      reasons.push("file summaries mention routes or handlers");
    }
  }
  if (label === "workflow/agent system") {
    if (scan.files.some((file) => file.relativePath.toLowerCase().includes("langgraph") || file.sample.toLowerCase().includes("stategraph"))) {
      reasons.push("LangGraph-style orchestration cues are present");
    }
    if (scan.files.some((file) => file.relativePath.toLowerCase().includes("checkpoint") || file.sample.toLowerCase().includes("checkpoint"))) {
      reasons.push("checkpoint or persistence cues are present");
    }
  }
  if (label === "monorepo") {
    reasons.push("multiple application or package roots were detected");
  }
  if (label === "library/package") {
    reasons.push("the repository looks more like a reusable package than a standalone product");
  }
  if (reasons.length === 0) {
    reasons.push("repository layout suggests this is the best fit among the detected categories");
  }
  return reasons.slice(0, 4);
}

function inferDomain(
  scan: RepoScanResult,
  fileInsights: FileInsight[]
): RepoTypePrediction {
  const corpus = [
    ...scan.files.map((file) => file.relativePath),
    ...scan.files.map((file) => file.sample),
    ...fileInsights.map((item) => item.summary),
    ...fileInsights.flatMap((item) => item.signals),
    ...scan.manifests,
    ...scan.configs
  ].join("\n");

  const scores = Object.entries(BUSINESS_DOMAIN_KEYWORDS).map(([domain, keywords]) => {
    let score = 0;
    for (const keyword of keywords) {
      const matches = corpus.toLowerCase().match(new RegExp(`\\b${keyword}\\b`, "g"));
      score += matches ? matches.length : 0;
    }
    return [domain, score] as const;
  });

  scores.sort((a, b) => b[1] - a[1]);
  const best = scores[0] ?? ["generic", 0];
  const runnerUp = scores[1]?.[1] ?? 0;
  const confidence = Math.max(0.2, Math.min(0.95, best[1] / Math.max(best[1] + runnerUp + 2, 2)));
  const reasons = buildDomainReasons(best[0], scan, fileInsights);

  return {
    label: DOMAIN_LABELS[best[0]] ?? "generic product",
    confidence,
    reasons
  };
}

function buildDomainReasons(
  domain: string,
  scan: RepoScanResult,
  fileInsights: FileInsight[]
): string[] {
  const keywords = BUSINESS_DOMAIN_KEYWORDS[domain] ?? [];
  const reasons: string[] = [];
  const corpus = [
    ...scan.files.map((file) => file.relativePath),
    ...scan.files.map((file) => file.sample),
    ...fileInsights.map((item) => item.summary)
  ].join(" ").toLowerCase();

  const matches = keywords.filter((keyword) => corpus.includes(keyword));
  if (matches.length > 0) {
    reasons.push(`found repeated domain words: ${matches.slice(0, 5).join(", ")}`);
  }
  if (domain === "agent" && corpus.includes("langgraph")) {
    reasons.push("the repo contains LangGraph-specific orchestration clues");
  }
  if (domain === "workflow" && corpus.includes("status")) {
    reasons.push("status and transition terms appear repeatedly");
  }
  if (domain === "identity" && corpus.includes("permission")) {
    reasons.push("access control terms appear in the repository");
  }
  if (domain === "finance" && corpus.includes("payment")) {
    reasons.push("payment and billing terminology is present");
  }
  if (reasons.length === 0) {
    reasons.push("the domain choice is a best-effort fit from file names and content patterns");
  }
  return reasons.slice(0, 4);
}

function buildSignals(
  scan: RepoScanResult,
  fileInsights: FileInsight[],
  repoType: RepoTypePrediction,
  domain: RepoTypePrediction
): RepoSignal[] {
  const signals: RepoSignal[] = [];

  if (scan.manifests.some((file) => file.endsWith("package.json"))) {
    signals.push({
      label: "manifest",
      value: "package.json found",
      confidence: 0.95,
      evidence: scan.manifests.slice(0, 3)
    });
  }
  if (scan.entrypoints.length > 0) {
    signals.push({
      label: "entrypoints",
      value: scan.entrypoints.slice(0, 3).join(", "),
      confidence: 0.9,
      evidence: scan.entrypoints.slice(0, 3)
    });
  }
  if (scan.tests.length > 0) {
    signals.push({
      label: "tests",
      value: `${scan.tests.length} test files detected`,
      confidence: 0.82,
      evidence: scan.tests.slice(0, 5)
    });
  }
  if (scan.configs.length > 0) {
    signals.push({
      label: "configuration",
      value: `${scan.configs.length} config or infra files detected`,
      confidence: 0.8,
      evidence: scan.configs.slice(0, 5)
    });
  }
  signals.push({
    label: "repo type",
    value: `${repoType.label} (${Math.round(repoType.confidence * 100)}%)`,
    confidence: repoType.confidence,
    evidence: repoType.reasons.slice(0, 4)
  });
  signals.push({
    label: "business domain",
    value: `${domain.label} (${Math.round(domain.confidence * 100)}%)`,
    confidence: domain.confidence,
    evidence: domain.reasons.slice(0, 4)
  });

  const topInsights = [...fileInsights]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
  for (const insight of topInsights) {
    signals.push({
      label: "file insight",
      value: `${insight.path} -> ${insight.summary}`,
      confidence: insight.confidence,
      evidence: insight.evidence.slice(0, 3)
    });
  }

  return signals;
}

function buildEntities(
  scan: RepoScanResult,
  domain: RepoTypePrediction,
  fileInsights: FileInsight[]
): BusinessEntity[] {
  const corpusWords = new Map<string, number>();

  const addWord = (word: string, amount = 1) => {
    if (word.length < 3 || STOP_WORDS.has(word)) {
      return;
    }
    corpusWords.set(word, (corpusWords.get(word) ?? 0) + amount);
  };

  for (const file of scan.files) {
    for (const word of tokenize(file.relativePath)) {
      addWord(word, 1);
    }
    for (const word of tokenize(file.sample)) {
      addWord(word, 1);
    }
  }

  const keywordSet = new Set(Object.values(BUSINESS_DOMAIN_KEYWORDS).flat());
  const domainTokens = [...corpusWords.entries()]
    .filter(([word, count]) => count >= 2 || keywordSet.has(word))
    .sort((a, b) => b[1] - a[1]);

  const chosen = domainTokens.slice(0, 6).map(([word]) => word);
  if (chosen.length === 0) {
    chosen.push(domain.label.split(" / ")[0].toLowerCase());
  }

  return chosen.map((word, index) => {
    const evidence = fileInsights
      .filter((item) => item.summary.toLowerCase().includes(word) || item.signals.join(" ").toLowerCase().includes(word))
      .slice(0, 3)
      .map((item) => item.path);
    return {
      name: titleCase(word),
      kind: index === 0 ? "primary business object" : "supporting entity",
      description: `Likely business concept inferred from repeated path and content signals around "${word}".`,
      evidence: evidence.length > 0 ? evidence : scan.files.slice(0, 2).map((item) => item.relativePath),
      confidence: Math.min(0.9, 0.4 + Math.min(0.5, (corpusWords.get(word) ?? 1) / 10))
    };
  });
}

function buildFlowTemplates(domainLabel: string, repoType: string): Array<{ title: string; description: string }> {
  const domain = domainLabel.toLowerCase();
  if (domain.includes("order") || domain.includes("commerce")) {
    return [
      { title: "Request intake", description: "A user or upstream system creates a commerce request." },
      { title: "Validation", description: "The system validates item availability, pricing, and required fields." },
      { title: "Payment or confirmation", description: "The workflow handles payment or acceptance before proceeding." },
      { title: "Fulfillment", description: "The request is dispatched to downstream systems for completion." }
    ];
  }
  if (domain.includes("workflow") || repoType === "workflow/agent system") {
    return [
      { title: "Submission", description: "A new task, request, or job enters the workflow." },
      { title: "Review or routing", description: "The system routes the item through validation, assignment, or review." },
      { title: "Decision", description: "Rules or status transitions decide approve, reject, or continue." },
      { title: "Completion", description: "The workflow finalizes and stores the outcome." }
    ];
  }
  if (domain.includes("support") || domain.includes("message")) {
    return [
      { title: "Ticket creation", description: "A user message or support request is opened." },
      { title: "Triage", description: "The system categorizes and assigns the issue." },
      { title: "Response", description: "Operators or automation send a reply or fix." },
      { title: "Resolution", description: "The issue is closed and archived." }
    ];
  }
  if (domain.includes("identity")) {
    return [
      { title: "Authentication", description: "The system verifies identity and session state." },
      { title: "Authorization", description: "Permissions and roles are checked before actions run." },
      { title: "Access grant", description: "The request is either allowed or denied." }
    ];
  }
  if (repoType === "CLI tool") {
    return [
      { title: "Command parsing", description: "The tool reads flags and arguments." },
      { title: "Execution planning", description: "The tool determines which action to run." },
      { title: "Output generation", description: "Results are printed, saved, or forwarded." }
    ];
  }
  if (repoType === "backend service") {
    return [
      { title: "Inbound request", description: "An API or event handler receives a request." },
      { title: "Business validation", description: "Inputs are checked against rules and state." },
      { title: "Persistence and dispatch", description: "The system updates storage and sends downstream work." }
    ];
  }
  return [
    { title: "Entry", description: "The repository receives an input or trigger." },
    { title: "Processing", description: "Core logic transforms data or coordinates work." },
    { title: "Completion", description: "The system writes a result or produces output." }
  ];
}

function inferFlows(
  scan: RepoScanResult,
  repoType: RepoTypePrediction,
  domain: RepoTypePrediction,
  fileInsights: FileInsight[]
): FlowStep[] {
  const templates = buildFlowTemplates(domain.label, repoType.label);
  const joinedCorpus = [
    ...scan.files.map((file) => file.relativePath),
    ...scan.files.map((file) => file.sample),
    ...fileInsights.map((item) => item.summary),
    ...fileInsights.flatMap((item) => item.signals)
  ]
    .join(" ")
    .toLowerCase();

  return templates.map((template, index) => {
    const evidence = scan.files
      .filter((file) => {
        const source = `${file.relativePath} ${file.sample}`.toLowerCase();
        const titleWords = tokenize(template.title);
        return titleWords.some((word) => source.includes(word));
      })
      .slice(0, 3)
      .map((file) => file.relativePath);

    const keywordCount = COMMON_VERBS.reduce(
      (count, verb) => count + (joinedCorpus.includes(verb) ? 1 : 0),
      0
    );
    return {
      id: `flow-${index + 1}`,
      title: template.title,
      description: template.description,
      evidence: evidence.length > 0 ? evidence : scan.entrypoints.slice(0, 2),
      confidence: Math.min(0.88, 0.45 + (keywordCount + index) * 0.07),
      order: index + 1
    };
  });
}

function inferRules(scan: RepoScanResult, fileInsights: FileInsight[]): RuleItem[] {
  const corpus = [
    ...scan.files.map((file) => file.sample),
    ...fileInsights.map((item) => item.summary),
    ...fileInsights.flatMap((item) => item.signals)
  ];
  const joined = corpus.join("\n");
  const lines = joined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ruleKeywords = [
    "must",
    "required",
    "should",
    "cannot",
    "can't",
    "forbidden",
    "only when",
    "if",
    "unless",
    "validate",
    "retry",
    "timeout",
    "unique",
    "permission",
    "role",
    "state",
    "idempotent",
    "limit"
  ];

  const matches = lines.filter((line) =>
    ruleKeywords.some((keyword) => line.toLowerCase().includes(keyword))
  );

  const selected = matches.slice(0, 10);
  if (selected.length === 0) {
    return [
      {
        rule: "The repository likely enforces basic validation before state changes.",
        rationale: "No explicit rule text was discovered, so this is a conservative inference from the file layout and common code structure.",
        evidence: scan.entrypoints.slice(0, 2),
        confidence: 0.35
      }
    ];
  }

  return selected.map((line, index) => {
    const evidence = scan.files
      .filter((file) => file.sample.includes(line.slice(0, 40)))
      .slice(0, 3)
      .map((file) => file.relativePath);

    return {
      rule: trimLong(line, 140),
      rationale: "This line contains a rule-like keyword that likely reflects a business constraint or implementation guardrail.",
      evidence: evidence.length > 0 ? evidence : scan.entrypoints.slice(0, 2),
      confidence: Math.min(0.92, 0.55 + index * 0.03)
    };
  });
}

function inferEvidence(
  scan: RepoScanResult,
  repoType: RepoTypePrediction,
  domain: RepoTypePrediction,
  fileInsights: FileInsight[]
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  if (scan.manifests.length > 0) {
    items.push({
      claim: "The repository has explicit project manifests and build metadata.",
      files: scan.manifests.slice(0, 5),
      confidence: 0.95,
      notes: "Manifest files are usually the most reliable signal for repository intent and tooling."
    });
  }
  if (scan.entrypoints.length > 0) {
    items.push({
      claim: "The repository exposes one or more clear entrypoint files.",
      files: scan.entrypoints.slice(0, 5),
      confidence: 0.9,
      notes: "Entrypoints suggest the operational shape of the project."
    });
  }
  if (scan.tests.length > 0) {
    items.push({
      claim: "The repository includes tests, which can help reconstruct expected behavior.",
      files: scan.tests.slice(0, 5),
      confidence: 0.85,
      notes: "Tests often reveal domain objects, invariants, and main flows."
    });
  }
  if (repoType.reasons.length > 0) {
    items.push({
      claim: `Repository type inference: ${repoType.label}.`,
      files: fileInsights.slice(0, 3).flatMap((item) => item.evidence).slice(0, 5),
      confidence: repoType.confidence,
      notes: repoType.reasons.join(" ")
    });
  }
  if (domain.reasons.length > 0) {
    items.push({
      claim: `Business domain inference: ${domain.label}.`,
      files: fileInsights.slice(0, 3).flatMap((item) => item.evidence).slice(0, 5),
      confidence: domain.confidence,
      notes: domain.reasons.join(" ")
    });
  }

  for (const insight of fileInsights.slice(0, 5)) {
    items.push({
      claim: insight.summary,
      files: [insight.path, ...insight.evidence].slice(0, 4),
      confidence: insight.confidence,
      notes: insight.signals.join("; ")
    });
  }

  return items;
}

function inferUnknowns(
  scan: RepoScanResult,
  repoType: RepoTypePrediction,
  domain: RepoTypePrediction,
  fileInsights: FileInsight[]
): string[] {
  const unknowns: string[] = [];
  if (scan.docs.length === 0) {
    unknowns.push("No documentation files were found, so the business narrative is inferred mostly from code and manifests.");
  }
  if (scan.tests.length === 0) {
    unknowns.push("No obvious tests were found, which reduces confidence in the inferred behavior and edge cases.");
  }
  if (repoType.confidence < 0.55) {
    unknowns.push("Repository type confidence is still moderate, so the structural interpretation may shift after deeper inspection.");
  }
  if (domain.confidence < 0.55) {
    unknowns.push("Business domain confidence is still moderate, so the domain label should be treated as a best-effort guess.");
  }
  if (fileInsights.every((item) => item.confidence < 0.6)) {
    unknowns.push("Most file-level insights are low confidence, which means the report should be treated as provisional.");
  }
  if (scan.entrypoints.length === 0) {
    unknowns.push("No unambiguous entrypoint was found, so runtime boundaries are inferred rather than directly observed.");
  }
  return unique(unknowns);
}

function buildOutline(repoType: RepoTypePrediction, domain: RepoTypePrediction): string[] {
  const outline = [
    "1. One-line conclusion",
    "2. Evidence and confidence",
    "3. Business overview",
    "4. Core business objects",
    "5. Main flows",
    "6. Rules and constraints",
    "7. Module-to-business map",
    "8. Run and deployment",
    "9. Unknowns and risks",
    "10. Evidence appendix"
  ];

  if (repoType.label === "workflow/agent system") {
    outline.splice(4, 0, "5.1. Orchestration model and state flow");
  }
  if (domain.label.includes("commerce")) {
    outline.splice(4, 0, "5.1. Customer-facing transaction flow");
  }
  return outline;
}

export interface FileAnalysisBuildResult {
  insight: FileInsight;
  usedCache: boolean;
}

export async function buildFileInsight(
  file: RepoFileRecord,
  repoRoot: string,
  previous?: FileInsight | undefined,
  options?: { deep?: boolean }
): Promise<FileAnalysisBuildResult> {
  const cachedCandidate = previous?.path === file.relativePath ? previous : undefined;
  const lowerPath = file.relativePath.toLowerCase();
  const fullPath = file.path;
  const fullText =
    file.category === "manifest" ||
    file.category === "config" ||
    file.category === "docs" ||
    options?.deep
      ? await readTextFile(fullPath)
      : file.sample;
  const evidence = [file.relativePath];
  const signals: string[] = [];
  const tokenHints = unique([...tokenize(file.relativePath), ...extractTokensFromContent(fullText).slice(0, 40)]);
  let summary = `${file.category} file`;
  let confidence = 0.35;

  if (cachedCandidate && cachedCandidate.evidence.length > 0 && cachedCandidate.summary.length > 0) {
    if (cachedCandidate.evidence.includes(file.relativePath) && cachedCandidate.confidence >= 0.9) {
      return { insight: { ...cachedCandidate, reusedFromCache: true }, usedCache: true };
    }
  }

  if (path.basename(file.relativePath) === "package.json") {
    try {
      const parsed = JSON.parse(fullText || "{}") as Record<string, unknown>;
      const scripts = Object.keys((parsed.scripts as Record<string, unknown>) ?? {});
      const deps = [
        ...Object.keys((parsed.dependencies as Record<string, unknown>) ?? {}),
        ...Object.keys((parsed.devDependencies as Record<string, unknown>) ?? {})
      ];
      const workspaces = parsed.workspaces ? "workspace-enabled" : "";
      const packageName = typeof parsed.name === "string" ? parsed.name : path.basename(repoRoot);
      summary = `package.json for ${packageName} with ${scripts.length} scripts and ${deps.length} dependencies`;
      signals.push(...scripts.slice(0, 8).map((script) => `script:${script}`));
      signals.push(...deps.slice(0, 12).map((dep) => `dependency:${dep}`));
      if (workspaces) {
        signals.push(workspaces);
      }
      confidence = 0.95;
      evidence.push(file.relativePath);
    } catch {
      summary = "package manifest";
      signals.push("package-json");
      confidence = 0.75;
    }
  } else if (path.basename(file.relativePath) === "tsconfig.json") {
    try {
      const parsed = JSON.parse(fullText || "{}") as Record<string, unknown>;
      const compilerOptions = (parsed.compilerOptions as Record<string, unknown>) ?? {};
      const jsx = compilerOptions.jsx ? `jsx:${String(compilerOptions.jsx)}` : "";
      const moduleKind = compilerOptions.module ? `module:${String(compilerOptions.module)}` : "";
      summary = `TypeScript configuration with ${Object.keys(compilerOptions).length} compiler options`;
      signals.push(jsx, moduleKind);
      confidence = 0.9;
    } catch {
      summary = "TypeScript config";
      confidence = 0.7;
    }
  } else if (path.basename(file.relativePath).startsWith("readme")) {
    const lower = fullText.toLowerCase();
    const keywords = [
      "installation",
      "usage",
      "getting started",
      "quick start",
      "architecture",
      "api",
      "deploy",
      "run"
    ].filter((keyword) => lower.includes(keyword));
    summary = keywords.length > 0 ? `README with ${keywords.join(", ")}` : "project README";
    signals.push(...keywords.map((keyword) => `doc:${keyword}`));
    confidence = 0.88;
  } else if (file.category === "entrypoint") {
    const lower = fullText.toLowerCase();
    const entrySignals = [
      "listen",
      "createServer",
      "router",
      "app",
      "main",
      "start",
      "command",
      "serve",
      "render"
    ].filter((keyword) => lower.includes(keyword.toLowerCase()));
    summary = `entrypoint file with ${entrySignals.length > 0 ? entrySignals.join(", ") : "runtime"} cues`;
    signals.push(...entrySignals.map((signal) => `entry:${signal}`));
    confidence = 0.75;
  } else if (file.category === "service" || file.category === "orchestration" || file.category === "ui") {
    const lower = fullText.toLowerCase();
    const keywordBuckets = [
      ...COMMON_VERBS,
      "route",
      "controller",
      "handler",
      "schema",
      "state",
      "workflow",
      "checkpoint",
      "queue",
      "component",
      "render",
      "props",
      "store",
      "service"
    ];
    const matches = keywordBuckets.filter((keyword) => lower.includes(keyword));
    summary = `${file.category} file with ${matches.slice(0, 6).join(", ") || "domain"} cues`;
    signals.push(...matches.slice(0, 10).map((match) => `cue:${match}`));
    confidence = 0.66 + Math.min(0.18, matches.length * 0.02);
  } else if (file.category === "test") {
    const lower = fullText.toLowerCase();
    const matches = ["should", "expect", "describe", "it(", "test(", "assert", "mock"].filter((keyword) =>
      lower.includes(keyword.replace("(", ""))
    );
    summary = `test file with ${matches.length} testing cues`;
    signals.push(...matches.map((match) => `test:${match}`));
    confidence = 0.85;
  } else if (file.category === "infra") {
    const lower = fullText.toLowerCase();
    const cues = ["docker", "build", "deploy", "image", "workflow", "action", "pipeline", "service"].filter((keyword) =>
      lower.includes(keyword)
    );
    summary = `${file.category} file with ${cues.slice(0, 6).join(", ") || "deployment"} cues`;
    signals.push(...cues.map((cue) => `infra:${cue}`));
    confidence = 0.8;
  } else if (file.category === "data") {
    const lower = fullText.toLowerCase();
    const cues = ["create table", "insert", "update", "join", "foreign key", "index", "view"].filter((keyword) =>
      lower.includes(keyword)
    );
    summary = `data file with ${cues.slice(0, 4).join(", ") || "schema"} cues`;
    signals.push(...cues.map((cue) => `data:${cue}`));
    confidence = 0.84;
  } else if (fullText.trim().length > 0) {
    const tokens = extractTokensFromContent(fullText);
    const notable = unique([
      ...tokens.filter((token) => token.length > 4),
      ...pathWords(file).filter((token) => token.length > 4)
    ]).slice(0, 6);
    summary = notable.length > 0 ? `${file.category} file mentioning ${notable.join(", ")}` : `${file.category} file`;
    signals.push(...notable.map((token) => `token:${token}`));
      confidence = (options?.deep ? 0.58 : 0.5) + Math.min(0.24, notable.length * 0.04);
  }

  if (signals.length === 0) {
    signals.push(file.category);
  }

  return {
    insight: {
      path: file.relativePath,
      category: file.category,
      summary,
      signals: unique(signals),
      evidence: unique(evidence),
      confidence: Math.max(0.25, Math.min(0.97, confidence)),
      tokenHints: tokenHints.slice(0, 20),
      reusedFromCache: false
    },
    usedCache: false
  };
}

export interface RepositoryModel {
  repoType: RepoTypePrediction;
  domain: RepoTypePrediction;
  signals: RepoSignal[];
  entities: BusinessEntity[];
  flows: FlowStep[];
  rules: RuleItem[];
  evidence: EvidenceItem[];
  unknowns: string[];
  outline: string[];
}

export function inferRepositoryModel(
  scan: RepoScanResult,
  fileInsights: FileInsight[]
): RepositoryModel {
  const repoType = summarizeRepoType(scan, fileInsights);
  const domain = inferDomain(scan, fileInsights);
  const signals = buildSignals(scan, fileInsights, repoType, domain);
  const entities = buildEntities(scan, domain, fileInsights);
  const flows = inferFlows(scan, repoType, domain, fileInsights);
  const rules = inferRules(scan, fileInsights);
  const evidence = inferEvidence(scan, repoType, domain, fileInsights);
  const unknowns = inferUnknowns(scan, repoType, domain, fileInsights);
  const outline = buildOutline(repoType, domain);

  return {
    repoType,
    domain,
    signals,
    entities,
    flows,
    rules,
    evidence,
    unknowns,
    outline
  };
}

export function identifyDeepDiveTargets(fileInsights: FileInsight[]): string[] {
  return fileInsights
    .filter((item) => item.confidence < 0.7 || item.summary.length < 40)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 6)
    .map((item) => item.path);
}

export function buildModuleMap(scan: RepoScanResult, fileInsights: FileInsight[]): Array<{ module: string; role: string; evidence: string[] }> {
  const groups = new Map<string, string[]>();
  for (const file of scan.files) {
    const directory = file.relativePath.split("/").slice(0, 2).join("/") || file.relativePath;
    const current = groups.get(directory) ?? [];
    current.push(file.relativePath);
    groups.set(directory, current);
  }

  return [...groups.entries()]
    .slice(0, 12)
    .map(([module, files]) => {
      const joined = files.join(" ").toLowerCase();
      let role = "supporting module";
      if (joined.includes("route") || joined.includes("api")) {
        role = "request entry module";
      } else if (joined.includes("service") || joined.includes("handler")) {
        role = "business logic module";
      } else if (joined.includes("ui") || joined.includes("component") || joined.includes("page")) {
        role = "presentation module";
      } else if (joined.includes("test")) {
        role = "verification module";
      } else if (joined.includes("config") || joined.includes("docker") || joined.includes("workflow")) {
        role = "infrastructure module";
      }
      const evidence = fileInsights
        .filter((item) => files.some((file) => item.path === file || item.evidence.includes(file)))
        .slice(0, 3)
        .map((item) => item.path);
      return {
        module,
        role,
        evidence: evidence.length > 0 ? evidence : files.slice(0, 3)
      };
    });
}
