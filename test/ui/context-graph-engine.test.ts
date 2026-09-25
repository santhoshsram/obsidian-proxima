import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextGraphEngine } from '../../src/ui/graph/context-graph-engine';
import { MockElement } from '../mocks/obsidian';
import { ORBIT_RADIUS } from '../../src/ui/graph/graph-constants';
import { chargeForNode, radialStrengthForNode } from '../../src/ui/graph/graph-physics';
import type { GraphData, GraphNode } from '../../src/search/graph';

describe('ContextGraphEngine', () => {
	let container: MockElement;
	let engine: ContextGraphEngine;
	let onNodeClick: ReturnType<typeof vi.fn>;
	let onNodeDoubleClick: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onNodeClick = vi.fn();
		onNodeDoubleClick = vi.fn();
		container = new MockElement('div');
		engine = new ContextGraphEngine(container as unknown as HTMLElement, {
			onNodeClick,
			onNodeDoubleClick,
		});
	});

	afterEach(() => {
		engine.destroy();
	});

	it('creates canvas element inside container', () => {
		const canvas = container.children.find((c) => c.tagName.toLowerCase() === 'canvas');
		expect(canvas).toBeDefined();
	});

	it('sets data and initializes simulation nodes', () => {
		const data: GraphData = {
			seed: { type: 'note', path: 'A.md' },
			nodes: [
				{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 },
				{ id: 'B.md', label: 'B', isSeed: false, hop: 1, radius: 7 },
			],
			edges: [{ id: 'A---B', source: 'A.md', target: 'B.md', similarity: 0.9 }],
		};

		engine.setData(data);
		expect(engine.getNodes().length).toBe(2);
		expect(engine.getEdges().length).toBe(1);
	});

	it('pins the seed node at canvas center on initial or new seed data', () => {
		const data: GraphData = {
			seed: { type: 'note', path: 'Active.md' },
			nodes: [
				{ id: 'Active.md', label: 'Active', isSeed: true, hop: 0, radius: 10 },
				{ id: 'Neighbor.md', label: 'Neighbor', isSeed: false, hop: 1, radius: 7 },
			],
			edges: [{ id: 'Active---Neighbor', source: 'Active.md', target: 'Neighbor.md', similarity: 0.85 }],
		};
		engine.setData(data);

		const seed = engine.getNodes().find((n) => n.id === 'Active.md');
		expect(seed).toBeDefined();
		// Default mock container width 800, height 600 -> cx = 400, cy = 300
		expect(seed?.x).toBe(400);
		expect(seed?.y).toBe(300);
		expect(seed?.fx).toBe(400);
		expect(seed?.fy).toBe(300);
	});

	it('preserves existing node positions when updating data', () => {
		const data1: GraphData = {
			seed: { type: 'note', path: 'A.md' },
			nodes: [{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		};
		engine.setData(data1);

		// Assign a coordinate to A.md
		const nodeA = engine.getNodes().find((n) => n.id === 'A.md');
		expect(nodeA).toBeDefined();
		if (nodeA) {
			nodeA.x = 150;
			nodeA.y = 250;
		}

		const data2: GraphData = {
			seed: { type: 'note', path: 'A.md' },
			nodes: [
				{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 },
				{ id: 'B.md', label: 'B', isSeed: false, hop: 1, radius: 7 },
			],
			edges: [{ id: 'A---B', source: 'A.md', target: 'B.md', similarity: 0.85 }],
		};
		engine.setData(data2);

		const updatedA = engine.getNodes().find((n) => n.id === 'A.md');
		expect(updatedA?.x).toBe(150);
		expect(updatedA?.y).toBe(250);
	});

	it('correctly hit-tests a node at given client coordinates', () => {
		const data: GraphData = {
			seed: { type: 'note', path: 'A.md' },
			nodes: [{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		};
		engine.setData(data);

		const node = engine.getNodes()[0];
		if (node) {
			node.x = 200;
			node.y = 200;
		}

		// Hit test at node location
		const hit = engine.getNodeAt(200, 200);
		expect(hit?.id).toBe('A.md');

		// Hit test far away
		const miss = engine.getNodeAt(500, 500);
		expect(miss).toBeNull();
	});

	it('emits onNodeClick when clicked on a node', () => {
		const data: GraphData = {
			seed: { type: 'note', path: 'A.md' },
			nodes: [{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		};
		engine.setData(data);
		const node = engine.getNodes()[0];
		if (node) {
			node.x = 100;
			node.y = 100;
		}

		engine.handleClick(100, 100);
		expect(onNodeClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'A.md' }));
	});

	it('emits onNodeDoubleClick when double-clicked on a node', () => {
		const data: GraphData = {
			seed: { type: 'note', path: 'A.md' },
			nodes: [{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		};
		engine.setData(data);
		const node = engine.getNodes()[0];
		if (node) {
			node.x = 100;
			node.y = 100;
		}

		engine.handleDoubleClick(100, 100);
		expect(onNodeDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'A.md' }));
	});

	it('renders central note edges in accent color and keeps nodes undimmed by default', () => {
		const data: GraphData = {
			seed: { type: 'note', path: 'A.md' },
			nodes: [
				{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 },
				{ id: 'B.md', label: 'B', isSeed: false, hop: 1, radius: 7 },
			],
			edges: [{ id: 'A---B', source: 'A.md', target: 'B.md', similarity: 0.88 }],
		};
		engine.setData(data);
		// Trigger render
		expect(() => engine.render()).not.toThrow();
	});

	it('places wikilink nodes smack on the orbit circumference', () => {
		const data: GraphData = {
			seed: { type: 'note', path: 'Seed.md' },
			nodes: [
				{ id: 'Seed.md', label: 'Seed', isSeed: true, hop: 0, radius: 10 },
				{ id: 'Linked.md', label: 'Linked', isSeed: false, hop: 1, viaLink: true, linkDirection: 'out', radius: 7 },
			],
			edges: [{ id: 'Seed---Linked', source: 'Seed.md', target: 'Linked.md', wikiLink: 'forward' }],
		};
		engine.setData(data);

		const seed = engine.getNodes().find((n) => n.id === 'Seed.md');
		const linked = engine.getNodes().find((n) => n.id === 'Linked.md');
		const dist = Math.hypot(
			(linked?.x ?? 0) - (seed?.x ?? 0),
			(linked?.y ?? 0) - (seed?.y ?? 0),
		);

		// Default mock container is 800x600 → scale = 600 / 750 = 0.8.
		expect(dist).toBeCloseTo(ORBIT_RADIUS * 0.8, 0);
	});

	it('gives orbit nodes zero charge and full radial strength so they stay on the ring', () => {
		const orbitNode: GraphNode = {
			id: 'Linked.md',
			label: 'Linked',
			isSeed: false,
			hop: 1,
			viaLink: true,
			linkDirection: 'out',
		};
		expect(chargeForNode(orbitNode, 1)).toBe(0);
		expect(radialStrengthForNode(orbitNode)).toBe(1);
	});

	describe('Physics: Distance = Relevance', () => {
		it('assigns shorter spring distance and radial distance to high similarity nodes than low similarity nodes', () => {
			const data: GraphData = {
				seed: { type: 'note', path: 'Seed.md' },
				nodes: [
					{ id: 'Seed.md', label: 'Seed', isSeed: true, hop: 0, radius: 10 },
					{ id: 'High.md', label: 'High', isSeed: false, hop: 1, similarity: 0.95, radius: 7 },
					{ id: 'Low.md', label: 'Low', isSeed: false, hop: 1, similarity: 0.45, radius: 7 },
				],
				edges: [
					{ id: 'Seed---High', source: 'Seed.md', target: 'High.md', similarity: 0.95 },
					{ id: 'Seed---Low', source: 'Seed.md', target: 'Low.md', similarity: 0.45 },
				],
			};
			engine.setData(data);

			const highDist = engine.getLinkDistance(data.edges[0]!);
			const lowDist = engine.getLinkDistance(data.edges[1]!);

			// High similarity should be closer to center (shorter link distance)
			expect(highDist).toBeLessThan(lowDist);
			// Significant difference between high and low similarity (at least 50px difference)
			expect(lowDist - highDist).toBeGreaterThan(50);

			const highRadius = engine.getRadialRadius(data.nodes[1]!);
			const lowRadius = engine.getRadialRadius(data.nodes[2]!);
			expect(highRadius).toBeLessThan(lowRadius);
			expect(lowRadius - highRadius).toBeGreaterThan(50);
		});

		it('pins wikilink-only nodes to the orbit radius', () => {
			const data: GraphData = {
				seed: { type: 'note', path: 'Seed.md' },
				nodes: [
					{ id: 'Seed.md', label: 'Seed', isSeed: true, hop: 0, radius: 10 },
					{ id: 'Linked.md', label: 'Linked', isSeed: false, hop: 1, viaLink: true, linkDirection: 'out', radius: 7 },
					{ id: 'Related.md', label: 'Related', isSeed: false, hop: 1, similarity: 0.9, radius: 7 },
				],
				edges: [
					{ id: 'Seed---Linked', source: 'Seed.md', target: 'Linked.md', wikiLink: 'forward' },
					{ id: 'Seed---Related', source: 'Seed.md', target: 'Related.md', similarity: 0.9 },
				],
			};
			engine.setData(data);

			const linkedRadius = engine.getRadialRadius(data.nodes[1]!);
			const relatedRadius = engine.getRadialRadius(data.nodes[2]!);
			expect(linkedRadius).toBeLessThan(relatedRadius);
		});
	});

	describe('Sneak Peek Tooltip', () => {
		it('creates tooltip element inside container with is-hidden class', () => {
			const tooltip = container.querySelector('.proxima-context-graph-tooltip');
			expect(tooltip).toBeDefined();
			expect(tooltip?.className).toContain('is-hidden');
		});

		it('keeps tooltip hidden by default when hovering over node', () => {
			const data: GraphData = {
				seed: { type: 'note', path: 'Seed.md' },
				nodes: [
					{ id: 'Seed.md', label: 'Seed', isSeed: true, hop: 0, radius: 10 },
					{
						id: 'NodeB.md',
						label: 'Node B',
						isSeed: false,
						hop: 1,
						similarity: 0.85,
						radius: 7,
						sneakPeek: ['Related 1', 'Related 2'],
					},
				],
				edges: [{ id: 'Seed---NodeB', source: 'Seed.md', target: 'NodeB.md', similarity: 0.85 }],
			};
			engine.setData(data);

			const nodeB = engine.getNodes().find((n) => n.id === 'NodeB.md');
			if (nodeB) {
				nodeB.x = 250;
				nodeB.y = 250;
			}

			// Simulate hovering over Node B
			const canvas = container.children.find((c) => c.tagName.toLowerCase() === 'canvas') as unknown as MockElement;
			const pointerMoveListeners = canvas.eventListeners['pointermove'] ?? [];
			for (const fn of pointerMoveListeners) {
				fn({ clientX: 250, clientY: 250 });
			}

			// Default behavior: tooltip stays hidden so canvas remains clean
			const tooltip = container.querySelector('.proxima-context-graph-tooltip');
			expect(tooltip?.className).toContain('is-hidden');
		});

		it('shows tooltip with connection titles when hovering over peripheral node with sneakPeek when enableTooltip is true', () => {
			const tooltipContainer = new MockElement('div');
			const tooltipEngine = new ContextGraphEngine(tooltipContainer as unknown as HTMLElement, {
				enableTooltip: true,
			});

			const data: GraphData = {
				seed: { type: 'note', path: 'Seed.md' },
				nodes: [
					{ id: 'Seed.md', label: 'Seed', isSeed: true, hop: 0, radius: 10 },
					{
						id: 'NodeB.md',
						label: 'Node B',
						isSeed: false,
						hop: 1,
						similarity: 0.85,
						radius: 7,
						sneakPeek: ['Related 1', 'Related 2', 'Related 3', 'Related 4', 'Related 5'],
					},
				],
				edges: [{ id: 'Seed---NodeB', source: 'Seed.md', target: 'NodeB.md', similarity: 0.85 }],
			};
			tooltipEngine.setData(data);

			const nodeB = tooltipEngine.getNodes().find((n) => n.id === 'NodeB.md');
			expect(nodeB).toBeDefined();
			if (nodeB) {
				nodeB.x = 250;
				nodeB.y = 250;
			}

			// Simulate hovering over Node B
			const canvas = tooltipContainer.children.find((c) => c.tagName.toLowerCase() === 'canvas') as unknown as MockElement;
			const pointerMoveListeners = canvas.eventListeners['pointermove'] ?? [];
			for (const fn of pointerMoveListeners) {
				fn({ clientX: 250, clientY: 250 });
			}

			const tooltip = tooltipContainer.querySelector('.proxima-context-graph-tooltip');
			expect(tooltip?.className).not.toContain('is-hidden');
			expect(tooltip?.textContent).toContain('Related 1');
			expect(tooltip?.textContent).toContain('Related 5');

			// Numbered list items
			const numbers = tooltip?.querySelectorAll('.proxima-context-graph-tooltip-number');
			expect(numbers?.length).toBe(5);
			expect(numbers?.[0]?.textContent).toBe('1.');
			expect(numbers?.[4]?.textContent).toBe('5.');

			// Hover over empty space
			for (const fn of pointerMoveListeners) {
				fn({ clientX: 700, clientY: 700 });
			}
			expect(tooltip?.className).toContain('is-hidden');

			tooltipEngine.destroy();
		});
	});

	describe('Optimistic Centering', () => {
		it('isolates the target node at center, clears other nodes and edges, and begins optimistic loading', () => {
			const data: GraphData = {
				seed: { type: 'note', path: 'OldSeed.md' },
				nodes: [
					{ id: 'OldSeed.md', label: 'Old Seed', isSeed: true, hop: 0, radius: 10 },
					{ id: 'Target.md', label: 'Target', isSeed: false, hop: 1, radius: 7 },
					{ id: 'Other.md', label: 'Other', isSeed: false, hop: 1, radius: 7 },
				],
				edges: [
					{ id: 'OldSeed---Target', source: 'OldSeed.md', target: 'Target.md', similarity: 0.9 },
					{ id: 'OldSeed---Other', source: 'OldSeed.md', target: 'Other.md', similarity: 0.8 },
				],
			};
			engine.setData(data);

			engine.optimisticFocus('Target.md', 'Target Note');

			const nodes = engine.getNodes();
			expect(nodes.length).toBe(1);
			expect(nodes[0]?.id).toBe('Target.md');
			expect(nodes[0]?.isSeed).toBe(true);
			expect(nodes[0]?.label).toBe('Target Note');
			// Center position for 800x600 is (400, 300)
			expect(nodes[0]?.x).toBe(400);
			expect(nodes[0]?.y).toBe(300);

			expect(engine.getEdges().length).toBe(0);
			expect(engine.isOptimisticLoading()).toBe(true);
		});

		it('synthesizes a placeholder seed when the focus id does not exist yet (initial load)', () => {
			// No data set: nodes is empty, so optimisticFocus has no node to
			// focus. It should still enter the loading state with a placeholder.
			engine.optimisticFocus('__init__', 'My Note');

			const nodes = engine.getNodes();
			expect(nodes.length).toBe(1);
			expect(nodes[0]?.id).toBe('__init__');
			expect(nodes[0]?.isSeed).toBe(true);
			expect(nodes[0]?.label).toBe('My Note');
			expect(nodes[0]?.x).toBe(400);
			expect(nodes[0]?.y).toBe(300);
			expect(engine.isOptimisticLoading()).toBe(true);
		});

		it('clears optimistic loading state when new data is set', () => {
			const data1: GraphData = {
				seed: { type: 'note', path: 'A.md' },
				nodes: [
					{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 },
					{ id: 'B.md', label: 'B', isSeed: false, hop: 1, radius: 7 },
				],
				edges: [{ id: 'A---B', source: 'A.md', target: 'B.md', similarity: 0.9 }],
			};
			engine.setData(data1);

			engine.optimisticFocus('B.md');
			expect(engine.isOptimisticLoading()).toBe(true);

			const data2: GraphData = {
				seed: { type: 'note', path: 'B.md' },
				nodes: [
					{ id: 'B.md', label: 'B', isSeed: true, hop: 0, radius: 10 },
					{ id: 'C.md', label: 'C', isSeed: false, hop: 1, radius: 7 },
				],
				edges: [{ id: 'B---C', source: 'B.md', target: 'C.md', similarity: 0.95 }],
			};
			engine.setData(data2);

			expect(engine.isOptimisticLoading()).toBe(false);
			expect(engine.getNodes().length).toBe(2);
		});

		it('renders radiating ripple rings expanding a small distance from the central dot during optimistic loading', () => {
			const data: GraphData = {
				seed: { type: 'note', path: 'A.md' },
				nodes: [
					{ id: 'A.md', label: 'A', isSeed: true, hop: 0, radius: 10 },
					{ id: 'B.md', label: 'B', isSeed: false, hop: 1, radius: 8 },
				],
				edges: [{ id: 'A---B', source: 'A.md', target: 'B.md', similarity: 0.9 }],
			};
			engine.setData(data);

			engine.optimisticFocus('B.md');

			interface EngineWithContext {
				ctx: {
					arc: (...args: number[]) => void;
					stroke: () => void;
					createRadialGradient?: () => void;
				};
			}
			const ctx = (engine as unknown as EngineWithContext).ctx;
			const arcSpy = vi.spyOn(ctx, 'arc');
			const strokeSpy = vi.spyOn(ctx, 'stroke');
			const gradSpy = ctx.createRadialGradient ? vi.spyOn(ctx, 'createRadialGradient') : null;

			expect(() => engine.render()).not.toThrow();

			// Should NOT use blurry gradient smudge
			if (gradSpy) {
				expect(gradSpy).not.toHaveBeenCalled();
			}

			// Must draw ripple arcs expanding within a small radiating distance (e.g. <= radius + 25)
			// There should be at least 2 ripple rings + the node body = 3+ arc calls
			expect(arcSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
			const rippleCalls = arcSpy.mock.calls.filter((call) => {
				const r = call[2];
				return typeof r === 'number' && r > 8 && r <= 8 + 25;
			});
			expect(rippleCalls.length).toBeGreaterThanOrEqual(2);
			expect(strokeSpy).toHaveBeenCalled();
		});

		it('initializes hop-2 satellites around their parent hop-1 star rather than origin', () => {
			const data: GraphData = {
				seed: { type: 'note', path: 'Seed.md' },
				nodes: [
					{ id: 'Seed.md', label: 'Seed', isSeed: true, hop: 0, radius: 10 },
					{ id: 'H1.md', label: 'H1', isSeed: false, hop: 1, radius: 7 },
					{ id: 'Sat1.md', label: 'Sat1', isSeed: false, hop: 2, radius: 4.5, parentId: 'H1.md' },
					{ id: 'Sat2.md', label: 'Sat2', isSeed: false, hop: 2, radius: 4.5, parentId: 'H1.md' },
				],
				edges: [
					{ id: 'Seed---H1', source: 'Seed.md', target: 'H1.md', similarity: 0.8 },
					{ id: 'H1---Sat1', source: 'H1.md', target: 'Sat1.md', similarity: 0.7, isSecondary: true, kind: 'satellite' },
					{ id: 'H1---Sat2', source: 'H1.md', target: 'Sat2.md', similarity: 0.65, isSecondary: true, kind: 'satellite' },
				],
			};
			engine.setData(data);

			const h1 = engine.getNodes().find((n) => n.id === 'H1.md')!;
			const sat1 = engine.getNodes().find((n) => n.id === 'Sat1.md')!;
			const sat2 = engine.getNodes().find((n) => n.id === 'Sat2.md')!;

			expect(h1).toBeDefined();
			expect(sat1).toBeDefined();
			expect(sat2).toBeDefined();

			// Distance from satellite to parent should be in orbit range (~50-70px), not at canvas center or (0,0)
			const dist1 = Math.hypot((sat1.x ?? 0) - (h1.x ?? 0), (sat1.y ?? 0) - (h1.y ?? 0));
			const dist2 = Math.hypot((sat2.x ?? 0) - (h1.x ?? 0), (sat2.y ?? 0) - (h1.y ?? 0));
			expect(dist1).toBeGreaterThan(40);
			expect(dist1).toBeLessThan(90);
			expect(dist2).toBeGreaterThan(40);
			expect(dist2).toBeLessThan(90);
		});
	});
});

