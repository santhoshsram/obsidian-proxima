/**
 * Brain: owns the index lifecycle inside Obsidian — model loading,
 * initial sync, file-event-driven incremental updates, persistence —
 * so main.ts stays limited to plugin lifecycle and command registration.
 */

import { Notice } from 'obsidian';
import type ProximaPlugin from './main';
import { ChunkIndex } from './index/chunk-index';
import { BruteForceVectorStore } from './index/vector-store';
import { IndexingService } from './index/indexing-service';
import { loadIndex, saveIndex, type LoadedIndex } from './index/persistence';
import { ObsidianIndexStorage } from './obsidian/storage';
import { ObsidianVaultSource } from './obsidian/vault-source';
import {
	createObsidianLinkResolver,
	type LinkResolver,
} from './obsidian/link-resolver';
import { TransformersEmbedder } from './embed/embedder';
import type { Embedder } from './embed/embedder';
import {
	createEmbeddingPipeline,
	createRerankerPipeline,
	isModelCached,
} from './embed/pipeline';
import {
	EMBEDDING_MODELS,
	DEFAULT_MODEL,
	RERANKER_MODELS,
	DEFAULT_RERANKER,
	type EmbeddingModelSpec,
} from './embed/models';
import { TransformersReranker, type Reranker } from './embed/reranker';
import { HeuristicTokenCounter } from './chunking/tokens';
import {
	candidateChunksWithStrategy,
	type RetrievalStrategy,
} from './search/retrieval';
import { relatedNotes, mergeLinkedNotes } from './search/related';
import type { RelatedNote } from './search/related';
import { rerankCandidateChunks } from './search/rerank';
import type { SyncResult } from './index/indexing-service';
import { RETRIEVAL_CONFIG } from './config';
import { debounce } from './utils/debounce';
import { ConsoleLogger } from './utils/logger';
import { BufferedLogFile } from './utils/file-log';
import { sha1Hex } from './index/hasher';
import type { ModelStatus } from './settings';
import { pluginName } from './plugin-name';
import {
	buildContextGraph,
	type GraphSeed,
	type GraphData,
	type GraphBuildOptions,
	type GraphLinkResolver,
} from './search/graph';

const REINDEX_DEBOUNCE_MS = 2000;
const SAVE_DEBOUNCE_MS = 5000;
const LOG_FLUSH_MS = 2000;

export interface BrainProgress {
	isIndexing: boolean;
	done: number;
	total: number;
	currentFile: string;
	lastIndexedAt: number | null;
	embeddingStatus?: ModelStatus;
	rerankerStatus?: ModelStatus;
}

export class Brain {
	private index: ChunkIndex | null = null;
	private service: IndexingService | null = null;
	private embedder: Embedder | null = null;
	private reranker: Reranker | null = null;
	private storage: ObsidianIndexStorage | null = null;
	private ready = false;
	private logger = new ConsoleLogger(pluginName(), {
		enabled: this.plugin.settings?.debugLogging ?? false,
	});
	private logFile: BufferedLogFile | null = null;
	private linkResolver: LinkResolver | null = null;

	embeddingStatus: ModelStatus = { state: 'idle' };
	rerankerStatus: ModelStatus = { state: 'idle' };

	progress: BrainProgress = {
		isIndexing: false,
		done: 0,
		total: 0,
		currentFile: '',
		lastIndexedAt: this.plugin.settings?.lastIndexedAt ?? null,
	};
	private onProgressListeners: Array<(progress: BrainProgress) => void> = [];

	constructor(private plugin: ProximaPlugin) {}

	setEmbeddingStatus(status: ModelStatus): void {
		this.embeddingStatus = status;
		this.updateProgress({ embeddingStatus: status });
	}

	setRerankerStatus(status: ModelStatus): void {
		this.rerankerStatus = status;
		this.updateProgress({ rerankerStatus: status });
	}

	/** Subscribe to live indexing progress updates. Returns unsubscribe function. */
	onProgress(listener: (progress: BrainProgress) => void): () => void {
		this.onProgressListeners.push(listener);
		listener(this.progress);
		return () => {
			this.onProgressListeners = this.onProgressListeners.filter(
				(l) => l !== listener,
			);
		};
	}

	private updateProgress(p: Partial<BrainProgress>): void {
		this.progress = { ...this.progress, ...p };
		for (const listener of this.onProgressListeners) {
			listener(this.progress);
		}
	}

