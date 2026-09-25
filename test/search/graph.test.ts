import { describe, it, expect, vi } from 'vitest';
import { ChunkIndex } from '../../src/index/chunk-index';
import { BruteForceVectorStore } from '../../src/index/vector-store';
import {
	buildContextGraph,
	maxNoteSimilarity,
	type GraphSeed,
	type GraphLinkResolver,
} from '../../src/search/graph';
import type { Embedder } from '../../src/embed/embedder';

function unitVector(dim: number, index: number): Float32Array {
	const vec = new Float32Array(dim);
	vec[index] = 1;
	return vec;
}

function blendVectors(v1: Float32Array, v2: Float32Array, w1 = 0.5, w2 = 0.5): Float32Array {
	const dim = v1.length;
	const out = new Float32Array(dim);
	let norm = 0;
	for (let i = 0; i < dim; i++) {
		out[i] = (v1[i] ?? 0) * w1 + (v2[i] ?? 0) * w2;
		norm += (out[i] ?? 0) * (out[i] ?? 0);
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < dim; i++) {
		out[i] = (out[i] ?? 0) / norm;
	}
	return out;
}

describe('graph data layer', () => {
	const dim = 4;

	describe('maxNoteSimilarity', () => {
		it('returns -1 for empty vector sets', () => {
			expect(maxNoteSimilarity([], [])).toBe(-1);
			expect(maxNoteSimilarity([unitVector(dim, 0)], [])).toBe(-1);
		});

		it('finds the maximum cosine similarity between two sets of vectors', () => {
			const a1 = unitVector(dim, 0); // [1, 0, 0, 0]
			const a2 = unitVector(dim, 1); // [0, 1, 0, 0]

			const b1 = blendVectors(unitVector(dim, 0), unitVector(dim, 2), 0.9, 0.1);
			const b2 = unitVector(dim, 3);

			// dot(a1, b1) is high (~0.99), dot(a1, b2) is 0, dot(a2, b1) is 0, dot(a2, b2) is 0
			const sim = maxNoteSimilarity([a1, a2], [b1, b2]);
			expect(sim).toBeGreaterThan(0.9);
			expect(sim).toBeLessThanOrEqual(1.0);
		});
	});

	describe('buildContextGraph with note seed', () => {
		it('constructs a strict hub-and-spoke star topology with sneakPeek connections and no hop 2 nodes', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));

			// Setup 5 notes:
			// Seed: Alpha (direction 0)
			// Hop 1: Beta (very close to direction 0)
			// Related to Beta: Gamma, Omega, N1, N2, N3
			// Unrelated: Delta (orthogonal direction 3)
			const v0 = unitVector(dim, 0);
			const vBeta = blendVectors(v0, unitVector(dim, 1), 0.9, 0.1); // sim to Alpha ~ 0.99
			const vGamma = blendVectors(vBeta, unitVector(dim, 2), 0.85, 0.15); // sim to Beta ~ 0.98
			const vOmega = blendVectors(vBeta, unitVector(dim, 3), 0.8, 0.2); // sim to Beta ~ 0.97
			const vN1 = blendVectors(vBeta, unitVector(dim, 1), 0.88, 0.12);
			const vN2 = blendVectors(vBeta, unitVector(dim, 2), 0.86, 0.14);
			const vN3 = blendVectors(vBeta, unitVector(dim, 3), 0.84, 0.16);
			const vDelta = unitVector(dim, 3); // sim to Alpha ~ 0

			await index.updateFile(
				'Alpha.md',
				[{ filePath: 'Alpha.md', headingPath: [], titleContext: 'Alpha', text: 'Alpha text' }],
				async () => [v0],
			);
			await index.updateFile(
				'Beta.md',
				[{ filePath: 'Beta.md', headingPath: [], titleContext: 'Beta', text: 'Beta text' }],
				async () => [vBeta],
			);
			await index.updateFile(
				'Gamma.md',
				[{ filePath: 'Gamma.md', headingPath: [], titleContext: 'Gamma', text: 'Gamma text' }],
				async () => [vGamma],
			);
			await index.updateFile(
				'Omega.md',
				[{ filePath: 'Omega.md', headingPath: [], titleContext: 'Omega', text: 'Omega text' }],
				async () => [vOmega],
			);
			await index.updateFile(
				'N1.md',
				[{ filePath: 'N1.md', headingPath: [], titleContext: 'N1', text: 'N1 text' }],
				async () => [vN1],
			);
			await index.updateFile(
				'N2.md',
				[{ filePath: 'N2.md', headingPath: [], titleContext: 'N2', text: 'N2 text' }],
				async () => [vN2],
			);
			await index.updateFile(
				'N3.md',
				[{ filePath: 'N3.md', headingPath: [], titleContext: 'N3', text: 'N3 text' }],
				async () => [vN3],
			);
			await index.updateFile(
				'Delta.md',
				[{ filePath: 'Delta.md', headingPath: [], titleContext: 'Delta', text: 'Delta text' }],
				async () => [vDelta],
			);

			const seed: GraphSeed = { type: 'note', path: 'Alpha.md' };
			const graph = await buildContextGraph(index, seed, {
				graphHop1Count: 1,
				graphHop2Count: 5,
				graphSimilarityThreshold: 0.8,
			});

			expect(graph.seed).toEqual(seed);

			// Nodes should contain Alpha (hop 0), Beta (hop 1), and 2-hop satellites
			const alphaNode = graph.nodes.find((n) => n.id === 'Alpha.md');
			expect(alphaNode?.isSeed).toBe(true);
			expect(alphaNode?.hop).toBe(0);

			const betaNode = graph.nodes.find((n) => n.id === 'Beta.md');
			expect(betaNode?.isSeed).toBe(false);
			expect(betaNode?.hop).toBe(1);

			// 2-hop satellites tethered to Beta
			const hop2Nodes = graph.nodes.filter((n) => n.hop === 2);
			expect(hop2Nodes.length).toBeGreaterThanOrEqual(1);
			for (const h2 of hop2Nodes) {
				expect(h2.parentId).toBe('Beta.md');
				expect(h2.radius).toBe(4.5);
			}

			// Sneak peek data: Beta contains top related note titles up to 5
			expect(betaNode?.sneakPeek).toBeDefined();
			expect(betaNode?.sneakPeek?.length).toBe(5);
			expect(betaNode?.sneakPeek).toContain('Gamma');
			expect(betaNode?.sneakPeek).toContain('Omega');
			expect(betaNode?.sneakPeek).not.toContain('Alpha');
			expect(betaNode?.sneakPeek).not.toContain('Beta');

			// Check edges: primary seed edge (Alpha <-> Beta) and secondary edges
			const seedEdge = graph.edges.find(
				(e) =>
					(e.source === 'Alpha.md' && e.target === 'Beta.md') ||
					(e.source === 'Beta.md' && e.target === 'Alpha.md'),
			);
			expect(seedEdge).toBeDefined();
			expect(seedEdge?.isSecondary).toBe(false);

			const secondaryEdges = graph.edges.filter((e) => e.isSecondary);
			expect(secondaryEdges.length).toBe(hop2Nodes.length);
		});

		it('removes all peer cross-edges between hop 1 nodes to maintain strict star topology', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));

			const v0 = unitVector(dim, 0);
			const vBeta = blendVectors(v0, unitVector(dim, 1), 0.9, 0.1);
			const vZeta = blendVectors(v0, unitVector(dim, 1), 0.88, 0.12); // also very close to Beta

			await index.updateFile('Alpha.md', [{ filePath: 'Alpha.md', headingPath: [], titleContext: 'Alpha', text: 'Alpha text' }], async () => [v0]);
			await index.updateFile('Beta.md', [{ filePath: 'Beta.md', headingPath: [], titleContext: 'Beta', text: 'Beta text' }], async () => [vBeta]);
			await index.updateFile('Zeta.md', [{ filePath: 'Zeta.md', headingPath: [], titleContext: 'Zeta', text: 'Zeta text' }], async () => [vZeta]);

			const graph = await buildContextGraph(index, { type: 'note', path: 'Alpha.md' }, {
				graphHop1Count: 2,
				graphHop2Count: 0,
				graphSimilarityThreshold: 0.8,
			});

			expect(graph.nodes.map((n) => n.id).sort()).toEqual(['Alpha.md', 'Beta.md', 'Zeta.md']);

			// Both connect to Alpha, but Beta and Zeta MUST NOT have a peer cross-edge
			expect(graph.edges.length).toBe(2);
			for (const edge of graph.edges) {
				const isSeedEdge = edge.source === 'Alpha.md' || edge.target === 'Alpha.md';
				expect(isSeedEdge).toBe(true);
			}
			const crossEdge = graph.edges.find((e) =>
				(e.source === 'Beta.md' && e.target === 'Zeta.md') ||
				(e.source === 'Zeta.md' && e.target === 'Beta.md')
			);
			expect(crossEdge).toBeUndefined();
		});

		it('handles non-existent seed note gracefully', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));
			const seed: GraphSeed = { type: 'note', path: 'NonExistent.md' };
			const graph = await buildContextGraph(index, seed, {
				graphHop1Count: 5,
				graphHop2Count: 3,
				graphSimilarityThreshold: 0.75,
			});

			expect(graph.nodes.length).toBe(0);
			expect(graph.edges.length).toBe(0);
		});
	});

	describe('buildContextGraph with query seed', () => {
		it('embeds query and seeds graph with query node at hop 0', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));

			const v0 = unitVector(dim, 0);
			const v1 = blendVectors(v0, unitVector(dim, 1), 0.9, 0.1);

			await index.updateFile(
				'Alpha.md',
				[{ filePath: 'Alpha.md', headingPath: [], titleContext: 'Alpha', text: 'Alpha text' }],
				async () => [v0],
			);
			await index.updateFile(
				'Beta.md',
				[{ filePath: 'Beta.md', headingPath: [], titleContext: 'Beta', text: 'Beta text' }],
				async () => [v1],
			);

			const embedQueryMock = vi.fn().mockResolvedValue(v0);
			const mockEmbedder: Embedder = {
				dimensions: dim,
				embedDocuments: vi.fn(),
				embedQuery: embedQueryMock,
			};

			const seed: GraphSeed = { type: 'query', query: 'quantum computing' };
			const graph = await buildContextGraph(
				index,
				seed,
				{
					graphHop1Count: 2,
					graphHop2Count: 0,
					graphSimilarityThreshold: 0.75,
				},
				mockEmbedder,
			);

			expect(embedQueryMock).toHaveBeenCalledWith('quantum computing');

			const queryNode = graph.nodes.find((n) => n.id === '__query__');
			expect(queryNode).toBeDefined();
			expect(queryNode?.isSeed).toBe(true);
			expect(queryNode?.hop).toBe(0);
			expect(queryNode?.label).toBe('"quantum computing"');

			const alphaNode = graph.nodes.find((n) => n.id === 'Alpha.md');
			expect(alphaNode).toBeDefined();
			expect(alphaNode?.sneakPeek).toBeDefined();
			expect(alphaNode?.sneakPeek).toContain('Beta');

			// All edges connect to __query__
			expect(graph.edges.length).toBe(2);
			for (const edge of graph.edges) {
				const isSeedEdge = edge.source === '__query__' || edge.target === '__query__';
				expect(isSeedEdge).toBe(true);
			}
		});
	});

	describe('buildContextGraph wikilink overlay', () => {
		it('promotes seed wikilinks as orbit nodes with directional edges', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));
			const v0 = unitVector(dim, 0);
			await index.updateFile(
				'Alpha.md',
				[{ filePath: 'Alpha.md', headingPath: [], titleContext: 'Alpha', text: 'Alpha text' }],
				async () => [v0],
			);

			const links: GraphLinkResolver = {
				outgoing: (p) => {
					if (p === 'Alpha.md') return ['Linked.md'];
					if (p === 'Backlink.md') return ['Alpha.md'];
					return [];
				},
				incoming: (p) => (p === 'Alpha.md' ? ['Backlink.md'] : []),
			};

			const graph = await buildContextGraph(
				index,
				{ type: 'note', path: 'Alpha.md' },
				{ graphHop1Count: 0, graphHop2Count: 0, graphSimilarityThreshold: 0.8 },
				undefined,
				undefined,
				links,
			);

			const linkedNode = graph.nodes.find((n) => n.id === 'Linked.md');
			expect(linkedNode?.viaLink).toBe(true);
			expect(linkedNode?.linkDirection).toBe('out');

			const backlinkNode = graph.nodes.find((n) => n.id === 'Backlink.md');
			expect(backlinkNode?.viaLink).toBe(true);
			expect(backlinkNode?.linkDirection).toBe('in');

			const outEdge = graph.edges.find(
				(e) => e.id === ['Alpha.md', 'Linked.md'].sort().join('---'),
			);
			expect(outEdge?.wikiLink).toBe('forward');

			const inEdge = graph.edges.find(
				(e) => e.id === ['Alpha.md', 'Backlink.md'].sort().join('---'),
			);
			expect(inEdge?.wikiLink).toBe('back');
		});

		it('marks a semantic note as dual when it is also wikilinked', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));
			const v0 = unitVector(dim, 0);
			const vBeta = blendVectors(v0, unitVector(dim, 1), 0.9, 0.1);
			await index.updateFile(
				'Alpha.md',
				[{ filePath: 'Alpha.md', headingPath: [], titleContext: 'Alpha', text: 'Alpha text' }],
				async () => [v0],
			);
			await index.updateFile(
				'Beta.md',
				[{ filePath: 'Beta.md', headingPath: [], titleContext: 'Beta', text: 'Beta text' }],
				async () => [vBeta],
			);

			const links: GraphLinkResolver = {
				outgoing: (p) => (p === 'Alpha.md' ? ['Beta.md'] : []),
				incoming: () => [],
			};

			const graph = await buildContextGraph(
				index,
				{ type: 'note', path: 'Alpha.md' },
				{ graphHop1Count: 5, graphHop2Count: 0, graphSimilarityThreshold: 0.8 },
				undefined,
				undefined,
				links,
			);

			const betaNode = graph.nodes.find((n) => n.id === 'Beta.md');
			expect(betaNode?.viaLink).toBeUndefined();
			expect(betaNode?.linkDirection).toBe('out');

			const seedEdge = graph.edges.find(
				(e) => e.id === ['Alpha.md', 'Beta.md'].sort().join('---'),
			);
			expect(seedEdge?.wikiLink).toBe('forward');
			expect(seedEdge?.similarity).toBeDefined();
		});

		it('does not overlay wikilinks for query seeds', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));
			const v0 = unitVector(dim, 0);
			await index.updateFile(
				'Alpha.md',
				[{ filePath: 'Alpha.md', headingPath: [], titleContext: 'Alpha', text: 'Alpha text' }],
				async () => [v0],
			);

			const links: GraphLinkResolver = {
				outgoing: () => ['Beta.md'],
				incoming: () => [],
			};
			const embedQueryMock = vi.fn().mockResolvedValue(v0);
			const mockEmbedder: Embedder = {
				dimensions: dim,
				embedDocuments: vi.fn(),
				embedQuery: embedQueryMock,
			};

			const graph = await buildContextGraph(
				index,
				{ type: 'query', query: 'x' },
				{ graphHop1Count: 5, graphHop2Count: 0, graphSimilarityThreshold: 0.8 },
				mockEmbedder,
				undefined,
				links,
			);

			expect(graph.nodes.some((n) => n.viaLink)).toBe(false);
			expect(graph.edges.some((e) => e.wikiLink)).toBe(false);
		});

		it('does not connect wikilinks between non-seed neighbors', async () => {
			const index = new ChunkIndex(new BruteForceVectorStore(dim));
			const v0 = unitVector(dim, 0);
			await index.updateFile(
				'Alpha.md',
				[{ filePath: 'Alpha.md', headingPath: [], titleContext: 'Alpha', text: 'Alpha text' }],
				async () => [v0],
			);

			// Alpha links to B and C; B also links to C. Only Alpha's links
			// should surface — never the B↔C neighbor link.
			const links: GraphLinkResolver = {
				outgoing: (p) => {
					if (p === 'Alpha.md') return ['B.md', 'C.md'];
					if (p === 'B.md') return ['C.md'];
					return [];
				},
				incoming: () => [],
			};

			const graph = await buildContextGraph(
				index,
				{ type: 'note', path: 'Alpha.md' },
				{ graphHop1Count: 0, graphHop2Count: 0, graphSimilarityThreshold: 0.8 },
				undefined,
				undefined,
				links,
			);

			const bNode = graph.nodes.find((n) => n.id === 'B.md');
			const cNode = graph.nodes.find((n) => n.id === 'C.md');
			expect(bNode?.viaLink).toBe(true);
			expect(cNode?.viaLink).toBe(true);

			const neighborEdge = graph.edges.find(
				(e) => e.id === ['B.md', 'C.md'].sort().join('---'),
			);
			expect(neighborEdge).toBeUndefined();

			// Only seed→B and seed→C wikilink edges exist.
			const wikiEdges = graph.edges.filter((e) => e.wikiLink);
			expect(wikiEdges.length).toBe(2);
			for (const edge of wikiEdges) {
				expect([edge.source, edge.target]).toContain('Alpha.md');
			}
		});
	});
});
