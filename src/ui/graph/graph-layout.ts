/** Initial node placement for a fresh or re-seeded context graph, before the simulation takes over. */

import type { GraphData, GraphNode } from '../../search/graph';
import {
	normalizeSimilarity,
	RADIAL_DIST_MIN,
	RADIAL_DIST_MAX,
	ORBIT_RADIUS,
	SATELLITE_ANGLE_SPREAD_RAD,
	SATELLITE_DISTANCE,
	DEFAULT_SIMILARITY,
	RANDOM_SCATTER_SPREAD,
} from './graph-constants';

function getEndpointId(endpoint: string | GraphNode): string {
	return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

export interface ExistingPosition {
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
}

export interface NodePosition {
	x: number;
	y: number;
	angle: number;
}

/**
 * Orders hop-1 nodes around the seed so peer-connected/similar nodes land in
 * adjacent angular slots, keeping peer springs from crossing through the center.
 */
export function orderHop1NodesByAffinity(hop1Nodes: GraphNode[], edges: GraphData['edges']): GraphNode[] {
	if (hop1Nodes.length === 0) return [];

	const remaining = new Set(hop1Nodes);
	let current = hop1Nodes[0]!;
	const ordered: GraphNode[] = [current];
	remaining.delete(current);

	while (remaining.size > 0) {
		let bestNext: GraphNode | null = null;
		let bestSim = -1;

		for (const edge of edges) {
			if (edge.kind !== 'peer') continue;
			const sId = getEndpointId(edge.source);
			const tId = getEndpointId(edge.target);
			if (sId === current.id) {
				const cand = [...remaining].find((n) => n.id === tId);
				if (cand && (edge.similarity ?? 0) > bestSim) {
					bestSim = edge.similarity ?? 0;
					bestNext = cand;
				}
			} else if (tId === current.id) {
				const cand = [...remaining].find((n) => n.id === sId);
				if (cand && (edge.similarity ?? 0) > bestSim) {
					bestSim = edge.similarity ?? 0;
					bestNext = cand;
				}
			}
		}

		if (!bestNext) {
			bestNext = remaining.values().next().value!;
		}

		ordered.push(bestNext);
		remaining.delete(bestNext);
		current = bestNext;
	}

	return ordered;
}

/**
 * Computes initial seed/hop-1/hop-2 positions for a `setData` call, reusing
 * existing simulation positions when the seed hasn't changed (keeps the
 * layout stable across incremental updates instead of re-scattering nodes).
 */
export function computeNodePositions(
	data: GraphData,
	existingPositions: Map<string, ExistingPosition>,
	isNewSeed: boolean,
	cx: number,
	cy: number,
	scale: number,
): {
	nodePosMap: Map<string, NodePosition>;
	orderedH1: GraphNode[];
	satellitesByParent: Map<string, GraphNode[]>;
} {
	const hop1Nodes = data.nodes.filter((n) => n.hop === 1);
	const orderedH1 = orderHop1NodesByAffinity(hop1Nodes, data.edges);

	const h1Angles = new Map<string, number>();
	const h1Count = Math.max(1, orderedH1.length);
	orderedH1.forEach((h1, i) => {
		h1Angles.set(h1.id, (i / h1Count) * Math.PI * 2 - Math.PI / 2);
	});

	const nodePosMap = new Map<string, NodePosition>();

	const seedNode = data.nodes.find((n) => n.isSeed);
	if (seedNode) {
		const existing = existingPositions.get(seedNode.id);
		if (!isNewSeed && existing?.x !== undefined && existing.y !== undefined) {
			nodePosMap.set(seedNode.id, { x: existing.x, y: existing.y, angle: 0 });
		} else {
			nodePosMap.set(seedNode.id, { x: cx, y: cy, angle: 0 });
		}
	}

	orderedH1.forEach((h1) => {
		const existing = existingPositions.get(h1.id);
		if (!isNewSeed && existing?.x !== undefined && existing.y !== undefined) {
			const angle = Math.atan2(existing.y - cy, existing.x - cx);
			nodePosMap.set(h1.id, { x: existing.x, y: existing.y, angle });
			return;
		}
		const norm = normalizeSimilarity(h1.similarity ?? DEFAULT_SIMILARITY);
		const angle = h1Angles.get(h1.id) ?? 0;
		const r =
			h1.viaLink || h1.linkDirection
				? ORBIT_RADIUS * scale
				: RADIAL_DIST_MIN * scale + (1 - norm) * (RADIAL_DIST_MAX - RADIAL_DIST_MIN) * scale;
		nodePosMap.set(h1.id, {
			x: cx + Math.cos(angle) * r,
			y: cy + Math.sin(angle) * r,
			angle,
		});
	});

	const satellitesByParent = new Map<string, GraphNode[]>();
	data.nodes.forEach((n) => {
		if (n.hop > 1 && n.parentId) {
			const list = satellitesByParent.get(n.parentId) ?? [];
			list.push(n);
			satellitesByParent.set(n.parentId, list);
		}
	});

	return { nodePosMap, orderedH1, satellitesByParent };
}

/** Maps every graph node to its simulation-ready position, given precomputed seed/hop-1 placements. */
export function placeNodes(
	data: GraphData,
	existingPositions: Map<string, ExistingPosition>,
	isNewSeed: boolean,
	nodePosMap: Map<string, NodePosition>,
	satellitesByParent: Map<string, GraphNode[]>,
	cx: number,
	cy: number,
	scale: number,
): GraphNode[] {
	return data.nodes.map((n) => {
		const existing = existingPositions.get(n.id);

		if (n.isSeed) {
			const pos = nodePosMap.get(n.id) ?? { x: cx, y: cy };
			return { ...n, x: pos.x, y: pos.y, fx: pos.x, fy: pos.y };
		}

		if (!isNewSeed && existing?.x !== undefined && existing.y !== undefined) {
			return { ...n, x: existing.x, y: existing.y, vx: existing.vx, vy: existing.vy };
		}

		if (n.hop === 1) {
			const pos = nodePosMap.get(n.id) ?? { x: cx, y: cy };
			return { ...n, x: pos.x, y: pos.y };
		}

		if (n.parentId && nodePosMap.has(n.parentId)) {
			const parentPos = nodePosMap.get(n.parentId)!;
			const siblings = satellitesByParent.get(n.parentId) ?? [n];
			const sibIndex = siblings.findIndex((s) => s.id === n.id);
			const totalSibs = Math.max(1, siblings.length);
			const satAngleOffset = (sibIndex - (totalSibs - 1) / 2) * SATELLITE_ANGLE_SPREAD_RAD;
			const satAngle = parentPos.angle + satAngleOffset;
			const satDist = SATELLITE_DISTANCE * scale;
			return {
				...n,
				x: parentPos.x + Math.cos(satAngle) * satDist,
				y: parentPos.y + Math.sin(satAngle) * satDist,
			};
		}

		return {
			...n,
			x: cx + (Math.random() - 0.5) * RANDOM_SCATTER_SPREAD * scale,
			y: cy + (Math.random() - 0.5) * RANDOM_SCATTER_SPREAD * scale,
		};
	});
}