	/** Recreate the logger when the debug-logging setting changes. */
	refreshLogger(): void {
		this.logger.enabled = this.plugin.settings.debugLogging;
	}

	/** True once the model is loaded and the initial sync has completed. */
	get isReady(): boolean {
		return this.ready;
	}

	/** Set or swap the reranker instance (useful for testing or dynamic model loading). */
	setReranker(reranker: Reranker | null): void {
		this.reranker = reranker;
	}

	/** Reload the reranker pipeline on demand (e.g. from settings). */
	async reloadReranker(): Promise<void> {
		if (
			this.rerankerStatus.state === 'loading' ||
			this.rerankerStatus.state === 'downloading'
		) {
			return;
		}
		await this.loadReranker();
	}

	async loadReranker(): Promise<void> {
		if (this.plugin.settings.rerankerEnabled === false) {
			return;
		}
		try {
			const rerankerModel = this.currentRerankerModel();
			this.logger.info(`creating reranker pipeline for model ${rerankerModel.modelId}`);
			this.setRerankerStatus({ state: 'loading' });
			this.plugin.setStatus(`${pluginName()}: loading reranking model…`);
			const isCached = await isModelCached(rerankerModel.modelId);
			const createdReranker = await createRerankerPipeline(
				rerankerModel,
				(p) => {
					const isWeightsFile =
						!p.file ||
						p.file.endsWith('.onnx') ||
						p.file.endsWith('.onnx_data') ||
						p.file.endsWith('.safetensors') ||
						p.file.endsWith('.bin');
					if (
						!isCached &&
						p.status === 'progress' &&
						typeof p.progress === 'number' &&
						isWeightsFile
					) {
						const pct = Math.round(p.progress);
						this.plugin.setStatus(`${pluginName()}: downloading reranking model ${pct}%`);
						this.setRerankerStatus({ state: 'downloading', progress: pct });
					} else if (p.status === 'done' && isWeightsFile) {
						this.setRerankerStatus({ state: 'loading' });
					}
				},
				this.logger,
			);
			this.reranker = new TransformersReranker(
				createdReranker.rerankPairs,
				rerankerModel,
				createdReranker.device,
			);
			this.setRerankerStatus({ state: 'ready', device: createdReranker.device });
			this.plugin.setStatus('');
			this.logger.info(
				`reranker pipeline ready on device=${createdReranker.device}`,
			);
		} catch (e) {
			this.setRerankerStatus({ state: 'error', error: String(e) });
			this.plugin.setStatus('');
			this.logger.warn(
				'reranker model failed to load, retrieval will continue with vector scores',
				{ kind: 'rerank' },
				e,
			);
		}
	}

	/**
	 * Reset all pipeline state so a fresh init() picks up the new model.
	 * Call this whenever embeddingModel changes in settings.
	 */
	resetForModelChange(): void {
		this.initStarted = false;
		this.ready = false;
		this.embedder = null;
		this.reranker = null;
		this.index = null;
		this.service = null;
		this.embeddingStatus = { state: 'idle' };
		this.rerankerStatus = { state: 'idle' };
		this.updateProgress({
			isIndexing: true,
			done: 0,
			total: 0,
			currentFile: '',
			embeddingStatus: { state: 'idle' },
			rerankerStatus: { state: 'idle' },
		});
	}

	/** True once init() has been started (prevents double-starts). */
	get started(): boolean {
		return this.initStarted;
	}
	private initStarted = false;

	/**
	 * Load a persisted index for the current model, or create an empty one.
	 * A model switch (dimensions/modelId mismatch) forces a full rebuild
	 * without reading old vectors; `loadIndex` handles that check.
	 */
	private async loadOrCreateIndex(
		model: EmbeddingModelSpec,
	): Promise<{ index: ChunkIndex; state: LoadedIndex['state'] | null }> {
		try {
			const loaded = await loadIndex(this.storage!, {
				expectedDimensions: model.dimensions,
				expectedModelId: model.modelId,
			});
			if (loaded) {
				const fileCount = Object.keys(loaded.state.fileHashes).length;
				this.updateProgress({
					done: fileCount,
					total: fileCount,
					currentFile: `${fileCount} files / ${loaded.index.size} sections indexed`,
				});
				return { index: loaded.index, state: loaded.state };
			}
			this.logger.info(`no index found for model ${model.modelId}, starting fresh`);
		} catch (e) {
			this.logger.warn('failed to load index, rebuilding', { kind: 'load' }, e);
		}
		return { index: new ChunkIndex(new BruteForceVectorStore(model.dimensions)), state: null };
	}

