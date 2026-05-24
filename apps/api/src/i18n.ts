export type LocaleCode = "en" | "zh-CN";

export const SUPPORTED_LOCALES: LocaleCode[] = ["en", "zh-CN"];

export function normalizeLocale(value?: string | null): LocaleCode {
  if (!value) {
    return "en";
  }
  return value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function localeLabel(locale: LocaleCode): string {
  return locale === "zh-CN" ? "中文" : "English";
}

export function isChinese(locale: LocaleCode): boolean {
  return locale === "zh-CN";
}

export function apiText(locale: LocaleCode) {
  if (locale === "zh-CN") {
    return {
      invalidRequest: "请求体无效",
      repoNotFound: "仓库路径不存在",
      repoMustBeDirectory: "仓库路径必须是目录",
      jobNotFound: "任务未找到",
      reportNotReady: "报告尚未生成",
      internalServerError: "服务端内部错误",
      providerConfigNotFound: "模型配置未找到",
      providerConfigSaved: "模型配置已保存",
      providerTestFailed: "连接检测失败"
    };
  }

  return {
    invalidRequest: "Invalid request body",
    repoNotFound: "Repository path does not exist",
    repoMustBeDirectory: "Repository path must be a directory",
    jobNotFound: "Job not found",
    reportNotReady: "Report not ready",
    internalServerError: "Internal server error",
    providerConfigNotFound: "Provider config not found",
    providerConfigSaved: "Provider config saved",
    providerTestFailed: "Provider connection test failed"
  };
}

export function analysisText(locale: LocaleCode) {
  if (locale === "zh-CN") {
    return {
      scanRepo: {
        start: "扫描仓库结构",
        finishCached: "已从缓存恢复报告",
        finishScanned: (count: number) => `已扫描 ${count} 个文件`
      },
      classifySignals: {
        start: "提取仓库信号",
        finish: (count: number) => `已处理 ${count} 个文件`
      },
      filterEvidence: {
        start: "过滤证据和噪声",
        finish: (kept: number, rejected: number) => `保留 ${kept} 条证据，剔除 ${rejected} 条噪声`
      },
      inferRepository: {
        start: "推断仓库类型和业务领域",
        finish: (repoType: string, domain: string) => `${repoType} / ${domain}`
      },
      reconstructBusiness: {
        start: "重建业务对象和主流程",
        finish: "业务模型已重建"
      },
      draftReport: {
        start: "生成报告章节",
        finish: "报告初稿已生成"
      },
      qualityCheck: {
        start: "执行质量检查",
        accepted: "质量检查通过",
        rewrite: "发现质量问题，触发深度复扫"
      },
      deepDive: {
        start: "深挖低置信度区域",
        finish: (count: number) => `已深挖 ${count} 个文件`
      },
      finalizeReport: {
        start: "完成最终报告"
      }
    };
  }

  return {
    scanRepo: {
      start: "Scanning repository tree",
      finishCached: "Cached report restored",
      finishScanned: (count: number) => `Scanned ${count} files`
    },
    classifySignals: {
      start: "Extracting repository signals",
      finish: (count: number) => `Processed ${count} files`
    },
    filterEvidence: {
      start: "Filtering evidence and noise",
      finish: (kept: number, rejected: number) => `Kept ${kept} evidence items and rejected ${rejected} noisy items`
    },
    inferRepository: {
      start: "Inferring repository type and business domain",
      finish: (repoType: string, domain: string) => `${repoType} / ${domain}`
    },
    reconstructBusiness: {
      start: "Reconstructing business objects and flows",
      finish: "Business model reconstructed"
    },
    draftReport: {
      start: "Drafting report sections",
      finish: "Report drafted"
    },
    qualityCheck: {
      start: "Running report quality checks",
      accepted: "Report quality accepted",
      rewrite: "Quality issues detected; deep dive requested"
    },
    deepDive: {
      start: "Deepening low-confidence areas",
      finish: (count: number) => `Deepened ${count} files`
    },
    finalizeReport: {
      start: "Finalizing repository report"
    }
  };
}
