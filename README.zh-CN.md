# Code World

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![LangGraph](https://img.shields.io/badge/LangGraph-TS-1f8f6a.svg)](https://langchain-ai.github.io/langgraphjs/)
[![Local First](https://img.shields.io/badge/local--first-repository%20analysis-55d4bd.svg)](#本地优先边界)

**语言:** [English](./README.md) | 简体中文

Code World 是一个面向本地代码仓库的 AI 认知运行空间。

它的目标不是简单生成 README，而是让 AI 基于代码证据形成一个可探索的项目认知图谱，包括业务域、服务、实体、流程、规则、风险、证据链和推理事件。

## 它解决什么问题

输入一个本地仓库路径：

```text
path/to/local/repository
```

系统会生成：

- 仓库扫描结果，并过滤运行痕迹、缓存、日志和生成物。
- 有证据支撑的结构化分析结果。
- `WorldModel` 认知图谱。
- 技术版报告和业务摘要。
- 可交互的图谱视图、证据抽屉和认知时间线。

## 产品形态

主界面以图谱为核心：

- **Graph Canvas**：项目认知世界的主视图。
- **World Index**：业务域、服务、实体、流程和证据的轻量索引。
- **Evidence Drawer**：当前节点的证据、依据、置信度和关联文件。
- **Cognitive Timeline**：AI 形成认知的过程。
- **Workspace Context**：模型配置、仓库路径、历史记录、导出和重新生成。

## 当前阶段

项目还处于早期产品阶段。

现在已经有 AI Runtime 风格的图谱界面，但真正的可用性取决于后端语义层质量。当前版本会从结构化分析结果构建 `WorldModel`。下一阶段应该让模型直接产出图谱原生的业务域、服务、依赖、事件和证据链。

## 架构

```text
apps/
  api/          Node.js + TypeScript + Express + LangGraph
  web/          React + TypeScript + Vite + Three.js
scripts/
  check-encoding.mjs
```

后端主流程：

```text
扫描仓库
  -> 提取信号
  -> 过滤证据
  -> 推断仓库类型和业务领域
  -> 还原结构化分析
  -> 质量检查 / 深度复扫
  -> 构建 WorldModel
  -> 生成报告
```

## 本地优先边界

Code World 在本地运行，并从本地文件系统读取仓库。

需要注意：

- 仓库扫描和记录存储在本地。
- 任务记录、模型配置和生成产物存放在 `.repo-inspector/`。
- 如果配置了云模型，系统会把筛选后的证据片段和元数据发送给对应模型服务。
- API Key 会保存在本地 `.repo-inspector/provider-config.json`。

如果仓库包含敏感代码，请先确认配置的模型服务是否允许接收这些代码片段。

## 模型配置

支持两种协议：

- OpenAI-compatible
- Anthropic-compatible

基础地址可以自定义。例如 DeepSeek 这类 OpenAI-compatible 服务可以这样配置：

```text
provider: openai
baseUrl: https://api.deepseek.com
model: deepseek-v4-flash
```

## 启动

安装依赖：

```bash
npm install
```

启动本地应用：

```bash
npm run dev
```

打开：

```text
http://localhost:5173
```

API 服务地址：

```text
http://localhost:8787
```

构建：

```bash
npm run build
```

编码检查：

```bash
npm run check:encoding
```

## 本地记录

生成记录存储在：

```text
.repo-inspector/
```

其中包括：

- 任务快照
- 报告记录
- 模型配置
- 分析缓存

该目录不会进入 git。

## 后续方向

- 让模型直接输出图谱原生 `WorldModel`。
- 增强调用链、事件、schema、状态流转等证据抽取。
- 改进 Macro / Meso / Micro 的图谱探索体验。
- 增加代码片段查看器和证据链钻取。
- 增加 Markdown / JSON 打包导出。
- 增加固定样本仓库做回归测试。

## License

MIT. See [LICENSE](./LICENSE).