	/**
	 * Load the embedding pipeline for the current model, driving
	 * embeddingStatus/plugin status text throughout. Returns null (having
	 * already set error status and notified the user) on failure so init()
	 * can abort without duplicating that handling.
	 */
	private async loadEmbeddingPipeline(model: EmbeddingModelSpec): Promise<Embedder | null> {
		try {
			this.logger.info(`creating pipeline for model ${model.modelId}`);
			this.setEmbeddingStatus({ state: 'loading' });
			this.plugin.setStatus(`${pluginName()}: loading embedding model…`);
			const isCached = await isModelCached(model.modelId);
			const created = await createEmbeddingPipeline(
				model,
				(p) => {
					const isWeightsFile =
						!p.file ||
						p.file.endsWith('.onnx') ||
						p.file.endsWith('.onnx_data') ||
						p.file.endsWith('.safetensors') ||
						p.file.endsWith('.bin');
					if (
						!isCached &&
						p.status === 'progress' &&
						typeof p.progress === 'number' &&
						isWeightsFile
					) {
						const pct = Math.round(p.progress);
						this.plugin.setStatus(`${pluginName()}: downloading embedding model ${pct}%`);
						this.setEmbeddingStatus({ state: 'downloading', progress: pct });
					} else if (p.status === 'done' && isWeightsFile) {
						this.setEmbeddingStatus({ state: 'loading' });
					}
				},
				this.logger,
			);
			this.logger.info(`embedding pipeline ready on device=${created.device}`);
			this.setEmbeddingStatus({ state: 'ready', device: created.device });
			this.plugin.setStatus('');
			return new TransformersEmbedder(created.pipe, model);
		} catch (e) {
			this.setEmbeddingStatus({ state: 'error', error: String(e) });
			this.plugin.setStatus(`${pluginName()}: model failed to load`);
			new Notice(
				`${pluginName()}: embedding model failed to load. Check the console (Cmd-Option-I) for details.`,
				0,
			);
			this.logger.error('model load failed', e);
			return null;
		}
	}

	async init(): Promise<void> {
		if (this.initStarted) {
			return;
		}
		this.initStarted = true;
		const pluginDir = await this.ensureLogFile();
		const model = this.currentModel();
		this.storage = new ObsidianIndexStorage(this.plugin.app, pluginDir);
		this.logger.info(`using model ${model.modelId}`);
		const vault = new ObsidianVaultSource(this.plugin.app);

		const loaded = await this.loadOrCreateIndex(model);
		this.index = loaded.index;
		const state = loaded.state;

		const embedder = await this.loadEmbeddingPipeline(model);
		if (!embedder) {
			return;
		}
		this.embedder = embedder;

		if (this.plugin.settings.rerankerEnabled !== false) {
			await this.loadReranker();
		}

		this.service = new IndexingService(
			this.index,
			this.embedder,
			new HeuristicTokenCounter(),
			model,
			this.logger,
		);
		if (state) {
			this.service.setState(state);
		}

		let result: SyncResult;
		try {
			result = await this.performVaultSync(vault);
		} catch (e) {
			this.updateProgress({
				isIndexing: false,
				currentFile: 'Indexing failed',
			});
			this.plugin.setStatus(`${pluginName()}: indexing failed`);
			new Notice(
				`${pluginName()}: indexing failed. Check the console (Cmd-Option-I) for details.`,
				0,
			);
			this.logger.error('indexing failed', e);
			return;
		}
		this.ready = true;
		const hasChanges = result.indexed > 0 || result.removed > 0;
		if (hasChanges || !this.plugin.settings.lastIndexedAt) {
			this.recordIndexCompletion(
				`${result.total} files / ${this.index.size} sections indexed`,
				result.total,
				result.total,
			);
		} else {
			this.updateProgress({
				isIndexing: false,
				done: result.total,
				total: result.total,
				currentFile: `${result.total} files / ${this.index.size} sections indexed`,
			});
		}
		this.plugin.setStatus('');

		this.registerFileEvents(vault);
	}

