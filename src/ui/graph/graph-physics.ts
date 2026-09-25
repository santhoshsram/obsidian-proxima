/** d3-force configuration for the context graph: link distances, charge, radial layout, angular clearance. */

import {
	forceManyBody,
	forceCollide,
	type ForceLink,
	type ForceCenter,
	type ForceRadial,
	type Simulation,
} from 'd3-force';
import type { GraphNode, GraphEdge } from '../../search/graph';
import {
	normalizeSimilarity,
	DEFAULT_SIMILARITY,
	NODE_RADIUS_HOP2_DEFAULT,
	NODE_RADIUS_DEFAULT,
	DEFAULT_CANVAS_WIDTH,
	DEFAULT_CANVAS_HEIGHT,
	PEER_LINK_DIST_MIN,
	PEER_LINK_DIST_MAX,
	SATELLITE_LINK_DIST_MIN,
	SATELLITE_LINK_DIST_MAX,
	PRIMARY_LINK_DIST_MIN,
	PRIMARY_LINK_DIST_MAX,
	PEER_LINK_STRENGTH,
	SATELLITE_LINK_STRENGTH,
	PRIMARY_LINK_STRENGTH,
	SEED_CHARGE,
	HOP2_CHARGE,
	DEFAULT_CHARGE,
	RADIAL_DIST_MIN,
	RADIAL_DIST_MAX,
	RADIAL_STRENGTH_HOP1,
	ORBIT_RADIUS,
	ORBIT_RADIAL_STRENGTH,
	ORBIT_CHARGE,
	ANGULAR_MIN_SEPARATION_RAD,
	ANGULAR_FORCE_MAGNITUDE,
	COLLIDE_PADDING_HOP2,
	COLLIDE_PADDING_DEFAULT,
	COLLIDE_ITERATIONS,
} from './graph-constants';

/** Radial target distance from the seed for a hop-1 node, by normalized similarity. */
export function radialDistanceForNode(node: GraphNode, scale: number): number {
	if (node.isSeed || node.hop > 1) return 0;
	if (node.viaLink || node.linkDirection) return ORBIT_RADIUS * scale;
	const norm = normalizeSimilarity(node.similarity ?? DEFAULT_SIMILARITY);
	return RADIAL_DIST_MIN * scale + (1 - norm) * (RADIAL_DIST_MAX - RADIAL_DIST_MIN) * scale;
}

/** Edge link distance, by edge kind, scaled to normalized similarity. */
export function linkDistanceForEdge(edge: GraphEdge, scale: number): number {
	if (edge.wikiLink) {
		return ORBIT_RADIUS * scale;
	}
	const normScore = normalizeSimilarity(edge.similarity ?? DEFAULT_SIMILARITY);

	if (edge.kind === 'peer') {
		return PEER_LINK_DIST_MIN * scale + (1 - normScore) * (PEER_LINK_DIST_MAX - PEER_LINK_DIST_MIN) * scale;
	}
	if (edge.isSecondary || edge.kind === 'satellite') {
		return (
			SATELLITE_LINK_DIST_MIN * scale +
			(1 - normScore) * (SATELLITE_LINK_DIST_MAX - SATELLITE_LINK_DIST_MIN) * scale
		);
	}
	return (
		PRIMARY_LINK_DIST_MIN * scale + (1 - normScore) * (PRIMARY_LINK_DIST_MAX - PRIMARY_LINK_DIST_MIN) * scale
	);
}

export function linkStrengthForEdge(edge: GraphEdge): number {
	if (edge.wikiLink && edge.similarity === undefined) return PEER_LINK_STRENGTH;
	if (edge.kind === 'peer') return PEER_LINK_STRENGTH;
	if (edge.isSecondary || edge.kind === 'satellite') return SATELLITE_LINK_STRENGTH;
	return PRIMARY_LINK_STRENGTH;
}

export function chargeForNode(node: GraphNode, scale: number): number {
	if (node.isSeed) return SEED_CHARGE * scale;
	if (node.viaLink || node.linkDirection) return ORBIT_CHARGE * scale;
	if (node.hop > 1) return HOP2_CHARGE * scale;
	return DEFAULT_CHARGE * scale;
}

export function radialStrengthForNode(node: GraphNode): number {
	if (node.isSeed) return 1.0;
	if (node.viaLink || node.linkDirection) return ORBIT_RADIAL_STRENGTH;
	if (node.hop > 1) return 0;
	return RADIAL_STRENGTH_HOP1;
}

export function collideRadiusForNode(node: GraphNode, scale: number): number {
	const padding = node.hop > 1 ? COLLIDE_PADDING_HOP2 : COLLIDE_PADDING_DEFAULT;
	return (node.radius ?? (node.hop > 1 ? NODE_RADIUS_HOP2_DEFAULT : NODE_RADIUS_DEFAULT)) + padding * scale;
}

