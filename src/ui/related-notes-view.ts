import {
	ItemView,
	MarkdownView,
	setIcon,
	TFile,
	type WorkspaceLeaf,
} from 'obsidian';
import type ProximaPlugin from '../main';
import type { BrainProgress } from '../brain';
import type { RelatedNote } from '../search/related';
import { getSectionDisplay } from './snippet';
import { debounce, type DebouncedFn } from '../utils/debounce';
import { ContextGraphEngine } from './graph/context-graph-engine';
import { GraphControls, filterGraphData } from './graph/graph-controls';
import type { GraphData } from '../search/graph';

export const VIEW_TYPE_RELATED = 'brain-related-notes';

export class RelatedNotesView extends ItemView {
	private plugin: ProximaPlugin;
	private unsubscribeProgress?: () => void;
	private debouncedRefresh: DebouncedFn<[]>;
	private wasIndexing = false;
	private mode: 'list' | 'graph' = 'list';
	private graphEngine: ContextGraphEngine | null = null;
	private graphControls: GraphControls | null = null;
	private rawGraphData: GraphData | null = null;

	private headerEl: HTMLElement | null = null;
	private listBtn: HTMLButtonElement | null = null;
	private graphBtn: HTMLButtonElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private currentRequestId = 0;

	constructor(leaf: WorkspaceLeaf, plugin: ProximaPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.mode = this.plugin.settings.sidebarViewMode ?? 'list';
		this.debouncedRefresh = debounce(() => {
			void this.refresh();
		}, 300);
	}

	getViewType(): string {
		return VIEW_TYPE_RELATED;
	}

	getDisplayText(): string {
		return 'Related notes';
	}

	getIcon(): string {
		return 'brain-circuit';
	}