	/** Full rebuild: drop the index and re-embed everything. */
	async reindex(): Promise<void> {
		if (!this.embedder || this.progress.isIndexing) {
			return;
		}
		this.updateProgress({
			isIndexing: true,
			done: 0,
			total: 0,
			currentFile: 'Starting reindex...',
		});
		const model = this.currentModel();
		this.index = new ChunkIndex(
			new BruteForceVectorStore(model.dimensions),
		);
		this.service = new IndexingService(
			this.index,
			this.embedder,
			new HeuristicTokenCounter(),
			model,
			this.logger,
		);
		const vault = new ObsidianVaultSource(this.plugin.app);
		try {
			const result = await this.performVaultSync(vault);
			this.ready = true;
			this.recordIndexCompletion(
				`${result.total} files / ${this.index.size} sections indexed`,
				result.total,
				result.total,
			);
			this.plugin.setStatus('');
		} catch (e) {
			this.updateProgress({
				isIndexing: false,
				currentFile: 'Reindexing failed',
			});
			this.plugin.setStatus(`${pluginName()}: reindexing failed`);
			this.logger.error('reindex failed', e);
		}
	}

	/**
	 * Sync the vault against `this.service`'s index (checking-for-changes
	 * status, incremental indexing progress, persistence) and surface the
	 * result. Shared by init() and reindex(), both of which set up the
	 * index/service beforehand and each keep their own catch block, since
	 * a fresh init() must abort entirely on failure while reindex() should
	 * just report the error and leave any previously-ready state intact.
	 *
	 * Intentionally does not touch embeddingStatus/rerankerStatus or any
	 * model-download progress: sync progress and model-download progress
	 * are separate UI surfaces (indexing progress bar vs. model status),
	 * and merging them previously caused model-download progress to bleed
	 * into the indexing bar and the reindex button to show "downloading
	 * model..." incorrectly.
	 */
	private async performVaultSync(vault: ObsidianVaultSource): Promise<SyncResult> {
		if (!this.service) {
			throw new Error('performVaultSync called before service was initialized');
		}
		this.plugin.setStatus(`${pluginName()}: checking for changes…`);
		this.updateProgress({
			isIndexing: true,
			done: 0,
			total: 0,
			currentFile: 'Checking vault for changes…',
		});
		const result = await this.service.syncVault(vault, (done, total, path) => {
			this.plugin.setStatus(`${pluginName()}: indexing (${done}/${total})…`);
			this.updateProgress({
				isIndexing: true,
				done,
				total,
				currentFile: path,
			});
		});
		await this.persist();
		return result;
	}

	/** Notes related to the given (usually active) note, plus directly linked notes. */
	async relatedTo(
		filePath: string,
		options?: {
			strategy?: RetrievalStrategy;
			cursorLine?: number;
			cursorHeading?: string;
			chunkIndex?: number;
		},
	): Promise<RelatedNote[]> {
		const notes = await this.relatedToSemantic(filePath, options);
		return mergeLinkedNotes(notes, filePath, this.getLinksFor(filePath));
	}

	/** Wikilink sets for a note, resolved live from the metadata cache. */
	private getLinksFor(path: string): { outgoing: string[]; incoming: string[] } {
		if (!this.linkResolver) {
			this.linkResolver = createObsidianLinkResolver(this.plugin.app);
		}
		return {
			outgoing: this.linkResolver.outgoing(path),
			incoming: this.linkResolver.incoming(path),
		};
	}

