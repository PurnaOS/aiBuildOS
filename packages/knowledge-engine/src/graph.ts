import { baseArtifactId } from "./schema.js";

export interface GraphEdge {
  readonly from: string;
  readonly relationship: string;
  readonly to: string;
}

export interface GraphNode {
  readonly id: string;
  readonly type: string;
  readonly links: Record<string, string[]>;
}

/**
 * The artifact graph. Outbound edges come from each artifact's own `links:` map; inbound edges are a
 * reverse index of exactly the same edges — one direction is stored, the inverse is derived
 * (okf-conventions §4). Nothing here ever writes a backlink.
 *
 * Malformed `links:` shapes are tolerated rather than thrown on: OKF is permissively consumable, and
 * reporting the problem is the validator's job, not the graph's.
 */
export class ArtifactGraph {
  private readonly outEdges = new Map<string, GraphEdge[]>();
  private readonly inEdges = new Map<string, GraphEdge[]>();
  private readonly nodes = new Map<string, GraphNode>();

  constructor(nodes: readonly GraphNode[]) {
    for (const node of nodes) {
      const id = node.id.toUpperCase();
      this.nodes.set(id, node);

      for (const [relationship, targets] of Object.entries(node.links ?? {})) {
        if (!Array.isArray(targets)) continue;
        for (const target of targets) {
          if (typeof target !== "string") continue;
          const to = baseArtifactId(target).toUpperCase();
          const edge: GraphEdge = { from: id, relationship, to };
          push(this.outEdges, id, edge);
          push(this.inEdges, to, edge);
        }
      }
    }
  }

  has(id: string): boolean {
    return this.nodes.has(id.toUpperCase());
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id.toUpperCase());
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  /** This artifact's own `links:` entries. */
  outgoing(id: string, relationship?: string): GraphEdge[] {
    return filter(this.outEdges.get(id.toUpperCase()), relationship);
  }

  /** Who links to this artifact — the derived inverse. */
  incoming(id: string, relationship?: string): GraphEdge[] {
    return filter(this.inEdges.get(id.toUpperCase()), relationship);
  }
}

function push(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const existing = map.get(key);
  if (existing) existing.push(edge);
  else map.set(key, [edge]);
}

function filter(edges: GraphEdge[] | undefined, relationship?: string): GraphEdge[] {
  if (!edges) return [];
  return relationship ? edges.filter((edge) => edge.relationship === relationship) : [...edges];
}