	onload(): void {
		super.onload();
		this.contentEl.addClass('proxima-related-view-content');
		this.unsubscribeProgress = this.plugin.brain.onProgress(
			(progress: BrainProgress) => {
				const isNowIndexing = progress.isIndexing;
				if (this.wasIndexing && !isNowIndexing) {
					void this.refresh();
				} else if (isNowIndexing) {
					this.renderEmptyState(
						`Indexing (${progress.done}/${progress.total})…`,
					);
				}
				this.wasIndexing = isNowIndexing;
			},
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.debouncedRefresh();
			}),
		);

		void this.refresh();
	}

	onunload(): void {
		this.debouncedRefresh.cancel();
		this.cleanupGraph();
		if (this.unsubscribeProgress) {
			this.unsubscribeProgress();
			this.unsubscribeProgress = undefined;
		}
	}

	private ensureLayout(): void {
		const isAttached =
			Boolean(this.headerEl && this.bodyEl) &&
			this.contentEl.contains(this.headerEl) &&
			this.contentEl.contains(this.bodyEl);

		if (!isAttached) {
			this.contentEl.empty();
			this.headerEl = this.contentEl.createDiv({
				cls: 'proxima-view-header',
			});
			const toggleGroup = this.headerEl.createDiv({
				cls: 'proxima-view-toggle-group',
			});
			this.listBtn = toggleGroup.createEl('button', {
				cls: `proxima-view-toggle ${this.mode === 'list' ? 'is-active' : ''}`,
				text: 'List',
			});
			this.graphBtn = toggleGroup.createEl('button', {
				cls: `proxima-view-toggle ${this.mode === 'graph' ? 'is-active' : ''}`,
				text: 'Graph',
			});

			this.registerDomEvent(this.listBtn, 'click', () => {
				if (this.mode !== 'list') {
					void this.setMode('list');
				}
			});

			this.registerDomEvent(this.graphBtn, 'click', () => {
				if (this.mode !== 'graph') {
					void this.setMode('graph');
				}
			});

			this.bodyEl = this.contentEl.createDiv({
				cls: 'proxima-view-body',
			});
		} else {
			this.listBtn?.toggleClass('is-active', this.mode === 'list');
			this.graphBtn?.toggleClass('is-active', this.mode === 'graph');
		}
	}

	async setMode(mode: 'list' | 'graph'): Promise<void> {
		if (this.mode === mode) return;
		this.mode = mode;
		this.plugin.settings.sidebarViewMode = mode;
		void this.plugin.saveSettings();

		// Instantly update button selection in UI
		this.ensureLayout();

		// Instantly render in-tab loading state
		this.renderLoading(
			mode === 'graph' ? 'Loading…' : 'Finding related notes…',
		);

		await this.refresh();
	}

	private cleanupGraph(): void {
		if (this.graphEngine) {
			this.graphEngine.destroy();
			this.graphEngine = null;
		}
		this.graphControls = null;
		this.rawGraphData = null;
	}

	renderLoading(message: string): void {
		this.ensureLayout();
		this.cleanupGraph();
		this.bodyEl!.empty();
		const container = this.bodyEl!.createDiv({
			cls: 'proxima-empty-state-container',
		});
		const loadingBox = container.createDiv({
			cls: 'proxima-loading-state',
		});
		loadingBox.createDiv({
			cls: 'proxima-loading-spinner',
		});
		loadingBox.createDiv({
			cls: 'proxima-loading-text',
			text: message,
		});
	}

	renderEmptyState(message: string): void {
		this.ensureLayout();
		this.cleanupGraph();
		this.bodyEl!.empty();
		const container = this.bodyEl!.createDiv({
			cls: 'proxima-empty-state-container',
		});
		container.createDiv({
			cls: 'proxima-empty-state',
			text: message,
		});
	}

	async refresh(): Promise<void> {
		const reqId = ++this.currentRequestId;
		this.mode = this.plugin.settings.sidebarViewMode ?? 'list';
		this.ensureLayout();
		const brain = this.plugin.brain;
		if (!brain.isReady) {
			const embStatus = brain.embeddingStatus;
			const rerankStatus = brain.rerankerStatus;

			if (embStatus?.state === 'downloading') {
				this.renderEmptyState(
					`Downloading model (${embStatus.progress ?? 0}%)`,
				);
				return;
			}
			if (rerankStatus?.state === 'downloading') {
				this.renderEmptyState(
					`Downloading model (${rerankStatus.progress ?? 0}%)`,
				);
				return;
			}
			if (
				embStatus?.state === 'loading' ||
				rerankStatus?.state === 'loading'
			) {
				this.renderEmptyState('Loading model…');
				return;
			}
			if (brain.progress?.isIndexing) {
				this.renderEmptyState(
					`Indexing (${brain.progress.done}/${brain.progress.total})…`,
				);
				return;
			}
			if (!brain.started) {
				this.renderEmptyState('Loading model…');
				return;
			}
		}

		if (brain.progress?.isIndexing) {
			this.renderEmptyState(
				`Indexing (${brain.progress.done}/${brain.progress.total})…`,
			);
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.renderEmptyState('Open a note to see related notes');
			return;
		}

		if (this.mode === 'graph') {
			if (!this.bodyEl?.querySelector('.proxima-loading-state')) {
				this.renderLoading('Loading…');
			}
			const graphData = await brain.getGraphData({
				type: 'note',
				path: file.path,
			});
			if (reqId !== this.currentRequestId) return;
			if (graphData.nodes.length === 0) {
				this.renderEmptyState('No related notes found');
				return;
			}
			this.renderGraph(graphData);
			return;
		}

		if (!this.bodyEl?.querySelector('.proxima-loading-state')) {
			this.renderLoading('Finding related notes…');
		}
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cursorLine = activeView?.editor?.getCursor().line;
		const cursorHeading =
			typeof cursorLine === 'number'
				? this.getActiveHeadingAtCursor(file, cursorLine)
				: undefined;

		const strategy = this.plugin.settings.retrievalStrategy ?? 'maxsim';
		const related = await brain.relatedTo(file.path, {
			strategy,
			cursorLine,
			cursorHeading,
		});
		if (reqId !== this.currentRequestId) return;

		if (related.length === 0) {
			this.renderEmptyState('No related notes found');
			return;
		}

		this.renderResults(related);
	}

	private renderGraph(data: GraphData): void {
		this.ensureLayout();
		this.cleanupGraph();
		this.bodyEl!.empty();
		const graphContainer = this.bodyEl!.createDiv({
			cls: 'proxima-context-graph-sidebar-container',
		});

		this.graphEngine = new ContextGraphEngine(graphContainer, {
			onNodeClick: (node) => {
				if (node.filePath && !node.isSeed) {
					this.graphEngine?.optimisticFocus(node.id, node.label);
					void this.plugin.brain
						.getGraphData({ type: 'note', path: node.filePath })
						.then((d) => this.applyGraphData(d));
				}
			},
			onNodeDoubleClick: (node) => {
				if (node.filePath) {
					void this.navigateTo(node.filePath);
				}
			},
		});

		this.graphControls = new GraphControls(graphContainer, this.plugin, () => {
			this.applyGraphData(this.rawGraphData);
		});

		this.applyGraphData(data);
	}

	private applyGraphData(data: GraphData | null): void {
		if (!data || !this.graphEngine) return;
		this.rawGraphData = data;
		const opts = this.graphControls?.getOptions() ?? {
			showRelated: true,
			showWikilinks: false,
		};
		this.graphEngine.setData(filterGraphData(data, opts));
	}

	private renderResults(related: RelatedNote[]): void {
		this.ensureLayout();
		this.cleanupGraph();
		this.bodyEl!.empty();
		const listEl = this.bodyEl!.createDiv({
			cls: 'proxima-related-notes',
		});

		const maxNotes = this.plugin.settings.maxRelatedNotes ?? 10;
		const maxChunks = this.plugin.settings.maxChunksPerNote ?? 3;

		const semantic = related
			.filter((n) => (n.chunks?.length ?? 0) > 0)
			.slice(0, maxNotes);
		const linkOnly = related.filter((n) => (n.chunks?.length ?? 0) === 0);

		for (const note of [...semantic, ...linkOnly]) {
			const cardEl = listEl.createDiv({
				cls: 'proxima-related-note-card',
			});

			const headerEl = cardEl.createDiv({
				cls: 'proxima-related-note-header',
			});
			const iconEl = headerEl.createSpan({
				cls: 'proxima-related-note-icon',
			});
			setIcon(iconEl, 'file-text');

			const noteTitle = this.getNoteTitle(note.filePath);
			headerEl.createSpan({
				cls: 'proxima-related-note-title',
				text: noteTitle,
			});

			this.renderBadges(headerEl, note);

			const firstChunkLine = note.chunks?.[0]?.record?.startLine;
			this.registerDomEvent(headerEl, 'click', () => {
				void this.navigateTo(note.filePath, firstChunkLine);
			});

			const sectionsEl = cardEl.createDiv({
				cls: 'proxima-related-note-sections',
			});

			const chunks = (note.chunks ?? []).slice(0, maxChunks);
			for (const chunk of chunks) {
				const sectionItemEl = sectionsEl.createDiv({
					cls: 'proxima-related-section-item',
				});

				sectionItemEl.createSpan({
					cls: 'proxima-related-section-bullet',
					text: '•',
				});

				const { label } = getSectionDisplay(chunk.record);
				sectionItemEl.createSpan({
					cls: 'proxima-related-section-text',
					text: label,
				});

				const chunkLine = chunk.record?.startLine;
				this.registerDomEvent(sectionItemEl, 'click', () => {
					void this.navigateTo(note.filePath, chunkLine);
				});
			}
		}
	}

	private getNoteTitle(filePath: string): string {
		const basename = filePath.split('/').pop() ?? filePath;
		return basename.replace(/\.md$/, '');
	}

	private renderBadges(headerEl: HTMLElement, note: RelatedNote): void {
		if (note.linkDirection === 'out' || note.linkDirection === 'both') {
			this.createBadge(headerEl, '→ Link', 'proxima-badge proxima-badge--link-out', 'You link to this note');
		}
		if (note.linkDirection === 'in' || note.linkDirection === 'both') {
			this.createBadge(headerEl, '← Link', 'proxima-badge proxima-badge--link-in', 'This note links here');
		}
		if ((note.chunks?.length ?? 0) > 0) {
			this.createBadge(headerEl, 'Related', 'proxima-badge proxima-badge--related', 'Semantically related');
		}
	}

	private createBadge(headerEl: HTMLElement, text: string, cls: string, title: string): void {
		const badge = headerEl.createSpan({ cls, text });
		badge.setAttr('aria-label', title);
		badge.setAttr('title', title);
	}

	private async navigateTo(
		filePath: string,
		line?: number,
	): Promise<void> {
		const inNewTab = this.plugin.settings.openInNewTab;
		await this.app.workspace.openLinkText(
			filePath,
			'',
			inNewTab ? 'tab' : false,
		);

		if (typeof line === 'number') {
			const activeView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView?.editor) {
				activeView.editor.setCursor({ line, ch: 0 });
				activeView.editor.scrollIntoView(
					{ from: { line, ch: 0 }, to: { line, ch: 0 } },
					true,
				);
			}
		}
	}

	private getActiveHeadingAtCursor(
		file: TFile,
		cursorLine: number,
	): string | undefined {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.headings || cache.headings.length === 0) {
			return undefined;
		}
		let activeHeading: string | undefined;
		for (const h of cache.headings) {
			if (h.position.start.line <= cursorLine) {
				activeHeading = h.heading;
			} else {
				break;
			}
		}
		return activeHeading;
	}
}