	/** Pure semantic retrieval, without wikilink merging (used for graph seeding). */
	private async relatedToSemantic(
		filePath: string,
		options?: {
			strategy?: RetrievalStrategy;
			cursorLine?: number;
			cursorHeading?: string;
			chunkIndex?: number;
		},
	): Promise<RelatedNote[]> {
		if (!this.ready || !this.index) {
			return [];
		}

		const strategy =
			options?.strategy ?? this.plugin.settings.retrievalStrategy;
		const retrievalOptions = {
			strategy,
			cursorLine: options?.cursorLine,
			cursorHeading: options?.cursorHeading,
			chunkIndex: options?.chunkIndex,
			maxNotes: this.plugin.settings.maxRelatedNotes,
			maxChunksPerNote: this.plugin.settings.maxChunksPerNote,
			minScore: this.plugin.settings.minScore,
		};

		const tTotalStart = performance.now();
		this.logger.debug(
			`[retrieval] Query start for "${filePath}" (strategy=${strategy})`,
		);

		// 1. Stage 1: Dense vector retrieval
		const tStage1Start = performance.now();
		const candidates = candidateChunksWithStrategy(
			this.index,
			filePath,
			retrievalOptions,
		);
		const stage1Ms = performance.now() - tStage1Start;
		const sourceChunks = this.index.chunksForFile(filePath);
		this.logger.debug(
			`[retrieval] Stage 1 (cosine similarity): ${stage1Ms.toFixed(1)}ms | ` +
				`sourceChunks=${sourceChunks.length} -> candidateChunks=${candidates.length}`,
		);

		if (candidates.length === 0) {
			this.logger.debug(
				`[retrieval] No candidates found in stage 1 for "${filePath}" (${stage1Ms.toFixed(1)}ms)`,
			);
			await this.flushLog();
			return [];
		}

		// 2. Stage 2: Cross-encoder reranking (if enabled and loaded)
		let rankedCandidates = candidates;
		let stage2Ms: number | null = null;
		if (this.reranker && this.plugin.settings.rerankerEnabled !== false) {
			const vault = new ObsidianVaultSource(this.plugin.app);
			const tStage2Start = performance.now();
			rankedCandidates = await rerankCandidateChunks({
				candidates,
				fileReader: vault,
				reranker: this.reranker,
				topK: RETRIEVAL_CONFIG.stage1CandidatePoolSize,
				logger: this.logger,
			});
			stage2Ms = performance.now() - tStage2Start;
		}

		const tAssembleStart = performance.now();
		const notes = relatedNotes(rankedCandidates, {
			excludeFile: filePath,
			maxNotes: this.plugin.settings.maxRelatedNotes,
			maxChunksPerNote: this.plugin.settings.maxChunksPerNote,
		});
		const assembleMs = performance.now() - tAssembleStart;
		const totalMs = performance.now() - tTotalStart;

		const stageSummary =
			stage2Ms !== null
				? `stage1=${stage1Ms.toFixed(1)}ms stage2=${stage2Ms.toFixed(1)}ms assemble=${assembleMs.toFixed(1)}ms`
				: `stage1=${stage1Ms.toFixed(1)}ms assemble=${assembleMs.toFixed(1)}ms`;
		const label = stage2Ms !== null ? 'Finished' : 'Finished (vector-only)';
		this.logger.debug(
			`[retrieval] ${label} in ${totalMs.toFixed(1)}ms | ${stageSummary} -> returned ${notes.length} related notes`,
		);
		await this.flushLog();
		return notes;
	}

	/**
	 * Build 2-hop Context Graph around a seed note or text query.
	 */
	async getGraphData(
		seed: GraphSeed,
		options?: Partial<GraphBuildOptions>,
	): Promise<GraphData> {
		if (!this.ready || !this.index) {
			return { nodes: [], edges: [], seed };
		}
		const buildOptions: GraphBuildOptions = {
			graphHop1Count:
				options?.graphHop1Count ??
				options?.maxRelatedNotes ??
				this.plugin.settings.maxRelatedNotes,
			graphHop2Count: options?.graphHop2Count ?? 4,
			graphSimilarityThreshold:
				options?.graphSimilarityThreshold ??
				options?.minSimilarity ??
				this.plugin.settings.minScore,
		};

		let initialHop1: Array<{ filePath: string; score: number }> | undefined;
		if (seed.type === 'note') {
			try {
				const related = await this.relatedToSemantic(seed.path);
				if (related && related.length > 0) {
					initialHop1 = related.map((r) => ({
						filePath: r.filePath,
						score: r.bestScore,
					}));
				}
			} catch (e) {
				this.logger.debug('failed to fetch primary related notes for graph seed', { kind: 'search' }, e);
			}
		}

		let links: GraphLinkResolver | undefined;
		if (seed.type === 'note') {
			if (!this.linkResolver) {
				this.linkResolver = createObsidianLinkResolver(this.plugin.app);
			}
			links = this.linkResolver;
		}

		return buildContextGraph(
			this.index,
			seed,
			buildOptions,
			this.embedder ?? undefined,
			initialHop1,
			links,
		);
	}

	/** Persist on unload (best effort). */
	async shutdown(): Promise<void> {
		await this.flushLog();
		await this.persist();
	}

