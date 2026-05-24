export type LocaleCode = "en" | "zh-CN";

const STORAGE_KEY = "repo-inspector.locale";

export function normalizeLocale(value?: string | null): LocaleCode {
  if (!value) {
    return "en";
  }
  return value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function detectLocale(): LocaleCode {
  if (typeof window === "undefined") {
    return "en";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    return normalizeLocale(stored);
  }
  return normalizeLocale(window.navigator.language);
}

export function persistLocale(locale: LocaleCode): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, locale);
}

export function uiText(locale: LocaleCode) {
  if (locale === "zh-CN") {
    return {
      localeLabel: "语言",
      localeOptions: {
        en: "English",
        "zh-CN": "中文"
      },
      appTagline: "本地优先 · 认知世界生成",
      title: "仓库业务还原",
      heroCopy:
        "输入本地仓库路径后，系统会自动构建代码世界、关系流和证据网络，而不是只生成一份文档。",
      heroNoteStrong: "无人干预。",
      heroNoteTail: "React 负责呈现，LangGraph + TypeScript 负责认知分析。",
      repoPathTitle: "仓库路径",
      localOnly: "仅本地文件系统",
      modelConfigTitle: "模型配置",
      configPath: "本地存储：.repo-inspector/provider-config.json",
      provider: "协议",
      apiKey: "API 密钥",
      model: "模型",
      baseUrlLabel: "基础地址",
      endpoint: "检测链接",
      saveConfig: "保存配置",
      testConnection: "检测连接",
      loadModels: "获取模型列表",
      selectedModel: "已选模型",
      configSaved: "配置已保存",
      configLoaded: "配置已加载",
      testOk: "连接正常",
      testFail: "连接失败",
      repoPathLabel: "输入仓库路径",
      startAnalysis: "开始分析",
      analyzing: "分析中…",
      downloadMarkdown: "下载 Markdown",
      exportJson: "导出 JSON",
      exportMarkdown: "导出 Markdown",
      analysisTimeline: "AI 认知流",
      noJob: "还没有开始任何任务。",
      analysisSummary: "认知摘要",
      reportTitle: "认知世界",
      renderedLocally: "本地叙述层",
      reportViewTitle: "认知视图",
      reportViews: {
        combined: "总览",
        technical: "技术认知",
        business: "业务叙述"
      },
      historyTitle: "记忆层",
      loadingHistory: "加载历史中…",
      historyEmpty: "暂无历史记录",
      historyHint: (count: number) => `最近 ${count} 条记录`,
      revisionLabel: "第",
      originalRun: "原始记录",
      derivedFrom: "派生自",
      rerun: "重新生成",
      deleteRecord: "删除",
      deleteConfirm: "删除这条记录？",
      coreObjects: "核心节点",
      flows: "关系流",
      moduleMap: "模块世界",
      unknowns: "未确认",
      overviewTitle: "认知概览",
      repoType: "世界类型",
      businessDomain: "业务域",
      filesScanned: "扫描文件数",
      cache: "缓存",
      cacheHit: "命中",
      cacheMiss: "未命中",
      confidence: "置信度",
      unknownsCount: "未确认数",
      statusLabels: {
        queued: "排队中",
        running: "运行中",
        completed: "已完成",
        failed: "失败"
      },
      stageLabels: {
        scanRepo: "AI 正在建立索引",
        classifySignals: "AI 正在识别信号",
        filterEvidence: "AI 正在净化证据",
        inferRepository: "AI 正在推断世界边界",
        reconstructBusiness: "AI 正在组装业务认知",
        draftReport: "AI 正在生成叙述层",
        qualityCheck: "AI 正在验证认知一致性",
        deepDive: "AI 正在深挖未确认区域",
        finalizeReport: "AI 正在固化认知世界"
      },
      errors: {
        startFailed: "启动分析失败",
        analysisFailed: "分析失败，请查看左侧时间线中的错误详情。",
        network: "网络请求失败"
      },
      summaryDetail: {
        directories: "目录",
        cacheHits: "缓存命中",
        cacheMisses: "缓存未命中",
        qaPasses: "QA 检查",
        noUnknowns: "没有明显未确认项"
      }
    };
  }

  return {
    localeLabel: "Language",
    localeOptions: {
      en: "English",
      "zh-CN": "中文"
    },
    appTagline: "Local-first repository cognition",
    title: "Repository business reconstruction",
    heroCopy:
      "Point the system at a local repository path and it will build a code world, relation graph, and evidence network instead of a flat document.",
    heroNoteStrong: "No manual nodes.",
    heroNoteTail: "React for presentation, LangGraph + TypeScript for reasoning.",
    repoPathTitle: "Repository path",
    localOnly: "Local filesystem only",
    modelConfigTitle: "Model config",
    configPath: "Local storage: .repo-inspector/provider-config.json",
    provider: "Protocol",
    apiKey: "API key",
    model: "Model",
    baseUrlLabel: "Base URL",
    endpoint: "Detection link",
    saveConfig: "Save config",
    testConnection: "Test connection",
    loadModels: "Load models",
    selectedModel: "Selected model",
    configSaved: "Config saved",
    configLoaded: "Config loaded",
    testOk: "Connection OK",
    testFail: "Connection failed",
    repoPathLabel: "Enter a repository path",
    startAnalysis: "Start analysis",
    analyzing: "Analyzing…",
    downloadMarkdown: "Download markdown",
    exportJson: "Export JSON",
    exportMarkdown: "Export markdown",
    analysisTimeline: "AI cognition flow",
    noJob: "No job has started yet.",
    analysisSummary: "Cognition summary",
    reportTitle: "Cognition world",
    renderedLocally: "Narrative layer rendered locally",
    reportViewTitle: "Cognition views",
    reportViews: {
      combined: "Overview",
      technical: "Technical cognition",
      business: "Business narrative"
    },
    historyTitle: "Memory layer",
    loadingHistory: "Loading history…",
    historyEmpty: "No saved records yet",
    historyHint: (count: number) => `Latest ${count} records`,
    revisionLabel: "Revision",
    originalRun: "Original",
    derivedFrom: "Derived from",
    rerun: "Rerun",
    deleteRecord: "Delete",
    deleteConfirm: "Delete this record?",
    coreObjects: "Core nodes",
    flows: "Relation flows",
    moduleMap: "Module world",
    unknowns: "Unknowns",
    overviewTitle: "Cognition overview",
    repoType: "World type",
    businessDomain: "Business domain",
    filesScanned: "Files scanned",
    cache: "Cache",
    cacheHit: "Hit",
    cacheMiss: "Miss",
    confidence: "Confidence",
    unknownsCount: "Unknowns",
    statusLabels: {
      queued: "Queued",
      running: "Running",
      completed: "Completed",
      failed: "Failed"
    },
    stageLabels: {
      scanRepo: "AI is building an index",
      classifySignals: "AI is recognizing signals",
      filterEvidence: "AI is cleansing evidence",
      inferRepository: "AI is inferring world boundaries",
      reconstructBusiness: "AI is assembling business cognition",
      draftReport: "AI is drafting the narrative layer",
      qualityCheck: "AI is validating cognitive consistency",
      deepDive: "AI is deepening uncertain regions",
      finalizeReport: "AI is stabilizing the cognition world"
    },
    errors: {
      startFailed: "Failed to start analysis",
      analysisFailed: "Analysis failed. See the timeline for details.",
      network: "Network request failed"
    },
    summaryDetail: {
      directories: "directories",
      cacheHits: "cache hits",
      cacheMisses: "misses",
      qaPasses: "QA pass(es)",
      noUnknowns: "No major unknowns"
    }
  };
}
