import cors from "cors";
import express from "express";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { AnalysisCache } from "./cache.js";
import { createAnalysisGraph, runAnalysisJob } from "./analysis/graph.js";
import { JobStore } from "./jobStore.js";
import { apiText, normalizeLocale } from "./i18n.js";
import { DEFAULT_PROVIDER_CONFIG, ProviderConfigStore, testProviderConnection } from "./providerConfig.js";
import { workspaceRootDir } from "./runtimePaths.js";

const createJobSchema = z.object({
  repoPath: z.string().min(1),
  locale: z.string().optional()
});

const rerunJobSchema = z.object({
  locale: z.string().optional()
});

const providerConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  apiKey: z.string().optional().default(""),
  baseUrl: z.string().optional().default(""),
  model: z.string().optional().default("")
});

export interface ServerContext {
  app: express.Express;
  jobStore: JobStore;
  cache: AnalysisCache;
  providerConfig: ProviderConfigStore;
  graph: ReturnType<typeof createAnalysisGraph>;
}

export function createApp(): ServerContext {
  const app = express();
  const jobStore = new JobStore();
  const cache = new AnalysisCache();
  const providerConfig = new ProviderConfigStore();
  const graph = createAnalysisGraph(jobStore, cache, providerConfig);

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/provider-config", async (req, res) => {
    const locale = normalizeLocale(req.headers["accept-language"]?.toString());
    const current = await providerConfig.load();
    res.json({
      config: current,
      endpoint: current.baseUrl,
      supportedProviders: ["openai", "anthropic"],
      message: current.apiKey ? apiText(locale).providerConfigSaved : apiText(locale).providerConfigNotFound
    });
  });

  app.put("/api/provider-config", async (req, res) => {
    const parsed = providerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      const locale = normalizeLocale(req.body?.locale ?? req.headers["accept-language"]?.toString());
      res.status(400).json({ error: apiText(locale).invalidRequest, details: parsed.error.flatten() });
      return;
    }

    const saved = await providerConfig.save({
      provider: parsed.data.provider,
      apiKey: parsed.data.apiKey ?? "",
      baseUrl: parsed.data.baseUrl ?? "",
      model: parsed.data.model ?? "",
      updatedAt: new Date().toISOString()
    });
    res.json({
      config: saved,
      endpoint: saved.baseUrl,
      message: apiText(normalizeLocale(req.headers["accept-language"]?.toString())).providerConfigSaved
    });
  });

  app.post("/api/provider-config/test", async (req, res) => {
    const locale = normalizeLocale(req.body?.locale ?? req.headers["accept-language"]?.toString());
    const parsed = providerConfigSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: apiText(locale).invalidRequest, details: parsed.error.flatten() });
      return;
    }

    const current = await providerConfig.load();
    const candidate = {
      provider: parsed.data.provider ?? current.provider ?? DEFAULT_PROVIDER_CONFIG.provider,
      apiKey: parsed.data.apiKey ?? current.apiKey ?? "",
      baseUrl: parsed.data.baseUrl ?? current.baseUrl ?? DEFAULT_PROVIDER_CONFIG.baseUrl,
      model: parsed.data.model ?? current.model ?? ""
    };

    try {
      const result = await testProviderConnection({
        provider: candidate.provider,
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        updatedAt: new Date().toISOString()
      });
      res.json({ result });
    } catch (error) {
      res.status(400).json({
        error: apiText(locale).providerTestFailed,
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/jobs", async (req, res) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      const locale = normalizeLocale(req.body?.locale ?? req.headers["accept-language"]?.toString());
      res.status(400).json({ error: apiText(locale).invalidRequest, details: parsed.error.flatten() });
      return;
    }

    const locale = normalizeLocale(parsed.data.locale ?? req.headers["accept-language"]?.toString());
    const repoPath = path.resolve(parsed.data.repoPath);
    if (!existsSync(repoPath)) {
      res.status(404).json({ error: apiText(locale).repoNotFound });
      return;
    }

    const stats = statSync(repoPath);
    if (!stats.isDirectory()) {
      res.status(400).json({ error: apiText(locale).repoMustBeDirectory });
      return;
    }

    const job = jobStore.create(repoPath, locale);
    void (async () => {
      try {
        await runAnalysisJob(graph, jobStore, job.id, repoPath);
      } catch (error) {
        jobStore.fail(job.id, error);
      }
    })();

    res.status(202).json({ job });
  });

  app.get("/api/jobs", (req, res) => {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    const jobs = jobStore.list(Number.isFinite(limit) ? limit : 20);
    res.json({ jobs });
  });

  app.post("/api/jobs/:id/rerun", async (req, res) => {
    const parsed = rerunJobSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const locale = normalizeLocale(req.body?.locale ?? req.headers["accept-language"]?.toString());
      res.status(400).json({ error: apiText(locale).invalidRequest, details: parsed.error.flatten() });
      return;
    }

    const current = jobStore.snapshot(req.params.id);
    if (!current) {
      const locale = normalizeLocale(req.headers["accept-language"]?.toString());
      res.status(404).json({ error: apiText(locale).jobNotFound });
      return;
    }

    const locale = normalizeLocale(parsed.data.locale ?? current.locale);
    const job = jobStore.rerunFrom(current.id, { locale });
    void (async () => {
      try {
        await runAnalysisJob(graph, jobStore, job.id, job.repoPath, {
          forceFresh: true
        });
      } catch (error) {
        jobStore.fail(job.id, error);
      }
    })();

    res.status(202).json({ job });
  });

  app.delete("/api/jobs/:id", async (req, res) => {
    const current = jobStore.snapshot(req.params.id);
    if (!current) {
      const locale = normalizeLocale(req.headers["accept-language"]?.toString());
      res.status(404).json({ error: apiText(locale).jobNotFound });
      return;
    }

    if (current.status === "queued" || current.status === "running") {
      res.status(409).json({ error: "Active jobs cannot be deleted" });
      return;
    }

    try {
      await jobStore.delete(current.id);
      res.json({ ok: true });
    } catch (error) {
      const locale = normalizeLocale(req.headers["accept-language"]?.toString());
      res.status(500).json({
        error: error instanceof Error ? error.message : apiText(locale).internalServerError
      });
    }
  });

  app.get("/api/jobs/:id", (req, res) => {
    const snapshot = jobStore.snapshot(req.params.id);
    if (!snapshot) {
      const locale = normalizeLocale(req.headers["accept-language"]?.toString());
      res.status(404).json({ error: apiText(locale).jobNotFound });
      return;
    }
    res.json({ job: snapshot });
  });

  app.get("/api/jobs/:id/report", (req, res) => {
    const snapshot = jobStore.snapshot(req.params.id);
    if (!snapshot || !snapshot.analysis) {
      const locale = normalizeLocale(snapshot?.locale ?? req.headers["accept-language"]?.toString());
      res.status(404).json({ error: apiText(locale).reportNotReady });
      return;
    }

    const view = typeof req.query.view === "string" ? req.query.view : "combined";
    const analysis = snapshot.analysis;
    const markdown =
      view === "technical"
        ? analysis.technicalMarkdown
        : view === "business"
          ? analysis.businessMarkdown
          : analysis.reportMarkdown;

    res.json({
      markdown,
      technicalMarkdown: analysis.technicalMarkdown,
      businessMarkdown: analysis.businessMarkdown,
      reportMarkdown: analysis.reportMarkdown,
      analysis
    });
  });

  app.get("/api/jobs/:id/export", (req, res) => {
    const snapshot = jobStore.snapshot(req.params.id);
    if (!snapshot || !snapshot.analysis) {
      const locale = normalizeLocale(snapshot?.locale ?? req.headers["accept-language"]?.toString());
      res.status(404).json({ error: apiText(locale).reportNotReady });
      return;
    }

    const format = typeof req.query.format === "string" ? req.query.format : "json";
    const view = typeof req.query.view === "string" ? req.query.view : "combined";
    const analysis = snapshot.analysis;
    const markdown =
      view === "technical"
        ? analysis.technicalMarkdown
        : view === "business"
          ? analysis.businessMarkdown
          : analysis.reportMarkdown;

    if (format === "markdown") {
      res.type("text/markdown").send(markdown);
      return;
    }

    res.type("application/json").send(
      JSON.stringify(
        {
          job: snapshot,
          view,
          markdown,
          analysis
        },
        null,
        2
      )
    );
  });

  app.get("/api/jobs/:id/report.md", (req, res) => {
    const snapshot = jobStore.snapshot(req.params.id);
    if (!snapshot || !snapshot.analysis) {
      const locale = normalizeLocale(snapshot?.locale ?? req.headers["accept-language"]?.toString());
      res.status(404).send(apiText(locale).reportNotReady);
      return;
    }

    const view = typeof req.query.view === "string" ? req.query.view : "combined";
    const analysis = snapshot.analysis;
    const markdown =
      view === "technical"
        ? analysis.technicalMarkdown
        : view === "business"
          ? analysis.businessMarkdown
          : analysis.reportMarkdown;

    res.type("text/markdown").send(markdown);
  });

  app.get("/api/jobs/:id/events", (req, res) => {
    const snapshot = jobStore.snapshot(req.params.id);
    if (!snapshot) {
      res.status(404).end();
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, payload: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send("snapshot", snapshot);
    const unsubscribe = jobStore.onUpdate(snapshot.id, (nextSnapshot) => {
      send("snapshot", nextSnapshot);
      if (nextSnapshot.status === "completed" || nextSnapshot.status === "failed") {
        send("done", { status: nextSnapshot.status });
      }
    });

    const keepAlive = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });

  const webDist = path.resolve(workspaceRootDir(), "apps/web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        next();
        return;
      }
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const locale = normalizeLocale(req.headers["accept-language"]?.toString());
    const message = error instanceof Error ? error.message : apiText(locale).internalServerError;
    res.status(500).json({ error: message });
  });

  return { app, jobStore, cache, providerConfig, graph };
}

export function startServer(port = Number(process.env.PORT ?? 8787)): void {
  const { app } = createApp();
  app.listen(port, () => {
    console.log(`Repo inspector server listening on http://localhost:${port}`);
  });
}