/**
 * Apply link/charge/radial/collide force configuration to an existing simulation.
 * Called on init, on setData, and on resize (scale changes with container size).
 */
export function updateForces(
	simulation: Simulation<GraphNode, GraphEdge>,
	linkForce: ForceLink<GraphNode, GraphEdge>,
	radialForce: ForceRadial<GraphNode>,
	centerForce: ForceCenter<GraphNode>,
	nodesRef: () => GraphNode[],
	scale: number,
): void {
	linkForce.distance((edge) => linkDistanceForEdge(edge, scale)).strength(linkStrengthForEdge);

	simulation.force(
		'charge',
		forceManyBody<GraphNode>().strength((d) => chargeForNode(d, scale)),
	);

	radialForce.radius((d: GraphNode) => radialDistanceForNode(d, scale)).strength(radialStrengthForNode);

	simulation.force(
		'collide',
		forceCollide<GraphNode>((d) => collideRadiusForNode(d, scale)).iterations(COLLIDE_ITERATIONS),
	);

	simulation.force('angular', createAngularForce(nodesRef, centerForce, scale));

	// Hard radial constraint for wikilink/orbit nodes: project them onto the
	// ring each tick so their center lies exactly on the circumference. This
	// overrides charge/collide/link forces that would otherwise nudge them off.
	simulation.force('orbitConstraint', createOrbitConstraint(nodesRef, centerForce, scale));
}

/**
 * Nudges hop-1 nodes apart in polar angle around the seed so adjacent spokes
 * keep a minimum angular clearance, preventing label/line crowding at low node counts.
 */
/**
 * Constrains wikilink (orbit) nodes to the exact orbit circumference each tick.
 * Runs last so charge, collide, and link forces can't leave them off the ring.
 * Position is fixed; only velocity is used by the simulation, so we set both.
 */
function createOrbitConstraint(nodesRef: () => GraphNode[], centerForce: ForceCenter<GraphNode>, scale: number) {
	return () => {
		const nodes = nodesRef();
		const seed = nodes.find((n) => n.isSeed);
		const cx = seed?.x ?? centerForce.x?.() ?? DEFAULT_CANVAS_WIDTH / 2;
		const cy = seed?.y ?? centerForce.y?.() ?? DEFAULT_CANVAS_HEIGHT / 2;
		const r = ORBIT_RADIUS * scale;
		for (const n of nodes) {
			if (!(n.viaLink || n.linkDirection) || n.x === undefined || n.y === undefined) continue;
			const dx = n.x - cx;
			const dy = n.y - cy;
			const len = Math.hypot(dx, dy);
			if (len < 1e-6) continue;
			const nx = cx + (dx / len) * r;
			const ny = cy + (dy / len) * r;
			n.x = nx;
			n.y = ny;
		}
	};
}

function createAngularForce(
	nodesRef: () => GraphNode[],
	centerForce: ForceCenter<GraphNode>,
	scale: number,
) {
	return (alpha: number) => {
		const nodes = nodesRef();
		const seed = nodes.find((n) => n.isSeed);
		const cx = seed?.x ?? centerForce.x?.() ?? DEFAULT_CANVAS_WIDTH / 2;
		const cy = seed?.y ?? centerForce.y?.() ?? DEFAULT_CANVAS_HEIGHT / 2;
		const h1Nodes = nodes.filter((n) => n.hop === 1 && n.x !== undefined && n.y !== undefined);
		if (h1Nodes.length < 2) return;

		const nodeAngles = h1Nodes.map((n) => ({
			node: n,
			angle: Math.atan2((n.y ?? 0) - cy, (n.x ?? 0) - cx),
		}));
		nodeAngles.sort((a, b) => a.angle - b.angle);

		const minSeparation = Math.min((2 * Math.PI) / (h1Nodes.length + 1), ANGULAR_MIN_SEPARATION_RAD);

		const count = nodeAngles.length;
		for (let i = 0; i < count; i++) {
			const current = nodeAngles[i]!;
			const next = nodeAngles[(i + 1) % count]!;

			let diff = next.angle - current.angle;
			if (diff < 0) diff += 2 * Math.PI;

			if (diff < minSeparation) {
				const overlap = minSeparation - Math.max(1e-4, diff);
				const forceMag = overlap * ANGULAR_FORCE_MAGNITUDE * alpha * scale;

				const curSin = Math.sin(current.angle);
				const curCos = Math.cos(current.angle);
				current.node.vx = (current.node.vx ?? 0) + curSin * forceMag;
				current.node.vy = (current.node.vy ?? 0) - curCos * forceMag;

				const nextSin = Math.sin(next.angle);
				const nextCos = Math.cos(next.angle);
				next.node.vx = (next.node.vx ?? 0) - nextSin * forceMag;
				next.node.vy = (next.node.vy ?? 0) + nextCos * forceMag;
			}
		}
	};
}
