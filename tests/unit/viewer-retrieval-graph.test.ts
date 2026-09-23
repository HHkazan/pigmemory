import { describe, expect, it } from "vitest";

import {
  buildRetrievalGraph,
  candidateChannels,
  graphRelationshipLabel,
  lineagePath,
} from "../../viewer/src/retrieval-graph.js";

describe("viewer Hybrid retrieval graph", () => {
  it("builds a deduplicated evidence graph from persisted candidate paths", () => {
    const graph = buildRetrievalGraph([
      {
        id: 1,
        refKind: "skill",
        refId: "sk-1",
        summary: "Deploy safely",
        finalReturned: true,
        finalRank: 1,
        detail: {
          channels: ["graph"],
          lineageGraph: {
            provenance: "pigmemory_storage",
            evidenceRef: "skills:sk-1",
            seed: "trace:tr-1",
            seedChannels: ["fts"],
            hops: 2,
            path: ["trace:tr-1", "policy:po-1", "skill:sk-1"],
            edgePath: ["SUPPORTS", "CRYSTALLIZED_AS"],
            score: 0.81,
          },
        },
      },
      {
        id: 2,
        refKind: "world-model",
        refId: "wm-1",
        summary: "Deployment topology",
        finalReturned: false,
        detail: {
          channels: ["vec", "graph"],
          lineageGraph: {
            seed: "trace:tr-1",
            path: ["trace:tr-1", "policy:po-1", "world-model:wm-1"],
            edgePath: ["SUPPORTS", "ABSTRACTED_INTO"],
            score: 0.76,
          },
        },
      },
    ]);

    expect(graph.paths).toHaveLength(2);
    expect(graph.nodes.map((node) => node.key)).toEqual([
      "trace:tr-1",
      "policy:po-1",
      "world-model:wm-1",
      "skill:sk-1",
    ]);
    expect(graph.edges).toHaveLength(3);
    expect(graph.nodes.find((node) => node.key === "trace:tr-1")).toMatchObject({
      isSeed: true,
      candidatePathIds: ["1", "2"],
    });
    expect(graph.nodes.find((node) => node.key === "skill:sk-1")).toMatchObject({
      isReturned: true,
      summary: "Deploy safely",
    });
  });

  it("sanitizes malformed persisted detail instead of inventing a path", () => {
    const candidate = {
      refKind: "trace",
      refId: "tr-1",
      detail: { channels: ["fts", 3, "graph"], lineageGraph: { path: "not-an-array" } },
    };
    expect(candidateChannels(candidate)).toEqual(["fts", "graph"]);
    expect(lineagePath(candidate)).toBeNull();
    expect(buildRetrievalGraph([candidate])).toEqual({ nodes: [], edges: [], paths: [] });
  });

  it("renders deterministic relationship labels for the evidence trail", () => {
    expect(graphRelationshipLabel("SUPPORTS")).toBe("支撑策略");
    expect(graphRelationshipLabel("CRYSTALLIZED_AS")).toBe("结晶为技能");
  });
});
