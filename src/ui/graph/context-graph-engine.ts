/**
 * Context Graph physics and Canvas rendering engine.
 *
 * Uses d3-force for repulsive and link physics, and renders an interactive
 * HTML5 Canvas with smooth zoom, pan, node dragging, and semantic hover highlighting.
 *
 * Force/layout math lives in graph-physics.ts and graph-layout.ts, canvas
 * drawing in graph-renderer.ts, and pointer/tooltip handling in
 * graph-interactions.ts; this class owns simulation/view state and wires
 * those modules together.
 */

import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceCenter,
	forceCollide,
	forceRadial,
	type Simulation,
	type ForceLink,
	type ForceCenter,
	type ForceRadial,
} from 'd3-force';
import type { GraphData, GraphNode, GraphEdge } from '../../search/graph';
import {
	DEFAULT_CANVAS_WIDTH,
	DEFAULT_CANVAS_HEIGHT,
	INIT_SCALE_MIN,
	INIT_SCALE_MAX,
	INIT_SCALE_REFERENCE_DIM,
	RESIZE_SCALE_MIN,
	RESIZE_SCALE_MAX,
	RESIZE_SCALE_REFERENCE_DIM,
	SIMULATION_ALPHA_RESEED,
	SIMULATION_ALPHA_DRAG,
	SIMULATION_ALPHA_RESIZE,
} from './graph-constants';
import { updateForces, radialDistanceForNode } from './graph-physics';
import { computeNodePositions, placeNodes, type ExistingPosition } from './graph-layout';
import { readThemeColors, computeHoverConnections, renderEdges, renderNode, renderOrbitRing } from './graph-renderer';
import {
	applyWheelZoom,
	findNodeAt,
	hasDraggedPastThreshold,
	positionTooltip,
	updateTooltipContent,
	type ViewTransform,
} from './graph-interactions';

export interface ContextGraphEngineOptions {
	onNodeClick?: (node: GraphNode) => void;
	onNodeDoubleClick?: (node: GraphNode) => void;
	onNodeHover?: (node: GraphNode | null) => void;
	enableTooltip?: boolean;
}

