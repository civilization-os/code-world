# Code World

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![LangGraph](https://img.shields.io/badge/LangGraph-TS-1f8f6a.svg)](https://langchain-ai.github.io/langgraphjs/)
[![Local First](https://img.shields.io/badge/local--first-repository%20analysis-55d4bd.svg)](#local-first-boundary)

**Language:** English | [简体中文](./README.zh-CN.md)

Code World is an AI runtime for turning a local repository into an explorable code cognition graph.

It is not a README generator. It scans a local codebase, extracts evidence, reconstructs a structured understanding of the project, and renders that understanding as a runtime graph with domains, services, entities, flows, risks, evidence chains, and reasoning events.

## What It Does

Code World takes one input:

```text
path/to/local/repository
```

Then it builds:

- A repository scan with ignored runtime artifacts and generated files filtered out.
- A structured analysis result backed by file evidence.
- A `WorldModel` graph containing nodes, edges, evidence chains, reasoning events, and uncertainties.
- A technical report and business summary as secondary narrative layers.
- A runtime UI for exploring how the AI understands the codebase.

## Product Shape

The main product surface is a graph-first runtime space:

- **Graph Canvas**: the primary view of the reconstructed code world.
- **World Index**: a lightweight index for domains, services, flows, entities, and evidence.
- **Evidence Drawer**: code evidence, rationale, confidence, and related files for the selected node.
- **Cognitive Timeline**: the AI's analysis flow, including scanning, linking, verification, and report generation.
- **Workspace Context**: provider configuration, repository path, history, export, and rerun controls.

## Current Status

This project is in an early product stage.

The UI has moved toward an AI runtime workspace, but the deeper value depends on the semantic quality of the generated `WorldModel`. The current implementation creates the graph from structured analysis results. The next major step is making the model produce graph-native domain, service, dependency, event, and evidence-chain output directly.

## Architecture

```text
apps/
  api/          Node.js + TypeScript + Express + LangGraph
  web/          React + TypeScript + Vite + Three.js
scripts/
  check-encoding.mjs
```

Core backend flow:

```text
scan repository
  -> classify signals
  -> filter evidence
  -> infer repository type and domain
  -> reconstruct structured analysis
  -> quality check / deep dive
  -> build WorldModel
  -> render reports
```

Core frontend flow:

```text
Workspace Context
  -> Runtime Graph Canvas
  -> Evidence Drawer
  -> Cognitive Timeline
  -> Markdown narrative views
```

## WorldModel

The `WorldModel` is the internal graph contract between analysis and UI.

It contains:

- `nodes`: repository, domain, service, entity, flow, rule, risk, and evidence nodes.
- `edges`: contains, implements, uses, depends_on, evidenced_by, and raises_risk relations.
- `evidenceChains`: claim-to-file-to-node evidence mappings.
- `reasoningEvents`: timeline events that explain how the analysis formed.
- `uncertainties`: gaps and low-confidence areas that should not be treated as confirmed truth.

The goal is to make the UI explore this world model instead of reverse-engineering a graph from Markdown.

## Local First Boundary

Code World runs locally and analyzes repositories from local filesystem paths.

Important boundary:

- Repository scanning and storage are local.
- Job records, provider configuration, and generated artifacts are stored under `.repo-inspector/`.
- If a cloud model provider is configured, selected evidence snippets and metadata are sent to that provider for structured analysis.
- API keys are stored locally in `.repo-inspector/provider-config.json`.

Do not use this on confidential repositories unless the configured model provider is approved for that code.

## Model Providers

The app supports two API protocols:

- OpenAI-compatible
- Anthropic-compatible

The base URL is configurable. For example, OpenAI-compatible providers such as DeepSeek can use a custom base URL.

Example DeepSeek-style configuration:

```text
provider: openai
baseUrl: https://api.deepseek.com
model: deepseek-v4-flash
```

## Getting Started

Install dependencies:

```bash
npm install
```

Run the local app:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

The API server runs on:

```text
http://localhost:8787
```

Build:

```bash
npm run build
```

Check encoding safety:

```bash
npm run check:encoding
```

## Repository Records

Generated records are stored locally under:

```text
.repo-inspector/
```

This includes:

- job snapshots
- report records
- model provider config
- cached analysis artifacts

The directory is ignored by git.

## Development Notes

Useful scripts:

```bash
npm run dev
npm run build
npm run check:encoding
npm run start
npm run clean
```

The project uses npm workspaces:

```text
@repo-inspector/api
@repo-inspector/web
```

## Roadmap

- Make the model produce graph-native `WorldModel` output directly.
- Add stronger code evidence extraction for call chains, events, schemas, and state transitions.
- Improve graph exploration with better macro / meso / micro zoom behavior.
- Add code snippet viewer and evidence-chain drilldown.
- Add report export bundles with Markdown and JSON.
- Add regression fixtures for known repository types.

## License

MIT. See [LICENSE](./LICENSE).
