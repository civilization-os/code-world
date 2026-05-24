import type {
  AnalysisStage,
  EvidenceItem,
  FileInsight,
  RepoScanResult,
  RepoTypePrediction,
  StructuredAnalysis,
  StructuredClaim,
  StructuredStatus,
  WorldEdgeKind,
  WorldModel,
  WorldModelEdge,
  WorldModelNode,
  WorldNodeKind,
  WorldNodeLevel
} from "../domain.js";

interface WorldModelInput {
  repoName: string;
  repoPath: string;
  scan: RepoScanResult;
  repoType: RepoTypePrediction;
  domain: RepoTypePrediction;
  structuredAnalysis: StructuredAnalysis;
  fileInsights: FileInsight[];
  generatedAt: string;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "node";
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function statusForConfidence(confidence: number): StructuredStatus {
  if (confidence >= 0.7) {
    return "confirmed";
  }
  if (confidence >= 0.45) {
    return "provisional";
  }
  return "unconfirmed";
}

function addNode(nodes: Map<string, WorldModelNode>, node: WorldModelNode): string {
  const baseId = node.id;
  let id = baseId;
  let suffix = 2;
  while (nodes.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  nodes.set(id, { ...node, id });
  return id;
}

function edgeId(kind: WorldEdgeKind, from: string, to: string): string {
  return `${kind}:${from}->${to}`;
}

function addEdge(edges: Map<string, WorldModelEdge>, edge: WorldModelEdge): void {
  if (!edges.has(edge.id)) {
    edges.set(edge.id, edge);
  }
}

function nodeFromClaim(
  prefix: string,
  kind: WorldNodeKind,
  level: WorldNodeLevel,
  claim: StructuredClaim,
  fallbackTags: string[] = []
): WorldModelNode {
  return {
    id: `${prefix}-${slug(claim.title)}`,
    kind,
    level,
    label: claim.title,
    description: claim.description,
    confidence: clamp(claim.confidence),
    status: claim.status,
    evidenceFiles: unique(claim.evidenceFiles),
    tags: unique([claim.status, ...fallbackTags])
  };
}

function evidenceNodeId(file: string): string {
  return `evidence-${slug(file)}`;
}

function buildReasoningEvent(
  index: number,
  stage: AnalysisStage,
  title: string,
  description: string,
  nodeIds: string[],
  evidenceFiles: string[],
  confidence: number,
  generatedAt: string
) {
  return {
    id: `reasoning-${index + 1}`,
    stage,
    title,
    description,
    nodeIds: unique(nodeIds),
    evidenceFiles: unique(evidenceFiles),
    confidence: clamp(confidence),
    timestamp: generatedAt
  };
}

export function buildWorldModel(input: WorldModelInput): WorldModel {
  const nodes = new Map<string, WorldModelNode>();
  const edges = new Map<string, WorldModelEdge>();
  const structured = input.structuredAnalysis;
  const generatedAt = input.generatedAt;

  const repositoryId = addNode(nodes, {
    id: "repository",
    kind: "repository",
    level: "macro",
    label: input.repoName,
    description: structured.technicalSummary.overview || input.repoType.label,
    confidence: clamp(Math.min(input.repoType.confidence, input.domain.confidence)),
    status: statusForConfidence(Math.min(input.repoType.confidence, input.domain.confidence)),
    evidenceFiles: unique([...structured.repoType.evidenceFiles, ...structured.technicalSummary.evidenceFiles]),
    tags: ["repository", input.repoType.label]
  });

  const domainId = addNode(nodes, {
    id: `domain-${slug(structured.domain.headline || input.domain.label)}`,
    kind: "domain",
    level: "macro",
    label: structured.domain.headline || input.domain.label,
    description: structured.domain.overview || input.domain.label,
    confidence: clamp(structured.domain.confidence || input.domain.confidence),
    status: structured.domain.status || statusForConfidence(input.domain.confidence),
    evidenceFiles: unique(structured.domain.evidenceFiles),
    tags: unique(["domain", input.domain.label])
  });

  addEdge(edges, {
    id: edgeId("contains", repositoryId, domainId),
    from: repositoryId,
    to: domainId,
    kind: "contains",
    confidence: nodes.get(domainId)?.confidence ?? 0.5,
    rationale: "The repository-level analysis groups this domain under the current codebase.",
    evidenceFiles: nodes.get(domainId)?.evidenceFiles ?? []
  });

  const moduleIds = structured.modules.slice(0, 12).map((claim) => {
    const id = addNode(nodes, nodeFromClaim("service", "service", "meso", claim, ["service"]));
    addEdge(edges, {
      id: edgeId("implements", domainId, id),
      from: domainId,
      to: id,
      kind: "implements",
      confidence: clamp(claim.confidence),
      rationale: claim.rationale,
      evidenceFiles: unique(claim.evidenceFiles)
    });
    return id;
  });

  const entityIds = structured.entities.slice(0, 16).map((claim) => {
    const id = addNode(nodes, nodeFromClaim("entity", "entity", "meso", claim, ["entity"]));
    addEdge(edges, {
      id: edgeId("uses", domainId, id),
      from: domainId,
      to: id,
      kind: "uses",
      confidence: clamp(claim.confidence),
      rationale: claim.rationale,
      evidenceFiles: unique(claim.evidenceFiles)
    });
    return id;
  });

  const flowIds = structured.flows.slice(0, 12).map((claim) => {
    const id = addNode(nodes, nodeFromClaim("flow", "flow", "meso", claim, ["flow"]));
    addEdge(edges, {
      id: edgeId("implements", domainId, id),
      from: domainId,
      to: id,
      kind: "implements",
      confidence: clamp(claim.confidence),
      rationale: claim.rationale,
      evidenceFiles: unique(claim.evidenceFiles)
    });
    return id;
  });

  structured.rules.slice(0, 12).forEach((claim) => {
    const id = addNode(nodes, nodeFromClaim("rule", "rule", "micro", claim, ["rule"]));
    const target = flowIds[0] ?? domainId;
    addEdge(edges, {
      id: edgeId("uses", target, id),
      from: target,
      to: id,
      kind: "uses",
      confidence: clamp(claim.confidence),
      rationale: claim.rationale,
      evidenceFiles: unique(claim.evidenceFiles)
    });
  });

  structured.risks.slice(0, 8).forEach((claim) => {
    const id = addNode(nodes, nodeFromClaim("risk", "risk", "micro", claim, ["risk"]));
    addEdge(edges, {
      id: edgeId("raises_risk", domainId, id),
      from: domainId,
      to: id,
      kind: "raises_risk",
      confidence: clamp(claim.confidence),
      rationale: claim.rationale,
      evidenceFiles: unique(claim.evidenceFiles)
    });
  });

  const evidenceToNode = new Map<string, string>();
  const claimToNodes = [...moduleIds, ...entityIds, ...flowIds];
  const evidenceItems: EvidenceItem[] = structured.evidenceItems.length > 0
    ? structured.evidenceItems
    : input.fileInsights.slice(0, 12).map((insight) => ({
        claim: insight.summary,
        files: unique([insight.path, ...insight.evidence]),
        confidence: insight.confidence,
        notes: insight.signals.join("; ")
      }));

  evidenceItems.slice(0, 24).forEach((item, index) => {
    item.files.slice(0, 4).forEach((file) => {
      if (!evidenceToNode.has(file)) {
        const id = addNode(nodes, {
          id: evidenceNodeId(file),
          kind: "evidence",
          level: "micro",
          label: file,
          description: item.notes || item.claim,
          confidence: clamp(item.confidence),
          status: statusForConfidence(item.confidence),
          evidenceFiles: [file],
          tags: ["evidence"]
        });
        evidenceToNode.set(file, id);
      }
      const target = claimToNodes[index % Math.max(1, claimToNodes.length)] ?? domainId;
      const evidenceId = evidenceToNode.get(file)!;
      addEdge(edges, {
        id: edgeId("evidenced_by", target, evidenceId),
        from: target,
        to: evidenceId,
        kind: "evidenced_by",
        confidence: clamp(item.confidence),
        rationale: item.notes || item.claim,
        evidenceFiles: [file]
      });
    });
  });

  const allNodes = [...nodes.values()];
  const allEdges = [...edges.values()];
  const evidenceChains = evidenceItems.slice(0, 16).map((item, index) => ({
    id: `evidence-chain-${index + 1}`,
    claim: item.claim,
    nodeIds: allNodes
      .filter((node) => item.files.some((file) => node.evidenceFiles.includes(file)))
      .slice(0, 6)
      .map((node) => node.id),
    files: unique(item.files),
    confidence: clamp(item.confidence),
    reasoning: item.notes
  }));

  const reasoningEvents = [
    buildReasoningEvent(
      0,
      "scanRepo",
      "Repository boundary detected",
      `Scanned ${input.scan.files.length} files and ${input.scan.directories.length} directories.`,
      [repositoryId],
      input.scan.manifests.slice(0, 4),
      repositoryId ? nodes.get(repositoryId)!.confidence : 0.5,
      generatedAt
    ),
    buildReasoningEvent(
      1,
      "inferRepository",
      "Domain hypothesis formed",
      structured.domain.overview,
      [domainId],
      structured.domain.evidenceFiles,
      structured.domain.confidence,
      generatedAt
    ),
    buildReasoningEvent(
      2,
      "reconstructBusiness",
      "Business objects and flows reconstructed",
      structured.businessSummary.overview,
      [...entityIds.slice(0, 4), ...flowIds.slice(0, 4)],
      structured.businessSummary.evidenceFiles,
      structured.businessSummary.confidence,
      generatedAt
    ),
    buildReasoningEvent(
      3,
      "qualityCheck",
      "Evidence chains attached",
      `${evidenceChains.length} evidence chains are linked to the cognition graph.`,
      evidenceChains.flatMap((chain) => chain.nodeIds).slice(0, 8),
      evidenceChains.flatMap((chain) => chain.files).slice(0, 8),
      evidenceChains.length > 0 ? Math.min(...evidenceChains.map((chain) => chain.confidence)) : 0.5,
      generatedAt
    )
  ];

  return {
    version: 1,
    repoName: input.repoName,
    repoPath: input.repoPath,
    generatedAt,
    summary: structured.businessSummary.overview || structured.technicalSummary.overview || input.repoType.label,
    confidence: clamp(Math.min(structured.repoType.confidence, structured.domain.confidence, structured.technicalSummary.confidence)),
    nodes: allNodes,
    edges: allEdges,
    evidenceChains,
    reasoningEvents,
    uncertainties: unique([...structured.unknowns, ...structured.qaNotes])
  };
}
