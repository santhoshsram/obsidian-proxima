/**
 * Context Graph full-screen modal view.
 *
 * Immersive semantic graph overlay with real-time concept search,
 * click-to-recenter semantic exploration, and double-click / button note opening.
 */

import { Modal, type App, setIcon } from 'obsidian';
import type ProximaPlugin from '../../main';
import { ContextGraphEngine } from './context-graph-engine';
import { GraphControls, filterGraphData } from './graph-controls';
import type { GraphData, GraphNode, GraphSeed } from '../../search/graph';
import { debounce, type DebouncedFn } from '../../utils/debounce';

export class ContextGraphModal extends Modal {
	private engine: ContextGraphEngine | null = null;
	private graphControls: GraphControls | null = null;
	private rawGraphData: GraphData | null = null;
	private currentCenterPath: string | null = null;

	private searchWrapper!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private searchClearBtn!: HTMLElement;
	private centerWrapperEl!: HTMLElement;
	private centerTitleEl!: HTMLElement;
	private openButtonEl!: HTMLElement;
	private emptyStateEl!: HTMLElement;

	private debouncedSearch: DebouncedFn<[string]>;
	private currentSearchRequestId = 0;
	private openNoteResetTimeoutId: number | null = null;

	constructor(
		app: App,
		private plugin: ProximaPlugin,
	) {
		super(app);
		this.debouncedSearch = debounce((query: string) => {
			void this.applySearchQuery(query);
		}, 800);
	}

