import { App, ButtonComponent, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';
import type ProximaPlugin from './main';
import type { BrainProgress } from './brain';
import {
	EMBEDDING_MODELS,
	DEFAULT_MODEL,
	RERANKER_MODELS,
	DEFAULT_RERANKER,
} from './embed/models';
import type { RetrievalStrategy } from './search/retrieval';

export interface ProximaSettings {
	/** Hugging Face model ID used for embeddings. */
	embeddingModel: string;
	/** Hugging Face model ID used for reranking. */
	rerankerModel: string;
	/** Whether cross-encoder reranking is enabled. */
	rerankerEnabled: boolean;

	/** Whether to open related notes in a new tab or the current tab. */
	openInNewTab: boolean;
	/** Default retrieval strategy for related notes. */
	retrievalStrategy: RetrievalStrategy;
	/** Max related notes shown for the active note. */
	maxRelatedNotes: number;
	/** Max matching chunks shown per related note. */
	maxChunksPerNote: number;
	/** Minimum cosine similarity (0–1) for a chunk to count as related. */
	minScore: number;
	/** Emit debug/info index logs to the console (timing, device, …). */
	debugLogging: boolean;
	/** Timestamp (ms) of the last successful indexing run. */
	lastIndexedAt: number | null;

	/** Preferred companion view mode in sidebar (list or graph). */
	sidebarViewMode: 'list' | 'graph';

	/** Show semantic edges in the graph. */
	graphShowRelated: boolean;
	/** Show wikilink edges/nodes in the graph. */
	graphShowWikilinks: boolean;
}

export const DEFAULT_SETTINGS: ProximaSettings = {
	embeddingModel: DEFAULT_MODEL.modelId,
	rerankerModel: DEFAULT_RERANKER.modelId,
	rerankerEnabled: true,

	openInNewTab: true,
	retrievalStrategy: 'maxsim',
	maxRelatedNotes: 10,
	maxChunksPerNote: 3,
	minScore: 0.45,
	debugLogging: false,
	lastIndexedAt: null,

	sidebarViewMode: 'list',
	graphShowRelated: true,
	graphShowWikilinks: false,
};

export interface ModelStatus {
	state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
	progress?: number;
	device?: string;
	error?: string;
}

export function formatModelStatus(status?: ModelStatus): string {
	if (!status || status.state === 'idle') {
		return 'Not loaded';
	}
	if (status.state === 'downloading') {
		return `Downloading (${status.progress ?? 0}%)`;
	}
	if (status.state === 'loading') {
		return 'Loading…';
	}
	if (status.state === 'ready') {
		return status.device ? `Ready (${status.device.toUpperCase()})` : 'Ready';
	}
	if (status.state === 'error') {
		return 'Failed to load';
	}
	return 'Unknown';
}

/** Render formatted status into container with color classes (ready=green, downloading=normal). */
export function renderModelStatus(
	containerEl: HTMLElement,
	status?: ModelStatus,
): void {
	containerEl.empty();
	containerEl.createSpan({
		cls: 'proxima-model-status-label',
		text: 'Status: ',
	});
	const formatted = formatModelStatus(status);
	const isReady = status?.state === 'ready';
	const isDownloading = status?.state === 'downloading';
	const cls = [
		'proxima-model-status-value',
		isReady ? 'is-ready' : '',
		isDownloading ? 'is-downloading' : '',
	]
		.filter(Boolean)
		.join(' ');
	containerEl.createSpan({ cls, text: formatted });
}

/** Format a millisecond timestamp into human-readable local time or 'Never'. */
export function formatLastIndexed(
	timestamp: number | null | undefined,
): string {
	if (!timestamp) return 'Never';
	const date = new Date(timestamp);
	const isToday = new Date().toDateString() === date.toDateString();
	const timeStr = date.toLocaleTimeString([], {
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
	return isToday
		? `Today at ${timeStr}`
		: date.toLocaleString([], {
				month: 'short',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
				second: '2-digit',
		  });
}

export class ProximaSettingTab extends PluginSettingTab {
	plugin: ProximaPlugin;

	constructor(app: App, plugin: ProximaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * embeddingModel and debugLogging trigger side effects beyond persistence
	 * (reindex, logger reconfiguration) that the declarative control schema
	 * has no hook for, so persistence is intercepted here instead.
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		if (key === 'debugLogging') {
			this.plugin.refreshLogger();
		} else if (key === 'embeddingModel') {
			this.plugin.brain?.resetForModelChange();
			void this.plugin.startBrain();
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				items: [
					{
						name: 'Open related notes in new tab',
						desc: 'Open related notes in a new tab instead of the current tab.',
						control: { type: 'toggle', key: 'openInNewTab' },
					},
				],
			},
			{
				type: 'group',
				items: [this.vaultIndexingDefinition()],
			},
			{
				type: 'group',
				items: [this.embeddingModelDefinition(), this.rerankerModelDefinition()],
			},
			{
				type: 'group',
				items: [
					this.matchingModeDefinition(),
					this.sliderDefinition('maxRelatedNotes', {
						name: 'Related notes',
						desc: 'Maximum number of related notes to show.',
						min: 1,
						max: 25,
						step: 1,
					}),
					this.sliderDefinition('maxChunksPerNote', {
						name: 'Sections per note',
						desc: 'Maximum number of matching sections shown per related note.',
						min: 1,
						max: 5,
						step: 1,
					}),
					this.sliderDefinition('minScore', {
						name: 'Minimum similarity',
						desc:
							'Minimum similarity score (0–1) for a section to count as ' +
							'related. Higher means fewer, closer matches.',
						min: 0,
						max: 1,
						step: 0.05,
					}),
				],
			},
			{
				type: 'group',
				items: [this.debugLoggingDefinition()],
			},
		];
	}

	private sliderDefinition(
		key: 'maxRelatedNotes' | 'maxChunksPerNote' | 'minScore',
		opts: { name: string; desc: string; min: number; max: number; step: number },
	): SettingDefinition {
		return {
			name: opts.name,
			desc: opts.desc,
			control: { type: 'slider', key, min: opts.min, max: opts.max, step: opts.step },
		};
	}

	private debugLoggingDefinition(): SettingDefinition {
		return {
			name: 'Debug logging',
			desc:
				'Log indexing timing, device, and per-file progress to the ' +
				'developer console (Cmd+Option+I on Mac, Ctrl+Shift+I on ' +
				'Windows/Linux). Leave on while troubleshooting performance.',
			control: { type: 'toggle', key: 'debugLogging' },
		};
	}

	private matchingModeDefinition(): SettingDefinition {
		const desc = createFragment((el) => {
			el.createDiv({
				text: 'Choose how Proxima finds related notes:',
			});
			const list = el.createEl('ul');
			const li1 = list.createEl('li');
			li1.createEl('strong', { text: 'Detailed: ' });
			li1.appendText(
				'Retrieves best matches for each section in the note and then picks the top matches across these.',
			);
			const li2 = list.createEl('li');
			li2.createEl('strong', { text: 'Focused: ' });
			li2.appendText(
				'Retrieves the best matches for the section or paragraph under your cursor.',
			);
			const li3 = list.createEl('li');
			li3.createEl('strong', { text: 'Broad: ' });
			li3.appendText(
				'Retrieves the best matches using an overall summary of the full note.',
			);
		});

		return {
			name: 'Matching mode',
			desc,
			control: {
				type: 'dropdown',
				key: 'retrievalStrategy',
				defaultValue: 'maxsim',
				options: {
					maxsim: 'Detailed (recommended)',
					cursor: 'Focused',
					mean: 'Broad',
				},
			},
		};
	}

	private vaultIndexingDefinition(): SettingDefinition {
		return {
			name: 'Vault indexing',
			render: (setting) => {
				let indexButton: ButtonComponent;
				setting
					.setClass('proxima-vault-setting')
					.setDesc(
						'Load the embedding model and index the vault. Runs automatically on startup and file changes.',
					)
					.addButton((button) => {
						indexButton = button;
						button.onClick(() => {
							void this.plugin.startBrain();
						});
					});

				const progressContainer = setting.descEl.createDiv({
					cls: 'proxima-indexing-progress',
				});
				const progressRow = progressContainer.createDiv({ cls: 'proxima-progress-row' });
				const progressCount = progressRow.createSpan({ cls: 'proxima-progress-count' });
				const progressBar = progressRow.createEl('progress', { cls: 'proxima-progress-bar' });
				const statsEl = progressContainer.createDiv({ cls: 'proxima-progress-file' });
				const lastIndexedEl = progressContainer.createDiv({ cls: 'proxima-progress-last-indexed' });

				const vault: VaultIndexingCard = {
					indexButton: indexButton!,
					progressRow,
					progressCount,
					progressBar,
					statsEl,
					lastIndexedEl,
				};
				return this.plugin.brain?.onProgress((p) => this.updateVaultCard(vault, p));
			},
		};
	}

	private embeddingModelDefinition(): SettingDefinition {
		return {
			name: 'Embedding model',
			render: (setting) => {
				let embeddingDropdown: HTMLSelectElement;
				setting
					.setClass('proxima-model-setting')
					.setDesc(
						'Local model used for semantic search. Changing models triggers a re-index. ' +
							'Models are downloaded once from Hugging Face on first use and cached locally.',
					)
					.addDropdown((dropdown) => {
						for (const [id, spec] of Object.entries(EMBEDDING_MODELS)) {
							const label = spec.displayName
								? spec.hint
									? `${spec.displayName} (${spec.hint})`
									: spec.displayName
								: id;
							dropdown.addOption(id, label);
						}
						const selected =
							EMBEDDING_MODELS[this.plugin.settings.embeddingModel]
								? this.plugin.settings.embeddingModel
								: DEFAULT_MODEL.modelId;
						dropdown.setValue(selected);
						embeddingDropdown = dropdown.selectEl;
						dropdown.onChange(async (value) => {
							await this.setControlValue('embeddingModel', value);
						});
					});

				const card: ModelCard = {
					dropdown: embeddingDropdown!,
					...this.renderModelStatusRow(setting),
				};
				return this.plugin.brain?.onProgress((p) => {
					card.dropdown.disabled = p.isIndexing;
					this.updateModelCard(card, p.embeddingStatus ?? this.plugin.brain?.embeddingStatus);
				});
			},
		};
	}

	private rerankerModelDefinition(): SettingDefinition {
		return {
			name: 'Reranking model',
			render: (setting) => {
				let rerankerDropdown: HTMLSelectElement;
				setting
					.setClass('proxima-model-setting')
					.addDropdown((dropdown) => {
						for (const [id, spec] of Object.entries(RERANKER_MODELS)) {
							const label = spec.displayName || id;
							dropdown.addOption(id, label);
						}
						const selected =
							RERANKER_MODELS[this.plugin.settings.rerankerModel]
								? this.plugin.settings.rerankerModel
								: DEFAULT_RERANKER.modelId;
						dropdown.setValue(selected).setDisabled(true);
						rerankerDropdown = dropdown.selectEl;
					});

				const card: ModelCard = {
					dropdown: rerankerDropdown!,
					...this.renderModelStatusRow(setting),
				};
				return this.plugin.brain?.onProgress((p) =>
					this.updateModelCard(card, p.rerankerStatus ?? this.plugin.brain?.rerankerStatus),
				);
			},
		};
	}

	/** Shared status/progress row under a model dropdown's description. */
	private renderModelStatusRow(setting: Setting): Omit<ModelCard, 'dropdown'> {
		const statusContainer = setting.descEl.createDiv({
			cls: 'proxima-model-status-container',
		});
		const statusEl = statusContainer.createDiv({ cls: 'proxima-model-status' });
		const progressRow = statusContainer.createDiv({ cls: 'proxima-model-progress-row' });
		const progressBar = progressRow.createEl('progress', { cls: 'proxima-model-progress-bar' });
		progressBar.max = 100;
		const progressPct = progressRow.createSpan({ cls: 'proxima-model-progress-pct' });

		return { statusEl, progressRow, progressBar, progressPct };
	}

	private updateVaultCard(vault: VaultIndexingCard, p: BrainProgress): void {
		const isModelBusy = !this.plugin.brain?.isReady && (this.plugin.brain?.started ?? false);
		const isIndexing = p.isIndexing;

		vault.indexButton.setDisabled(isIndexing || isModelBusy);
		vault.indexButton.setButtonText(isIndexing ? 'Indexing…' : 'Reindex vault');
		vault.progressRow.toggleClass('is-invisible', !isIndexing);
		vault.statsEl.setText(p.currentFile || (isIndexing ? 'Scanning vault…' : 'Not indexed yet'));

		const lastIndexed = p.lastIndexedAt ?? this.plugin.settings.lastIndexedAt;
		vault.lastIndexedEl.toggleClass('is-invisible', !lastIndexed);

		if (isIndexing) {
			if (p.total > 0) {
				vault.progressCount.setText(`${p.done}/${p.total} files…`);
				vault.progressBar.value = p.done;
				vault.progressBar.max = p.total;
			} else {
				vault.progressCount.setText('Starting…');
				vault.progressBar.value = 0;
				vault.progressBar.max = 1;
			}
		} else if (lastIndexed) {
			vault.lastIndexedEl.setText(`Last indexed: ${formatLastIndexed(lastIndexed)}`);
		}
	}

	private updateModelCard(card: ModelCard, status: ModelStatus | undefined): void {
		renderModelStatus(card.statusEl, status);
		const isDownloading = status?.state === 'downloading';
		card.progressRow.toggleClass('is-invisible', !isDownloading);
		if (isDownloading) {
			const pct = status?.progress ?? 0;
			card.progressBar.value = pct;
			card.progressPct.setText(`${pct}%`);
		}
	}
}

interface VaultIndexingCard {
	indexButton: ButtonComponent;
	progressRow: HTMLElement;
	progressCount: HTMLElement;
	progressBar: HTMLProgressElement;
	statsEl: HTMLElement;
	lastIndexedEl: HTMLElement;
}

interface ModelCard {
	dropdown: HTMLSelectElement;
	statusEl: HTMLElement;
	progressRow: HTMLElement;
	progressBar: HTMLProgressElement;
	progressPct: HTMLElement;
}
