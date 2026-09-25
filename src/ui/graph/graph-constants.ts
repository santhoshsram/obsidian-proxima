/** Shared layout, physics, and rendering constants for the context graph. */

/** Default canvas dimensions used before the container has a measured size. */
export const DEFAULT_CANVAS_WIDTH = 800;
export const DEFAULT_CANVAS_HEIGHT = 600;

/** Raw similarity/rerank scores are normalized against this range before layout use. */
export const SIMILARITY_NORM_MIN = 0.4;
export const SIMILARITY_NORM_RANGE = 0.55;

/** Scale factor bounds, keyed to container size, used by the constructor/setData (~750px reference). */
export const INIT_SCALE_MIN = 0.35;
export const INIT_SCALE_MAX = 1.3;
export const INIT_SCALE_REFERENCE_DIM = 750;

/** Scale factor bounds used by resize() (~750px reference, matching setData so a
 * ResizeObserver pass can't re-inflate the graph after a narrow-container layout). */
export const RESIZE_SCALE_MIN = 0.35;
export const RESIZE_SCALE_MAX = 2.0;
export const RESIZE_SCALE_REFERENCE_DIM = 750;

/** Radial distance (px, pre-scale) from seed for hop-1 nodes, by normalized similarity. */
export const RADIAL_DIST_MIN = 170;
export const RADIAL_DIST_MAX = 270;

/** Link distance bounds (px, pre-scale) for peer (1-hop cross) edges. */
export const PEER_LINK_DIST_MIN = 140;
export const PEER_LINK_DIST_MAX = 260;

/** Link distance bounds (px, pre-scale) for secondary/satellite edges. */
export const SATELLITE_LINK_DIST_MIN = 42;
export const SATELLITE_LINK_DIST_MAX = 78;

/** Link distance bounds (px, pre-scale) for primary seed-to-hop-1 edges. */
export const PRIMARY_LINK_DIST_MIN = 150;
export const PRIMARY_LINK_DIST_MAX = 250;

/** Spring strength for peer edges: soft so similar 1-hops drift together without bunching. */
export const PEER_LINK_STRENGTH = 0.05;
export const SATELLITE_LINK_STRENGTH = 0.8;
export const PRIMARY_LINK_STRENGTH = 1.0;

/** Charge (repulsion) strength, pre-scale, by node role. */
export const SEED_CHARGE = -350;
export const HOP2_CHARGE = -70;
export const DEFAULT_CHARGE = -220;

export const RADIAL_STRENGTH_HOP1 = 0.95;

/** Simulation reheat strength on setData/resize (full) vs. drag-start (partial, less jitter). */
export const SIMULATION_ALPHA_RESEED = 0.8;
export const SIMULATION_ALPHA_DRAG = 0.3;
export const SIMULATION_ALPHA_RESIZE = 0.3;

/** Angular-clearance force: minimum spoke separation (~22deg) and push magnitude. */
export const ANGULAR_MIN_SEPARATION_RAD = 0.38;
export const ANGULAR_FORCE_MAGNITUDE = 80;

/** Collision radius padding (pre-scale) by node role. */
export const COLLIDE_PADDING_HOP2 = 12;
export const COLLIDE_PADDING_DEFAULT = 48;
export const COLLIDE_ITERATIONS = 4;

/** Hop-2 satellite placement relative to its parent. */
export const SATELLITE_ANGLE_SPREAD_RAD = 0.35;
export const SATELLITE_DISTANCE = 58;

/** Similarity fallback when a node/edge carries no score (mid-range, deliberately non-committal). */
export const DEFAULT_SIMILARITY = 0.6;

/** Random scatter spread (pre-scale) for a node with no computed position. */
export const RANDOM_SCATTER_SPREAD = 100;