function getEndpointId(endpoint: string | GraphNode): string {
	return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

function containerRect(el: HTMLElement): { width: number; height: number; left: number; top: number } {
	const rect = el.getBoundingClientRect();
	return {
		width: rect.width || DEFAULT_CANVAS_WIDTH,
		height: rect.height || DEFAULT_CANVAS_HEIGHT,
		left: rect.left,
		top: rect.top,
	};
}

export class ContextGraphEngine {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private simulation: Simulation<GraphNode, GraphEdge>;
	private linkForce: ForceLink<GraphNode, GraphEdge>;
	private centerForce: ForceCenter<GraphNode>;
	private radialForce: ForceRadial<GraphNode>;

	private nodes: GraphNode[] = [];
	private edges: GraphEdge[] = [];
	private hoveredNode: GraphNode | null = null;
	private tooltipEl: HTMLElement;

	private view: ViewTransform = { panX: 0, panY: 0, zoom: 1 };

	private isDraggingCanvas = false;
	private draggedNode: GraphNode | null = null;
	private dragStartX = 0;
	private dragStartY = 0;
	private hasDragged = false;
	private currentSeedKey: string | null = null;
	private layoutScale = 1;

	private resizeObserver: ResizeObserver | null = null;
	private animFrameId: number | null = null;
	private glowAnimFrameId: number | null = null;
	private optimisticLoading = false;
	private optimisticStartTime = 0;

	constructor(
		private container: HTMLElement,
		private options: ContextGraphEngineOptions = {},
	) {
		this.canvas = container.createEl('canvas', {
			cls: 'proxima-context-graph-canvas',
		});

		const ctx = this.canvas.getContext('2d');
		if (!ctx) {
			throw new Error('failed to acquire 2d canvas context');
		}
		this.ctx = ctx;

		this.tooltipEl = container.createDiv({
			cls: 'proxima-context-graph-tooltip is-hidden',
		});

		const rect = containerRect(container);
		const minDim = Math.min(rect.width, rect.height);
		const scale = Math.max(INIT_SCALE_MIN, Math.min(INIT_SCALE_MAX, minDim / INIT_SCALE_REFERENCE_DIM));
		this.layoutScale = scale;

		this.centerForce = forceCenter(rect.width / 2, rect.height / 2);
		this.linkForce = forceLink<GraphNode, GraphEdge>(this.edges).id((d) => d.id);
		this.radialForce = forceRadial<GraphNode>(
			(d: GraphNode) => radialDistanceForNode(d, scale),
			rect.width / 2,
			rect.height / 2,
		);

		this.simulation = forceSimulation<GraphNode>(this.nodes)
			.force('link', this.linkForce)
			.force('charge', forceManyBody<GraphNode>())
			.force('radial', this.radialForce)
			.force('center', this.centerForce)
			.force('collide', forceCollide<GraphNode>());

		this.applyForces(scale);

		this.simulation.on('tick', () => {
			this.requestRender();
		});

		this.setupEventListeners();
		this.setupResizeObserver();
		this.resize();
	}

	private applyForces(scale: number): void {
		updateForces(
			this.simulation,
			this.linkForce,
			this.radialForce,
			this.centerForce,
			() => this.nodes,
			scale,
		);
	}

	getNodes(): GraphNode[] {
		return this.nodes;
	}

	getEdges(): GraphEdge[] {
		return this.edges;
	}

	getLinkDistance(edge: GraphEdge): number {
		const accessor = this.linkForce.distance();
		if (typeof accessor === 'function') {
			return (accessor as (e: GraphEdge) => number)(edge);
		}
		return typeof accessor === 'number' ? accessor : 0;
	}

	getRadialRadius(node: GraphNode): number {
		const accessor = this.radialForce.radius();
		if (typeof accessor === 'function') {
			return (accessor as (n: GraphNode) => number)(node);
		}
		return typeof accessor === 'number' ? accessor : 0;
	}

	isOptimisticLoading(): boolean {
		return this.optimisticLoading;
	}

	optimisticFocus(nodeId: string, newTitle?: string): void {
		this.tooltipEl.addClass('is-hidden');

		const rect = containerRect(this.container);
		const cx = rect.width / 2;
		const cy = rect.height / 2;

		// When no node with this id exists yet (initial load, or a query search
		// before any graph is present), synthesize a placeholder seed so the
		// optimistic glow still renders instead of silently returning.
		const targetNode: GraphNode =
			this.nodes.find((n) => n.id === nodeId) ??
			{ id: nodeId, label: newTitle ?? nodeId, isSeed: true, hop: 0 };

		targetNode.isSeed = true;
		targetNode.hop = 0;
		if (newTitle) {
			targetNode.label = newTitle;
		}
		targetNode.x = cx;
		targetNode.y = cy;
		targetNode.fx = cx;
		targetNode.fy = cy;
		targetNode.vx = 0;
		targetNode.vy = 0;

		this.nodes = [targetNode];
		this.edges = [];
		this.hoveredNode = null;
		this.canvas.removeClass('is-hovering-node');

		this.simulation.nodes(this.nodes);
		this.linkForce.links(this.edges);
		this.simulation.stop();

		this.optimisticLoading = true;
		this.optimisticStartTime = Date.now();
		this.view = { panX: 0, panY: 0, zoom: 1 };

		this.startLoadingGlowLoop();
	}

	private startLoadingGlowLoop(): void {
		if (!this.optimisticLoading) return;
		this.render();
		this.glowAnimFrameId = window.requestAnimationFrame(() => {
			if (this.optimisticLoading) {
				this.startLoadingGlowLoop();
			}
		});
	}

	private stopLoadingGlow(): void {
		this.optimisticLoading = false;
		if (this.glowAnimFrameId !== null) {
			window.cancelAnimationFrame(this.glowAnimFrameId);
			this.glowAnimFrameId = null;
		}
	}

	setData(data: GraphData): void {
		this.stopLoadingGlow();
		const existingPositions = new Map<string, ExistingPosition>();
		for (const n of this.nodes) {
			existingPositions.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
		}

		const rect = containerRect(this.container);
		const cx = rect.width / 2;
		const cy = rect.height / 2;
		const minDim = Math.min(rect.width, rect.height);
		const scale = Math.max(INIT_SCALE_MIN, Math.min(INIT_SCALE_MAX, minDim / INIT_SCALE_REFERENCE_DIM));
		this.layoutScale = scale;

		const newSeedKey = data.seed.type === 'note' ? data.seed.path : data.seed.query;
		const isNewSeed = this.currentSeedKey !== newSeedKey;
		this.currentSeedKey = newSeedKey;

		if (isNewSeed) {
			this.view = { panX: 0, panY: 0, zoom: 1 };
		}

		const { nodePosMap, satellitesByParent } = computeNodePositions(data, existingPositions, isNewSeed, cx, cy, scale);

		this.nodes = placeNodes(data, existingPositions, isNewSeed, nodePosMap, satellitesByParent, cx, cy, scale);

		// Deep clone edges for D3 simulation mutation.
		this.edges = data.edges.map((e) => ({
			...e,
			source: getEndpointId(e.source),
			target: getEndpointId(e.target),
		}));

		this.centerForce.x(cx);
		this.centerForce.y(cy);
		this.radialForce.x(cx);
		this.radialForce.y(cy);
		this.applyForces(scale);

		this.simulation.nodes(this.nodes);
		this.linkForce.links(this.edges);
		this.simulation.alpha(SIMULATION_ALPHA_RESEED).restart();
		this.requestRender();
	}

	getNodeAt(clientX: number, clientY: number): GraphNode | null {
		return findNodeAt(this.nodes, clientX, clientY, this.canvas, this.view);
	}

	handleClick(clientX: number, clientY: number): void {
		const node = this.getNodeAt(clientX, clientY);
		if (node) {
			this.options.onNodeClick?.(node);
		}
	}

	handleDoubleClick(clientX: number, clientY: number): void {
		const node = this.getNodeAt(clientX, clientY);
		if (node) {
			this.options.onNodeDoubleClick?.(node);
		}
	}

	private setupEventListeners(): void {
		this.canvas.addEventListener('wheel', this.onWheel);
		this.canvas.addEventListener('pointerdown', this.onPointerDown);
		this.canvas.addEventListener('pointermove', this.onPointerMove);
		this.canvas.addEventListener('pointerup', this.onPointerUp);
		this.canvas.addEventListener('click', this.onClick);
		this.canvas.addEventListener('dblclick', this.onDblClick);
	}

	private onWheel = (e: WheelEvent): void => {
		this.tooltipEl.addClass('is-hidden');
		e.preventDefault();
		this.view = applyWheelZoom(this.view, this.canvas, e);
		this.requestRender();
	};

	private onPointerDown = (e: PointerEvent): void => {
		this.tooltipEl.addClass('is-hidden');
		this.hasDragged = false;
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;

		const node = this.getNodeAt(e.clientX, e.clientY);
		if (node) {
			this.draggedNode = node;
			node.fx = node.x;
			node.fy = node.y;
			this.simulation.alphaTarget(SIMULATION_ALPHA_DRAG).restart();
		} else {
			this.isDraggingCanvas = true;
			this.canvas.addClass('is-grabbing');
		}
	};

	private onPointerMove = (e: PointerEvent): void => {
		const dx = e.clientX - this.dragStartX;
		const dy = e.clientY - this.dragStartY;
		if (hasDraggedPastThreshold(dx, dy)) {
			this.hasDragged = true;
		}

		if (this.draggedNode) {
			this.tooltipEl.addClass('is-hidden');
			const rect = this.canvas.getBoundingClientRect();
			const localX = e.clientX - rect.left;
			const localY = e.clientY - rect.top;
			this.draggedNode.fx = (localX - this.view.panX) / this.view.zoom;
			this.draggedNode.fy = (localY - this.view.panY) / this.view.zoom;
			this.requestRender();
			return;
		}

		if (this.isDraggingCanvas) {
			this.tooltipEl.addClass('is-hidden');
			this.view = {
				...this.view,
				panX: this.view.panX + (e.movementX ?? dx),
				panY: this.view.panY + (e.movementY ?? dy),
			};
			this.dragStartX = e.clientX;
			this.dragStartY = e.clientY;
			this.requestRender();
			return;
		}

		const hovered = this.getNodeAt(e.clientX, e.clientY);
		if (hovered !== this.hoveredNode) {
			this.hoveredNode = hovered;
			this.canvas.toggleClass('is-hovering-node', hovered !== null);
			this.options.onNodeHover?.(hovered);
			updateTooltipContent(this.tooltipEl, this.container, hovered, Boolean(this.options.enableTooltip), e.clientX, e.clientY);
			this.requestRender();
		} else if (hovered && !hovered.isSeed && hovered.sneakPeek && hovered.sneakPeek.length > 0) {
			positionTooltip(this.tooltipEl, this.container, e.clientX, e.clientY);
		}
	};

	private onPointerUp = (): void => {
		if (this.draggedNode) {
			if (this.draggedNode.isSeed) {
				this.draggedNode.fx = this.draggedNode.x;
				this.draggedNode.fy = this.draggedNode.y;
			} else {
				this.draggedNode.fx = null;
				this.draggedNode.fy = null;
			}
			this.draggedNode = null;
			this.simulation.alphaTarget(0);
		}
		this.isDraggingCanvas = false;
		this.canvas.removeClass('is-grabbing');
		this.canvas.toggleClass('is-hovering-node', this.hoveredNode !== null);
	};

	private onClick = (e: MouseEvent): void => {
		if (!this.hasDragged) {
			this.handleClick(e.clientX, e.clientY);
		}
	};

	private onDblClick = (e: MouseEvent): void => {
		this.handleDoubleClick(e.clientX, e.clientY);
	};

	private setupResizeObserver(): void {
		this.resizeObserver = new ResizeObserver(() => {
			this.resize();
		});
		this.resizeObserver.observe(this.container);
	}

	resize(): void {
		const rect = containerRect(this.container);
		const cx = rect.width / 2;
		const cy = rect.height / 2;
		const minDim = Math.min(rect.width, rect.height);
		const scale = Math.max(RESIZE_SCALE_MIN, Math.min(RESIZE_SCALE_MAX, minDim / RESIZE_SCALE_REFERENCE_DIM));
		this.layoutScale = scale;

		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = rect.width * dpr;
		this.canvas.height = rect.height * dpr;
		this.canvas.style.width = `${rect.width}px`;
		this.canvas.style.height = `${rect.height}px`;
		this.ctx.scale(dpr, dpr);

		this.centerForce.x(cx);
		this.centerForce.y(cy);
		this.radialForce.x(cx);
		this.radialForce.y(cy);

		const seed = this.nodes.find((n) => n.isSeed);
		if (seed && (!this.draggedNode || this.draggedNode !== seed)) {
			seed.fx = cx;
			seed.fy = cy;
		}

		this.applyForces(scale);
		this.simulation.alpha(SIMULATION_ALPHA_RESIZE).restart();
		this.requestRender();
	}

	private requestRender(): void {
		if (this.animFrameId !== null) return;
		this.animFrameId = window.requestAnimationFrame(() => {
			this.animFrameId = null;
			this.render();
		});
	}

	render(): void {
		const ctx = this.ctx;
		const rect = containerRect(this.canvas);

		ctx.clearRect(0, 0, rect.width, rect.height);
		ctx.save();
		ctx.translate(this.view.panX, this.view.panY);
		ctx.scale(this.view.zoom, this.view.zoom);

		const theme = readThemeColors(this.canvas);
		const hovered = this.hoveredNode;
		const { connectedNodeIds, connectedEdgeIds } = computeHoverConnections(hovered, this.edges);

		renderOrbitRing(ctx, this.nodes, this.layoutScale, theme);
		renderEdges(ctx, this.edges, hovered, connectedEdgeIds, theme);

		// Draw nodes in stratified layers so hop-2 satellites sit behind hop-1
		// stars, which sit behind the hovered/seed node (topmost).
		const hop2Nodes = this.nodes.filter((n) => n.hop === 2 && hovered?.id !== n.id);
		const hop1Nodes = this.nodes.filter((n) => n.hop === 1 && hovered?.id !== n.id);
		const topNodes = this.nodes.filter((n) => n.isSeed || hovered?.id === n.id);
		const findParent = (id: string) => this.nodes.find((n) => n.id === id);

		const draw = (n: GraphNode) =>
			renderNode(
				ctx,
				n,
				hovered,
				connectedNodeIds,
				this.optimisticLoading,
				this.optimisticStartTime,
				this.view.zoom,
				findParent,
				theme,
			);

		for (const n of hop2Nodes) draw(n);
		for (const n of hop1Nodes) draw(n);
		for (const n of topNodes) draw(n);

		ctx.restore();
	}

	destroy(): void {
		if (this.animFrameId !== null) {
			window.cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
		this.stopLoadingGlow();
		this.simulation.stop();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;

		this.canvas.removeEventListener('wheel', this.onWheel);
		this.canvas.removeEventListener('pointerdown', this.onPointerDown);
		this.canvas.removeEventListener('pointermove', this.onPointerMove);
		this.canvas.removeEventListener('pointerup', this.onPointerUp);
		this.canvas.removeEventListener('click', this.onClick);
		this.canvas.removeEventListener('dblclick', this.onDblClick);

		this.canvas.remove();
		this.tooltipEl.remove();
	}
}
