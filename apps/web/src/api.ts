import type { LocaleCode } from "./i18n";
import type {
  JobSnapshot,
  ProviderConfig,
  ProviderConfigResponse,
  ProviderTestResult,
  RepositoryAnalysis,
  ReportView
} from "./types";

function fallbackError(locale: LocaleCode, english: string, chinese: string): string {
  return locale === "zh-CN" ? chinese : english;
}

function stringifyDetails(details: unknown): string {
  if (typeof details === "string") {
    return details;
  }
  if (!details) {
    return "";
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

async function downloadTextArtifact(url: string, filename: string, mimeType: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download artifact from ${url}`);
  }
  const content = await response.text();
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

export async function createJob(repoPath: string, locale: LocaleCode): Promise<JobSnapshot> {
  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ repoPath, locale })
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || fallbackError(locale, `Failed to create job (${response.status})`, `创建任务失败（${response.status}）`));
  }

  const payload = (await response.json()) as { job: JobSnapshot };
  return payload.job;
}

export async function fetchJob(jobId: string): Promise<JobSnapshot> {
  const response = await fetch(`/api/jobs/${jobId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch job ${jobId}`);
  }
  const payload = (await response.json()) as { job: JobSnapshot };
  return payload.job;
}

export async function listJobs(limit = 20): Promise<JobSnapshot[]> {
  const response = await fetch(`/api/jobs?limit=${encodeURIComponent(String(limit))}`);
  if (!response.ok) {
    throw new Error("Failed to list jobs");
  }
  const payload = (await response.json()) as { jobs: JobSnapshot[] };
  return payload.jobs;
}

export async function fetchReport(jobId: string, view: ReportView = "combined"): Promise<RepositoryAnalysis> {
  const response = await fetch(`/api/jobs/${jobId}/report?view=${encodeURIComponent(view)}`);
  if (!response.ok) {
    throw new Error(`Report is not ready for job ${jobId}`);
  }
  const payload = (await response.json()) as { analysis: RepositoryAnalysis };
  return payload.analysis;
}

export async function loadProviderConfig(): Promise<ProviderConfigResponse> {
  const response = await fetch("/api/provider-config");
  if (!response.ok) {
    throw new Error("Failed to load provider config");
  }
  return (await response.json()) as ProviderConfigResponse;
}

export async function saveProviderConfig(config: ProviderConfig): Promise<ProviderConfigResponse> {
  const response = await fetch("/api/provider-config", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(config)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || "Failed to save provider config");
  }
  return (await response.json()) as ProviderConfigResponse;
}

export async function testProviderConfig(config: Partial<ProviderConfig>): Promise<ProviderTestResult> {
  const response = await fetch("/api/provider-config/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(config)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: unknown };
    const details = stringifyDetails(payload.details);
    throw new Error([payload.error || "Failed to test provider config", details].filter(Boolean).join(": "));
  }
  const payload = (await response.json()) as { result: ProviderTestResult };
  return payload.result;
}

export function connectJobStream(
  jobId: string,
  onSnapshot: (snapshot: JobSnapshot) => void,
  onDone?: (status: "completed" | "failed") => void
): EventSource {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  source.addEventListener("snapshot", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as JobSnapshot;
    onSnapshot(payload);
  });
  source.addEventListener("done", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { status: "completed" | "failed" };
    onDone?.(payload.status);
  });
  source.onerror = () => {
    // Keep the event stream simple; the polling fallback in the UI will cover reconnects.
  };
  return source;
}

export async function rerunJob(jobId: string, locale?: LocaleCode): Promise<JobSnapshot> {
  const response = await fetch(`/api/jobs/${jobId}/rerun`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ locale })
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Failed to rerun job ${jobId}`);
  }
  const payload = (await response.json()) as { job: JobSnapshot };
  return payload.job;
}

export async function deleteJob(jobId: string, locale?: LocaleCode): Promise<void> {
  const response = await fetch(`/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: locale ? { "Accept-Language": locale } : undefined
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Failed to delete job ${jobId}`);
  }
}

export async function downloadMarkdown(jobId: string, view: ReportView = "combined", locale?: string): Promise<void> {
  try {
    await downloadTextArtifact(
      `/api/jobs/${jobId}/export?format=markdown&view=${encodeURIComponent(view)}`,
      `repo-report-${jobId}-${view}${locale ? `-${locale}` : ""}.md`,
      "text/markdown"
    );
  } catch {
    throw new Error(locale === "zh-CN" ? "Markdown 报告尚未生成" : "Markdown report is not ready");
  }
}

export async function downloadAnalysisJson(jobId: string, view: ReportView = "combined", locale?: string): Promise<void> {
  try {
    await downloadTextArtifact(
      `/api/jobs/${jobId}/export?format=json&view=${encodeURIComponent(view)}`,
      `repo-analysis-${jobId}-${view}${locale ? `-${locale}` : ""}.json`,
      "application/json"
    );
  } catch {
    throw new Error(locale === "zh-CN" ? "JSON 分析尚未生成" : "JSON analysis is not ready");
  }
}