export const OPTIMISTIC_RIPPLE_CYCLE_MS = 1200;
export const OPTIMISTIC_RIPPLE_MAX_DIST = 20;
export const OPTIMISTIC_RIPPLE_PHASES = [0, 0.5];
export const OPTIMISTIC_RIPPLE_LINE_WIDTH = 1.5;
export const OPTIMISTIC_RIPPLE_ALPHA_MAX = 0.65;

/** Edge rendering alpha values. */
export const EDGE_ALPHA_SECONDARY_HOVERED = 0.5;
export const EDGE_ALPHA_SECONDARY_DIMMED = 0.05;
export const EDGE_ALPHA_SECONDARY_REST = 0.1;
export const EDGE_ALPHA_PRIMARY_DIMMED = 0.9;
export const EDGE_PRIMARY_BASE_WIDTH = 1.0;
export const EDGE_PRIMARY_WIDTH_SCALE = 3.2;
export const EDGE_PRIMARY_HOVER_WIDTH_MULT = 1.35;

/** Orbit ring (wikilink nodes) rendering constants. */
export const ORBIT_RADIUS = 140;
/** Radial spring strength for orbit nodes: dominant so they hug the ring. */
export const ORBIT_RADIAL_STRENGTH = 1.0;
/** Charge for orbit nodes: zero so seed/peer repulsion can't push them off the ring. */
export const ORBIT_CHARGE = 0;
export const ORBIT_RING_ALPHA = 0.15;
export const ORBIT_RING_WIDTH = 1;

/** Wikilink edge rendering constants. */
export const WIKI_EDGE_WIDTH = 1.5;
export const WIKI_EDGE_ALPHA = 0.55;

/** Arrowhead geometry for directed wikilink edges. */
export const ARROWHEAD_LENGTH = 8;
export const ARROWHEAD_HALF_ANGLE = Math.PI / 7;

/** Node rendering alpha/stroke values, by role and state. */
export const NODE_ALPHA_HOP2_ACTIVE = 0.95;
export const NODE_ALPHA_HOP2_DIMMED = 0.12;
export const NODE_ALPHA_HOP2_REST = 0.3;
export const NODE_ALPHA_HOP1_DIMMED = 0.9;
export const NODE_STROKE_SEED = 2.0;
export const NODE_STROKE_HOP2_HOVERED = 2.0;
export const NODE_STROKE_HOP2_CONNECTED = 1.3;
export const NODE_STROKE_HOP2_DIMMED = 0.8;
export const NODE_STROKE_HOP2_REST = 1.0;
export const NODE_STROKE_HOP1_HOVERED = 2.5;
export const NODE_STROKE_HOP1_CONNECTED = 2.0;
export const NODE_STROKE_HOP1_DIMMED = 1.5;
export const NODE_STROKE_HOP1_REST = 1.8;
export const NODE_HOVER_RADIUS_MULT = 1.3;
export const NODE_RADIUS_HOP2_DEFAULT = 4.5;
export const NODE_RADIUS_DEFAULT = 8;

export const LABEL_FONT_SIZE_HOP2 = 9;
export const LABEL_FONT_SIZE_DEFAULT = 11;
export const LABEL_ALPHA_HOP2 = 0.85;
export const LABEL_ALPHA_DIMMED = 0.9;
export const LABEL_ALPHA_REST = 0.95;
export const LABEL_HALO_WIDTH = 3.5;
export const LABEL_HALO_ALPHA_MULT = 0.9;

/**
 * Normalize a raw similarity/rerank score to a 0..1 display range.
 *
 * Rerank scores can exceed 1.0 (raw logits), so those are first squashed
 * through a sigmoid; cosine similarities already sit in [0, 1] and pass
 * through unchanged before the shared min/max normalization.
 */
export function normalizeSimilarity(score: number): number {
	const squashed = score > 1.0 ? 1 / (1 + Math.exp(-score)) : score;
	return Math.max(0, Math.min(1, (squashed - SIMILARITY_NORM_MIN) / SIMILARITY_NORM_RANGE));
}
