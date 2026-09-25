import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	RelatedNotesView,
	VIEW_TYPE_RELATED,
} from '../../src/ui/related-notes-view';
import { TFile, WorkspaceLeaf } from 'obsidian';
import type ProximaPlugin from '../../src/main';
import type { BrainProgress } from '../../src/brain';
import type { RelatedNote } from '../../src/search/related';
import type { GraphData } from '../../src/search/graph';

describe('RelatedNotesView', () => {
	let mockLeaf: WorkspaceLeaf;
	let mockPlugin: ProximaPlugin;
	let progressListeners: Array<(progress: BrainProgress) => void>;

	let mockGetActiveFile: ReturnType<typeof vi.fn>;
	let mockGetActiveViewOfType: ReturnType<typeof vi.fn>;
	let mockOpenLinkText: ReturnType<typeof vi.fn>;
	let mockWorkspaceOn: ReturnType<typeof vi.fn>;
	let mockRelatedTo: ReturnType<typeof vi.fn>;
	let mockGetGraphData: ReturnType<typeof vi.fn>;
	let mockSaveSettings: ReturnType<typeof vi.fn>;

	let brainIsReady = true;
	let brainProgress: BrainProgress = {
		isIndexing: false,
		done: 0,
		total: 0,
		currentFile: '',
		lastIndexedAt: null,
	};
	let embeddingStatusState: {
		state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
		progress?: number;
	} = { state: 'ready' };

	beforeEach(() => {
		vi.useFakeTimers();
		progressListeners = [];
		brainIsReady = true;
		brainProgress = {
			isIndexing: false,
			done: 0,
			total: 0,
			currentFile: '',
			lastIndexedAt: null,
		};
		embeddingStatusState = { state: 'ready' };

		const file = Object.assign(new TFile(), { path: 'Notes/Alpha.md' });
		mockGetActiveFile = vi.fn().mockReturnValue(file);
		mockGetActiveViewOfType = vi.fn().mockReturnValue(null);
		mockOpenLinkText = vi.fn().mockResolvedValue(undefined);
		mockWorkspaceOn = vi.fn();
		mockRelatedTo = vi.fn().mockResolvedValue([]);

		mockGetGraphData = vi.fn().mockResolvedValue({
			seed: { type: 'note', path: 'Notes/Alpha.md' },
			nodes: [{ id: 'Notes/Alpha.md', label: 'Alpha', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		});

		mockLeaf = new WorkspaceLeaf();
		mockSaveSettings = vi.fn().mockResolvedValue(undefined);
		const pluginStub = {
			saveSettings: mockSaveSettings,
			settings: {
				openInNewTab: true,
				retrievalStrategy: 'maxsim' as const,
				maxRelatedNotes: 10,
				maxChunksPerNote: 3,
				sidebarViewMode: 'list' as const,
			},
			brain: {
				get isReady() {
					return brainIsReady;
				},
				started: true,
				get embeddingStatus() {
					return embeddingStatusState;
				},
				rerankerStatus: { state: 'ready' as const },
				get progress() {
					return brainProgress;
				},
				onProgress: vi.fn((listener: (p: BrainProgress) => void) => {
					progressListeners.push(listener);
					return () => {
						const idx = progressListeners.indexOf(listener);
						if (idx >= 0) progressListeners.splice(idx, 1);
					};
				}),
				relatedTo: mockRelatedTo,
				getGraphData: mockGetGraphData,
			},
			app: {
				workspace: {
					getActiveFile: mockGetActiveFile,
					getActiveViewOfType: mockGetActiveViewOfType,
					openLinkText: mockOpenLinkText,
					getLeaf: vi.fn().mockReturnValue({
						openFile: vi.fn().mockResolvedValue(undefined),
					}),
					on: mockWorkspaceOn,
				},
				metadataCache: {
					getFileCache: vi.fn().mockReturnValue(null),
				},
			},
		};
		mockPlugin = pluginStub as unknown as ProximaPlugin;
		(mockLeaf as unknown as { app: unknown }).app = mockPlugin.app;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('defines correct view metadata', () => {
		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		expect(VIEW_TYPE_RELATED).toBe('brain-related-notes');
		expect(view.getViewType()).toBe('brain-related-notes');
		expect(view.getDisplayText()).toBe('Related notes');
		expect(view.getIcon()).toBe('brain-circuit');
	});

	it('renders empty state: downloading model', async () => {
		brainIsReady = false;
		embeddingStatusState = { state: 'downloading', progress: 42 };

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const emptyEl = view.contentEl.querySelector('.proxima-empty-state');
		expect(emptyEl).not.toBeNull();
		expect(emptyEl?.textContent).toBe('Downloading model (42%)');
	});

	it('renders empty state: loading model', async () => {
		brainIsReady = false;
		embeddingStatusState = { state: 'loading' };

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const emptyEl = view.contentEl.querySelector('.proxima-empty-state');
		expect(emptyEl).not.toBeNull();
		expect(emptyEl?.textContent).toBe('Loading model…');
	});

	it('renders empty state: indexing in progress', async () => {
		brainIsReady = false;
		brainProgress = {
			isIndexing: true,
			done: 23,
			total: 150,
			currentFile: '',
			lastIndexedAt: null,
		};

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const emptyEl = view.contentEl.querySelector('.proxima-empty-state');
		expect(emptyEl).not.toBeNull();
		expect(emptyEl?.textContent).toBe('Indexing (23/150)…');
	});

	it('renders empty state: no active note', async () => {
		mockGetActiveFile.mockReturnValue(null);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const emptyEl = view.contentEl.querySelector('.proxima-empty-state');
		expect(emptyEl).not.toBeNull();
		expect(emptyEl?.textContent).toBe('Open a note to see related notes');
	});

	it('renders empty state: no related notes found', async () => {
		mockRelatedTo.mockResolvedValue([]);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const emptyEl = view.contentEl.querySelector('.proxima-empty-state');
		expect(emptyEl).not.toBeNull();
		expect(emptyEl?.textContent).toBe('No related notes found');
	});

	it('renders note cards and sections with headings and snippets', async () => {
		const sampleResults: RelatedNote[] = [
			{
				filePath: 'Folder/Beta.md',
				bestScore: 0.88,
				chunks: [
					{
						score: 0.88,
						record: {
							id: '1',
							filePath: 'Folder/Beta.md',
							headingPath: ['Beta', 'Methods', 'Extraction'],
							startLine: 12,
							endLine: 25,
							text: 'Chunk with section heading text',
							titleContext: 'Extraction',
							vectorRow: 0,
						},
					},
					{
						score: 0.75,
						record: {
							id: '2',
							filePath: 'Folder/Beta.md',
							headingPath: ['Beta'],
							startLine: 40,
							endLine: 50,
							text: 'Chunk without section heading text designed to test snippet truncation.',
							titleContext: 'Beta',
							vectorRow: 1,
						},
					},
				],
			},
		];
		mockRelatedTo.mockResolvedValue(sampleResults);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const cards = view.contentEl.querySelectorAll('.proxima-related-note-card');
		expect(cards.length).toBe(1);

		const title = view.contentEl.querySelector('.proxima-related-note-title');
		expect(title?.textContent).toBe('Beta');

		const sections = view.contentEl.querySelectorAll('.proxima-related-section-item');
		expect(sections.length).toBe(2);

		const secTexts = view.contentEl.querySelectorAll('.proxima-related-section-text');
		expect(secTexts[0]?.textContent).toBe('Extraction');
		expect(secTexts[1]?.textContent).toContain('Chunk without section heading text');
	});

	it('navigates to note and line on note header click (new tab)', async () => {
		const mockEditor = {
			setCursor: vi.fn(),
			scrollIntoView: vi.fn(),
			getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
		};
		mockGetActiveViewOfType.mockReturnValue({
			editor: mockEditor,
		});

		const sampleResults: RelatedNote[] = [
			{
				filePath: 'Folder/Beta.md',
				bestScore: 0.9,
				chunks: [
					{
						score: 0.9,
						record: {
							id: '1',
							filePath: 'Folder/Beta.md',
							headingPath: ['Beta', 'Overview'],
							startLine: 15,
							endLine: 30,
							text: 'Text',
							titleContext: 'Overview',
							vectorRow: 0,
						},
					},
				],
			},
		];
		mockRelatedTo.mockResolvedValue(sampleResults);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const header = view.contentEl.querySelector<HTMLElement>('.proxima-related-note-header');
		expect(header).not.toBeNull();
		header?.click();
		await Promise.resolve();

		expect(mockOpenLinkText).toHaveBeenCalledWith(
			'Folder/Beta.md',
			'',
			'tab',
		);
		expect(mockEditor.setCursor).toHaveBeenCalledWith({ line: 15, ch: 0 });
		expect(mockEditor.scrollIntoView).toHaveBeenCalledWith(
			{ from: { line: 15, ch: 0 }, to: { line: 15, ch: 0 } },
			true,
		);
	});

	it('navigates to note and line on note header click (current tab)', async () => {
		mockPlugin.settings.openInNewTab = false;
		const mockEditor = {
			setCursor: vi.fn(),
			scrollIntoView: vi.fn(),
			getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
		};
		mockGetActiveViewOfType.mockReturnValue({
			editor: mockEditor,
		});

		const sampleResults: RelatedNote[] = [
			{
				filePath: 'Folder/Beta.md',
				bestScore: 0.9,
				chunks: [
					{
						score: 0.9,
						record: {
							id: '1',
							filePath: 'Folder/Beta.md',
							headingPath: ['Beta'],
							startLine: 20,
							endLine: 30,
							text: 'Text',
							titleContext: 'Beta',
							vectorRow: 0,
						},
					},
				],
			},
		];
		mockRelatedTo.mockResolvedValue(sampleResults);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const header = view.contentEl.querySelector<HTMLElement>('.proxima-related-note-header');
		header?.click();
		await Promise.resolve();

		expect(mockOpenLinkText).toHaveBeenCalledWith(
			'Folder/Beta.md',
			'',
			false,
		);
		expect(mockEditor.setCursor).toHaveBeenCalledWith({ line: 20, ch: 0 });
	});

	it('navigates to specific section chunk line on section click', async () => {
		const mockEditor = {
			setCursor: vi.fn(),
			scrollIntoView: vi.fn(),
			getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
		};
		mockGetActiveViewOfType.mockReturnValue({
			editor: mockEditor,
		});

		const sampleResults: RelatedNote[] = [
			{
				filePath: 'Folder/Beta.md',
				bestScore: 0.9,
				chunks: [
					{
						score: 0.9,
						record: {
							id: '1',
							filePath: 'Folder/Beta.md',
							headingPath: ['Beta', 'Intro'],
							startLine: 5,
							endLine: 10,
							text: 'Intro',
							titleContext: 'Intro',
							vectorRow: 0,
						},
					},
					{
						score: 0.85,
						record: {
							id: '2',
							filePath: 'Folder/Beta.md',
							headingPath: ['Beta', 'Deep Dive'],
							startLine: 45,
							endLine: 60,
							text: 'Deep dive text',
							titleContext: 'Deep Dive',
							vectorRow: 1,
						},
					},
				],
			},
		];
		mockRelatedTo.mockResolvedValue(sampleResults);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const sections = view.contentEl.querySelectorAll<HTMLElement>('.proxima-related-section-item');
		const targetSection = sections[1];
		targetSection?.click();
		await Promise.resolve();

		expect(mockOpenLinkText).toHaveBeenCalledWith(
			'Folder/Beta.md',
			'',
			'tab',
		);
		expect(mockEditor.setCursor).toHaveBeenCalledWith({ line: 45, ch: 0 });
	});

	it('coalesces rapid active-leaf-change events with 300ms debounce', async () => {
		let leafChangeCallback: (() => void) | undefined;
		mockWorkspaceOn.mockImplementation((event: string, cb: () => void) => {
			if (event === 'active-leaf-change') {
				leafChangeCallback = cb;
			}
			return { id: 'event-ref' };
		});

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		view.onload();
		mockRelatedTo.mockClear();

		// Trigger multiple rapid events
		leafChangeCallback?.();
		leafChangeCallback?.();
		leafChangeCallback?.();

		expect(mockRelatedTo).not.toHaveBeenCalled();

		// Advance timer past 300ms
		await vi.advanceTimersByTimeAsync(300);

		expect(mockRelatedTo).toHaveBeenCalledTimes(1);
	});

	it('triggers refresh when reindexing completes (isIndexing: true -> false)', async () => {
		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		view.onload();
		mockRelatedTo.mockClear();

		expect(progressListeners.length).toBe(1);
		const onProgress = progressListeners[0];

		// Simulate indexing starting
		onProgress?.({
			isIndexing: true,
			done: 1,
			total: 10,
			currentFile: '',
			lastIndexedAt: null,
		});
		expect(mockRelatedTo).not.toHaveBeenCalled();

		// Simulate indexing finishing
		onProgress?.({
			isIndexing: false,
			done: 10,
			total: 10,
			currentFile: '',
			lastIndexedAt: null,
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(mockRelatedTo).toHaveBeenCalledTimes(1);
	});

	it('renders view toggle buttons and switches to graph mode', async () => {
		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const toggleGroup = view.contentEl.querySelector('.proxima-view-toggle-group');
		expect(toggleGroup).toBeDefined();

		const toggles = view.contentEl.querySelectorAll('.proxima-view-toggle');
		expect(toggles.length).toBe(2);

		const graphToggle = toggles[1] as unknown as { click?: () => void; textContent?: string } | undefined;
		expect(graphToggle?.textContent).toBe('Graph');

		// Click Graph toggle
		graphToggle?.click?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(mockPlugin.settings.sidebarViewMode).toBe('graph');
		expect(mockSaveSettings).toHaveBeenCalled();
		expect(mockGetGraphData).toHaveBeenCalledWith({
			type: 'note',
			path: 'Notes/Alpha.md',
		});

		const canvas = view.contentEl.querySelector('canvas');
		expect(canvas).toBeDefined();
	});

	it('renders clean bullet points for section chunks instead of accordion chevrons', async () => {
		const sampleResults: RelatedNote[] = [
			{
				filePath: 'Folder/Beta.md',
				bestScore: 0.9,
				chunks: [
					{
						score: 0.9,
						record: {
							id: '1',
							filePath: 'Folder/Beta.md',
							headingPath: ['Beta', 'Overview'],
							startLine: 15,
							endLine: 30,
							text: 'Text',
							titleContext: 'Overview',
							vectorRow: 0,
						},
					},
				],
			},
		];
		mockRelatedTo.mockResolvedValue(sampleResults);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const bullet = view.contentEl.querySelector('.proxima-related-section-bullet');
		expect(bullet).not.toBeNull();
		expect(bullet?.textContent).toContain('•');

		// Chevron icon should NOT be present in section items
		const chevron = view.contentEl.querySelector('.proxima-related-section-icon svg');
		expect(chevron).toBeNull();
	});

	it('instantly switches toggle button highlight and shows in-tab loading state on switch', async () => {
		// Make getGraphData hang until resolved
		let resolveGraph!: (data: GraphData) => void;
		mockGetGraphData.mockReturnValue(new Promise((res) => { resolveGraph = res; }));

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh(); // initial list view

		const toggles = view.contentEl.querySelectorAll('.proxima-view-toggle');
		const listBtn = toggles[0] as unknown as { className: string };
		const graphBtn = toggles[1] as unknown as { className: string; click: () => void };

		expect(listBtn.className).toContain('is-active');
		expect(graphBtn.className).not.toContain('is-active');

		// Click Graph button
		graphBtn.click();

		// Immediately (synchronously), button state should have flipped
		expect(graphBtn.className).toContain('is-active');
		expect(listBtn.className).not.toContain('is-active');

		// In-tab loading state should be displayed immediately
		const loadingState = view.contentEl.querySelector('.proxima-loading-state');
		expect(loadingState).not.toBeNull();
		expect(view.contentEl.querySelector('.proxima-loading-text')?.textContent).toBe('Loading…');

		// Resolve graph data
		resolveGraph({
			seed: { type: 'note', path: 'Notes/Alpha.md' },
			nodes: [{ id: 'Notes/Alpha.md', label: 'Alpha', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		});
		await vi.advanceTimersByTimeAsync(0);

		// Now canvas is rendered and loading state is cleared
		expect(view.contentEl.querySelector('canvas')).toBeDefined();
		expect(view.contentEl.querySelector('.proxima-loading-state')).toBeNull();
	});

	it('renders link and related badges on note cards', async () => {
		const chunkRecord = {
			id: '1',
			filePath: 'Folder/Beta.md',
			headingPath: ['Beta'],
			startLine: 1,
			endLine: 3,
			text: 'Text',
			titleContext: 'Beta',
			vectorRow: 0,
		};
		const sampleResults: RelatedNote[] = [
			{
				filePath: 'Folder/Beta.md',
				bestScore: 0.9,
				chunks: [{ score: 0.9, record: chunkRecord }],
				linkDirection: 'out',
			},
			{
				filePath: 'Folder/LinkedOnly.md',
				bestScore: 0,
				chunks: [],
				linkDirection: 'in',
			},
		];
		mockRelatedTo.mockResolvedValue(sampleResults);

		const view = new RelatedNotesView(mockLeaf, mockPlugin);
		await view.refresh();

		const cards = view.contentEl.querySelectorAll('.proxima-related-note-card');
		expect(cards.length).toBe(2);

		const badges = view.contentEl.querySelectorAll('.proxima-badge');
		expect(badges.length).toBe(3);
		expect(badges[0]?.textContent).toBe('→ Link');
		expect(badges[1]?.textContent).toBe('Related');
		expect(badges[2]?.textContent).toBe('← Link');
	});
});