	/**
	 * Point the logger at `brain.log` in the plugin dir so log lines are
	 * written to disk for greppability, in addition to the console.
	 * Awaits loading existing lines before attaching the sink so ordering
	 * is preserved (existing lines, then new log lines).
	 */
	private async initLogFile(pluginDir: string): Promise<void> {
		try {
			const adapter = this.plugin.app.vault.adapter;
			const path = `${pluginDir}/brain.log`;
			const logFile = new BufferedLogFile(
				{
					read: async () =>
						(await adapter.exists(path)) ? adapter.read(path) : null,
					write: async (content: string) => {
						if (!(await adapter.exists(pluginDir))) {
							await adapter.mkdir(pluginDir);
						}
						await adapter.write(path, content);
					},
				},
				LOG_FLUSH_MS,
			);
			this.logFile = logFile;
			await logFile.init();
			this.logger.setSink((line) => logFile.append(line));
			this.logFile = logFile;
			this.logger.info('log file sink attached at ' + path);
		} catch (e) {
			// File logging is best-effort; console logging still works.
			this.logger.warn('log file sink failed to attach', { kind: 'log-file' }, e);
		}
	}

	/**
	 * Idempotent: resolves the plugin dir, attaches the log file sink if
	 * not already attached, and returns pluginDir for callers that need it
	 * (e.g. to set up storage). Safe to call from benchmark or init.
	 */
	private async ensureLogFile(): Promise<string> {
		const pluginDir =
			this.plugin.manifest.dir ??
			`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
		if (!this.logFile) {
			await this.initLogFile(pluginDir);
		}
		return pluginDir;
	}

	private async flushLog(): Promise<void> {
		if (this.logFile) {
			await this.logFile.flush();
		}
	}

	async clearLog(): Promise<void> {
		if (this.logFile) {
			await this.logFile.clear();
		}
	}

	private currentModel() {
		return (
			EMBEDDING_MODELS[this.plugin.settings.embeddingModel] ??
			DEFAULT_MODEL
		);
	}

	private currentRerankerModel() {
		const configured = this.plugin.settings.rerankerModel;
		if (!configured || configured === 'cross-encoder/ettin-reranker-150m-v1') {
			return DEFAULT_RERANKER;
		}
		return (
			RERANKER_MODELS[configured] ??
			DEFAULT_RERANKER
		);
	}

	private recordIndexCompletion(
		currentFile: string,
		done?: number,
		total?: number,
	): void {
		const now = Date.now();
		this.plugin.settings.lastIndexedAt = now;
		void this.plugin.saveSettings();
		this.updateProgress({
			isIndexing: false,
			lastIndexedAt: now,
			currentFile,
			...(done !== undefined ? { done } : {}),
			...(total !== undefined ? { total } : {}),
		});
	}

	private registerFileEvents(vault: ObsidianVaultSource): void {
		const scheduleSave = debounce(() => {
			void this.persist();
		}, SAVE_DEBOUNCE_MS);

		const reindexFile = debounce((path: string) => {
			void this.indexOne(vault, path).then(scheduleSave);
		}, REINDEX_DEBOUNCE_MS);

		this.plugin.registerEvent(
			this.plugin.app.vault.on('modify', (file) => {
				if (file.path.endsWith('.md')) {
					reindexFile(file.path);
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on('create', (file) => {
				if (file.path.endsWith('.md')) {
					reindexFile(file.path);
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on('delete', (file) => {
				if (file.path.endsWith('.md')) {
					this.service?.removeFile(file.path);
					this.recordIndexCompletion(`Removed ${file.path}`);
					scheduleSave();
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on('rename', (file, oldPath) => {
				if (oldPath.endsWith('.md')) {
					this.service?.removeFile(oldPath);
				}
				if (file.path.endsWith('.md')) {
					reindexFile(file.path);
				}
			}),
		);
	}

	private async indexOne(
		vault: ObsidianVaultSource,
		path: string,
	): Promise<void> {
		if (!this.service) {
			return;
		}
		try {
			const content = await vault.read(path);
			const hash = await sha1Hex(content);
			if (this.service.getState().fileHashes[path] === hash) {
				return;
			}
			this.plugin.setStatus(`${pluginName()}: indexing…`);
			await this.service.indexFile(path, content);
			const state = this.service.getState();
			const fileCount = Object.keys(state.fileHashes).length;
			const sectionCount = this.index ? this.index.size : 0;
			this.recordIndexCompletion(
				`${fileCount} files / ${sectionCount} sections indexed`,
			);
			this.plugin.setStatus('');
		} catch (e) {
			this.plugin.setStatus('');
			this.logger.warn(`failed to index ${path}`, { kind: 'index' }, e);
		}
	}

	private async persist(): Promise<void> {
		if (!this.index || !this.service || !this.storage) {
			return;
		}
		await saveIndex(this.storage, this.index, this.service.getState());
	}
}
