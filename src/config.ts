/**
 * Internal configuration constants for Proxima.
 *
 * Tunable knobs kept out of the general user settings UI to keep the interface
 * clean, but easily configurable here or via `<Vault>/.obsidian/plugins/proxima/data.json`.
 */

export const RETRIEVAL_CONFIG = {
	/**
	 * Number of candidate chunks funneled from Stage 1 (dense vector search)
	 * into Stage 2 (cross-encoder reranking).
	 *
	 * - Higher values (e.g. 75–100): wider recall net, slightly longer rerank time.
	 * - Lower values (e.g. 20–30): faster inference, narrower candidate pool.
	 */
	stage1CandidatePoolSize: 35,
} as const;

export const INDEXING_CONFIG = {
	/**
	 * Maximum number of concurrent embedding batches executed against
	 * the WebGPU / ONNX embedding pipeline.
	 */
	embeddingConcurrency: 4,
} as const;

export const GRAPH_CONFIG = {
	/**
	 * Maximum number of link-only notes promoted onto the graph orbit from a
	 * seed note's direct wikilinks. Prevents hub notes (e.g. MOCs) from
	 * exploding the graph. Not currently exposed in the settings UI.
	 */
	seedLinkNodeCap: 50,
} as const;