	onOpen(): void {
		this.modalEl.addClass('proxima-context-graph-modal');

		const { contentEl } = this;
		contentEl.empty();

		// 1. Top floating overlay header
		const headerEl = contentEl.createDiv({
			cls: 'proxima-context-graph-header',
		});

		// Left: Search input
		this.searchWrapper = headerEl.createDiv({
			cls: 'proxima-context-graph-search-container',
		});
		const searchIconEl = this.searchWrapper.createSpan({
			cls: 'proxima-context-graph-search-icon',
		});
		setIcon(searchIconEl, 'search');

		this.searchInput = this.searchWrapper.createEl('input', {
			cls: 'proxima-context-graph-search-input',
			attr: {
				type: 'text',
				placeholder: 'Search…',
			},
		});

		this.searchClearBtn = this.searchWrapper.createSpan({
			cls: 'proxima-context-graph-search-clear is-hidden',
		});
		setIcon(this.searchClearBtn, 'x');
		this.searchClearBtn.addEventListener('click', () => {
			this.searchInput.value = '';
			this.updateClearButton();
			this.debouncedSearch.cancel();
			void this.applySearchQuery('');
			this.searchInput.focus();
		});

		this.searchInput.addEventListener('input', (e: Event) => {
			const target = e.target as HTMLInputElement;
			const val = target?.value ?? '';
			this.updateClearButton();
			const trimmed = val.trim();
			if (!trimmed) {
				this.debouncedSearch.cancel();
				void this.applySearchQuery('');
			} else {
				this.debouncedSearch(trimmed);
			}
		});

		this.searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.debouncedSearch.cancel();
				const val = this.searchInput.value.trim();
				void this.applySearchQuery(val);
			} else if (e.key === 'Escape') {
				if (this.searchInput.value) {
					e.stopPropagation();
					this.searchInput.value = '';
					this.updateClearButton();
					this.debouncedSearch.cancel();
					void this.applySearchQuery('');
				}
			}
		});

		// Right: Active node badge + Open note button
		this.centerWrapperEl = headerEl.createDiv({
			cls: 'proxima-context-graph-center-container',
		});
		this.centerTitleEl = this.centerWrapperEl.createSpan({
			cls: 'proxima-context-graph-center-title',
			text: 'Proxima Graph',
		});
		this.openButtonEl = this.centerWrapperEl.createEl('button', {
			cls: 'proxima-context-graph-open-btn',
			text: 'Open note ↗',
		});
		this.openButtonEl.addEventListener('click', () => {
			if (this.currentCenterPath) {
				void this.openNote(this.currentCenterPath);
			}
		});

		// 2. Canvas Container
		const canvasContainer = contentEl.createDiv({
			cls: 'proxima-context-graph-canvas-container',
		});

		this.emptyStateEl = contentEl.createDiv({
			cls: 'proxima-context-graph-empty is-hidden',
		});

		// 3. Mount engine
		this.engine = new ContextGraphEngine(canvasContainer, {
			onNodeClick: (node) => {
				this.handleNodeClick(node);
			},
			onNodeDoubleClick: (node) => {
				this.handleNodeDoubleClick(node);
			},
		});

		this.graphControls = new GraphControls(canvasContainer, this.plugin, () => {
			this.applyGraphData(this.rawGraphData);
		});

		// 4. Initial seed — show the loading glow immediately so the modal
		// isn't blank while the first graph fetch is in flight.
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			this.engine.optimisticFocus('__init__', activeFile.basename);
			void this.reseed({ type: 'note', path: activeFile.path });
		} else {
			this.setCenterBadge('', null);
			this.showEmptyState('Open a note or search a concept to start exploring');
		}
	}

	private updateClearButton(): void {
		if (this.searchInput.value.length > 0) {
			this.searchClearBtn.removeClass('is-hidden');
		} else {
			this.searchClearBtn.addClass('is-hidden');
		}
	}

	private handleNodeClick(node: GraphNode): void {
		if (node.filePath && !node.isSeed) {
			this.searchInput.value = '';
			this.updateClearButton();
			this.debouncedSearch.cancel();
			this.engine?.optimisticFocus(node.id, node.label);
			this.setCenterBadge(node.label, node.filePath);
			void this.reseed({ type: 'note', path: node.filePath });
		}
	}

	private handleNodeDoubleClick(node: GraphNode): void {
		if (node.filePath) {
			void this.openNote(node.filePath);
		}
	}

	private async applySearchQuery(query: string): Promise<void> {
		const requestId = ++this.currentSearchRequestId;
		this.searchWrapper.addClass('is-loading');

		try {
			if (!query) {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					await this.reseed({ type: 'note', path: activeFile.path }, requestId);
				} else {
					this.showEmptyState('Type a query to explore semantic connections');
				}
				return;
			}

			// Optimistic canvas focus: show radiating pulse around query node
			this.engine?.optimisticFocus('__query__', `"${query}"`);
			this.setCenterBadge(`"${query}"`, null);

			await this.reseed({ type: 'query', query }, requestId);
		} finally {
			if (requestId === this.currentSearchRequestId) {
				this.searchWrapper.removeClass('is-loading');
			}
		}
	}

	private async reseed(seed: GraphSeed, requestId?: number): Promise<void> {
		const brain = this.plugin.brain;
		if (!brain.isReady) {
			this.showEmptyState('Brain index is loading…');
			return;
		}

		const data: GraphData = await brain.getGraphData(seed);
		if (requestId !== undefined && requestId !== this.currentSearchRequestId) {
			return;
		}
		if (data.nodes.length === 0) {
			if (seed.type === 'note') {
				this.showEmptyState('Note not found in index or has no content');
			} else {
				this.showEmptyState(`No notes related to "${seed.query}"`);
			}
			return;
		}

		this.hideEmptyState();

		if (seed.type === 'note') {
			const base = seed.path.split('/').pop()?.replace(/\.md$/, '') ?? seed.path;
			this.setCenterBadge(base, seed.path);
		} else {
			this.setCenterBadge(`"${seed.query}"`, null);
		}

		this.applyGraphData(data);
	}

	private applyGraphData(data: GraphData | null): void {
		if (!data || !this.engine) return;
		this.rawGraphData = data;
		const opts = this.graphControls?.getOptions() ?? {
			showRelated: true,
			showWikilinks: false,
		};
		this.engine.setData(filterGraphData(data, opts));
	}

	private setCenterBadge(label: string, filePath: string | null): void {
		this.currentCenterPath = filePath;
		this.centerTitleEl.setText(label);
		if (filePath) {
			this.openButtonEl.removeClass('is-hidden');
			this.centerWrapperEl.removeClass('is-open-btn-hidden');
		} else {
			this.openButtonEl.addClass('is-hidden');
			this.centerWrapperEl.addClass('is-open-btn-hidden');
		}
	}

	private showEmptyState(msg: string): void {
		this.emptyStateEl.setText(msg);
		this.emptyStateEl.removeClass('is-hidden');
	}

	private hideEmptyState(): void {
		this.emptyStateEl.addClass('is-hidden');
	}

	private async openNote(filePath: string): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		const existingLeaf = leaves.find((leaf) => {
			const view = leaf.view as { file?: { path: string } } | undefined;
			return view?.file?.path === filePath;
		});

		if (existingLeaf) {
			this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
		} else {
			const inNewTab = this.plugin.settings.openInNewTab;
			await this.app.workspace.openLinkText(
				filePath,
				'',
				inNewTab ? 'tab' : false,
			);
		}

		if (this.openButtonEl) {
			const origText = this.openButtonEl.textContent || 'Open note ↗';
			this.openButtonEl.setText('Opened ✓');
			if (this.openNoteResetTimeoutId !== null) {
				window.clearTimeout(this.openNoteResetTimeoutId);
			}
			this.openNoteResetTimeoutId = window.setTimeout(() => {
				this.openNoteResetTimeoutId = null;
				if (this.openButtonEl && this.openButtonEl.textContent === 'Opened ✓') {
					this.openButtonEl.setText(origText);
				}
			}, 1200);
		}
	}

	onClose(): void {
		if (this.openNoteResetTimeoutId !== null) {
			window.clearTimeout(this.openNoteResetTimeoutId);
			this.openNoteResetTimeoutId = null;
		}
		this.debouncedSearch.cancel();
		this.engine?.destroy();
		this.engine = null;
		this.contentEl.empty();
	}
}
