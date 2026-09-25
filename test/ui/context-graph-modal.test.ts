import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextGraphModal } from '../../src/ui/graph/context-graph-modal';
import { TFile, type MockElement } from '../mocks/obsidian';
import type { App } from 'obsidian';
import type ProximaPlugin from '../../src/main';
import type { GraphData, GraphNode } from '../../src/search/graph';
import type { ContextGraphEngine } from '../../src/ui/graph/context-graph-engine';

interface ModalInternalAccess {
	engine: ContextGraphEngine;
	handleNodeClick(node: GraphNode): void;
}

describe('ContextGraphModal', () => {
	let modal: ContextGraphModal;
	let mockPlugin: ProximaPlugin;
	let mockOpenLinkText: ReturnType<typeof vi.fn>;
	let mockGetGraphData: ReturnType<typeof vi.fn>;
	let mockSetActiveLeaf: ReturnType<typeof vi.fn>;
	let mockGetLeavesOfType: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockOpenLinkText = vi.fn().mockResolvedValue(undefined);
		mockSetActiveLeaf = vi.fn();
		mockGetLeavesOfType = vi.fn().mockReturnValue([]);

		const sampleGraph: GraphData = {
			seed: { type: 'note', path: 'Active.md' },
			nodes: [
				{ id: 'Active.md', label: 'Active', filePath: 'Active.md', isSeed: true, hop: 0, radius: 10 },
				{ id: 'Related.md', label: 'Related', filePath: 'Related.md', isSeed: false, hop: 1, radius: 7 },
			],
			edges: [{ id: 'Active---Related', source: 'Active.md', target: 'Related.md', similarity: 0.88 }],
		};

		mockGetGraphData = vi.fn().mockResolvedValue(sampleGraph);

		const activeFile = Object.assign(new TFile(), { path: 'Active.md' });

		const mockApp = {
			workspace: {
				getActiveFile: vi.fn().mockReturnValue(activeFile),
				openLinkText: mockOpenLinkText,
				getLeavesOfType: mockGetLeavesOfType,
				setActiveLeaf: mockSetActiveLeaf,
			},
		};

		mockPlugin = {
			app: mockApp,
			settings: {
				openInNewTab: true,
				maxRelatedNotes: 10,
				minScore: 0.45,
			},
			brain: {
				isReady: true,
				getGraphData: mockGetGraphData,
			},
		} as unknown as ProximaPlugin;

		modal = new ContextGraphModal(mockApp as unknown as App, mockPlugin);
	});

	afterEach(() => {
		modal.close();
		vi.useRealTimers();
	});

	it('creates UI elements when opened', async () => {
		modal.open();
		await vi.runAllTimersAsync();

		const searchInput = modal.contentEl.querySelector('.proxima-context-graph-search-input');
		expect(searchInput).toBeDefined();

		const centerTitle = modal.contentEl.querySelector('.proxima-context-graph-center-title');
		expect(centerTitle).toBeDefined();
		expect(centerTitle?.textContent).toBe('Active');

		const openBtn = modal.contentEl.querySelector('.proxima-context-graph-open-btn');
		expect(openBtn).toBeDefined();
	});

	it('relies on Obsidian system close button and does not create duplicate custom close button', async () => {
		modal.open();
		await vi.runAllTimersAsync();

		const customClose = modal.contentEl.querySelector('.proxima-context-graph-close-btn');
		expect(customClose).toBeNull();
	});

	it('seeds graph from query when search input changes after 800ms debounce', async () => {
		modal.open();
		await vi.runAllTimersAsync();

		const searchInput = modal.contentEl.querySelector(
			'.proxima-context-graph-search-input',
		) as unknown as MockElement & { value?: string; attributes?: Record<string, string> };
		expect(searchInput.attributes?.placeholder).toBe('Search…');
		searchInput.value = 'artificial intelligence';
		// Trigger input event
		const inputListeners = searchInput.eventListeners['input'] ?? [];
		for (const fn of inputListeners) {
			fn({ target: searchInput });
		}

		mockGetGraphData.mockClear();

		// At 700ms (cognitive pause mid-typing): should NOT trigger yet
		await vi.advanceTimersByTimeAsync(700);
		expect(mockGetGraphData).not.toHaveBeenCalled();

		// Fast-forward remaining 100ms (total 800ms): triggers search
		await vi.advanceTimersByTimeAsync(100);

		expect(vi.mocked(mockGetGraphData)).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'query', query: 'artificial intelligence' }),
		);
	});

	it('immediately searches on Enter key without waiting for debounce', async () => {
		modal.open();
		await vi.runAllTimersAsync();

		const searchInput = modal.contentEl.querySelector(
			'.proxima-context-graph-search-input',
		) as unknown as MockElement & { value?: string };
		searchInput.value = 'instant search query';

		mockGetGraphData.mockClear();

		// Trigger keydown Enter
		const keydownListeners = searchInput.eventListeners['keydown'] ?? [];
		for (const fn of keydownListeners) {
			fn({ key: 'Enter', preventDefault: vi.fn() });
		}

		// 0ms delay: should have executed immediately
		await vi.advanceTimersByTimeAsync(0);

		expect(vi.mocked(mockGetGraphData)).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'query', query: 'instant search query' }),
		);
	});

	it('shows clear button when text is entered and clears instantly on click', async () => {
		modal.open();
		await vi.runAllTimersAsync();

		const searchInput = modal.contentEl.querySelector(
			'.proxima-context-graph-search-input',
		) as unknown as MockElement & { value?: string; focus: () => void };
		searchInput.focus = vi.fn();
		const clearBtn = modal.contentEl.querySelector('.proxima-context-graph-search-clear') as unknown as MockElement;

		expect(clearBtn.className).toContain('is-hidden');

		// Enter text
		searchInput.value = 'something';
		for (const fn of searchInput.eventListeners['input'] ?? []) {
			fn({ target: searchInput });
		}
		expect(clearBtn.className).not.toContain('is-hidden');

		mockGetGraphData.mockClear();

		// Click clear button
		clearBtn.click();
		await vi.advanceTimersByTimeAsync(0);

		expect(searchInput.value).toBe('');
		expect(clearBtn.className).toContain('is-hidden');
		expect(searchInput.focus).toHaveBeenCalled();

		// Reseeds immediately to active note
		expect(vi.mocked(mockGetGraphData)).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'note', path: 'Active.md' }),
		);
	});

	it('toggles is-loading class on search container while query is executing', async () => {
		let resolveQuery!: (data: GraphData) => void;
		// The initial active-file reseed resolves immediately so the modal's
		// opening loading glow completes (its requestAnimationFrame loop is a
		// 0ms timer under fake timers and would otherwise spin forever).
		mockGetGraphData.mockReturnValueOnce(
			Promise.resolve({
				seed: { type: 'note', path: 'Active.md' },
				nodes: [
					{ id: 'Active.md', label: 'Active', filePath: 'Active.md', isSeed: true, hop: 0, radius: 10 },
				],
				edges: [],
			}),
		);
		// The search query hangs until we resolve it below.
		mockGetGraphData.mockReturnValue(new Promise((res) => { resolveQuery = res; }));

		modal.open();
		await vi.runAllTimersAsync();

		const searchContainer = modal.contentEl.querySelector('.proxima-context-graph-search-container');
		const searchInput = modal.contentEl.querySelector(
			'.proxima-context-graph-search-input',
		) as unknown as MockElement & { value?: string };
		searchInput.value = 'deep learning';

		// Trigger Enter
		for (const fn of searchInput.eventListeners['keydown'] ?? []) {
			fn({ key: 'Enter', preventDefault: vi.fn() });
		}
		await vi.advanceTimersByTimeAsync(0);

		// Container should have is-loading class
		expect(searchContainer?.className).toContain('is-loading');

		// Resolve query
		resolveQuery({
			seed: { type: 'query', query: 'deep learning' },
			nodes: [{ id: '__query__', label: '"deep learning"', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		});
		await vi.advanceTimersByTimeAsync(0);

		// Container should remove is-loading class
		expect(searchContainer?.className).not.toContain('is-loading');
	});

	it('focuses existing tab if note is already open in a markdown leaf without closing modal', async () => {
		const mockLeaf = {
			view: {
				file: { path: 'Active.md' },
			},
		};
		mockGetLeavesOfType.mockReturnValue([mockLeaf]);
		const closeSpy = vi.spyOn(modal, 'close');

		modal.open();
		await vi.runAllTimersAsync();

		const openBtn = modal.contentEl.querySelector(
			'.proxima-context-graph-open-btn',
		) as unknown as MockElement | null;
		openBtn?.click();

		expect(mockSetActiveLeaf).toHaveBeenCalledWith(mockLeaf, { focus: true });
		expect(mockOpenLinkText).not.toHaveBeenCalled();
		expect(closeSpy).not.toHaveBeenCalled();
	});

	it('opens note in a tab without closing modal when not already open in any leaf', async () => {
		mockGetLeavesOfType.mockReturnValue([]);
		const closeSpy = vi.spyOn(modal, 'close');

		modal.open();
		await vi.runAllTimersAsync();

		const openBtn = modal.contentEl.querySelector(
			'.proxima-context-graph-open-btn',
		) as unknown as MockElement | null;
		openBtn?.click();
		await Promise.resolve();

		expect(mockSetActiveLeaf).not.toHaveBeenCalled();
		expect(vi.mocked(mockOpenLinkText)).toHaveBeenCalledWith('Active.md', '', 'tab');
		expect(closeSpy).not.toHaveBeenCalled();
	});

	it('optimistically focuses node and updates badge immediately on node click before reseed completes', async () => {
		let resolveReseed: ((val: GraphData) => void) | undefined;
		const pendingPromise = new Promise<GraphData>((resolve) => {
			resolveReseed = resolve;
		});
		// Make getGraphData hang initially
		mockGetGraphData.mockReturnValueOnce(
			Promise.resolve({
				seed: { type: 'note', path: 'Active.md' },
				nodes: [
					{ id: 'Active.md', label: 'Active', filePath: 'Active.md', isSeed: true, hop: 0, radius: 10 },
					{ id: 'Related.md', label: 'Related', filePath: 'Related.md', isSeed: false, hop: 1, radius: 7 },
				],
				edges: [{ id: 'Active---Related', source: 'Active.md', target: 'Related.md', similarity: 0.88 }],
			}),
		).mockReturnValueOnce(pendingPromise);

		modal.open();
		await vi.runAllTimersAsync();

		const modalInternal = modal as unknown as ModalInternalAccess;
		const engine = modalInternal.engine;
		const optimisticFocusSpy = vi.spyOn(engine, 'optimisticFocus');

		// Click peripheral node
		modalInternal.handleNodeClick({
			id: 'Related.md',
			label: 'Related',
			filePath: 'Related.md',
			isSeed: false,
			hop: 1,
		});

		// Check immediate optimistic reaction
		expect(optimisticFocusSpy).toHaveBeenCalledWith('Related.md', 'Related');
		const centerTitle = modal.contentEl.querySelector('.proxima-context-graph-center-title');
		expect(centerTitle?.textContent).toBe('Related');

		// Resolve background reseed
		resolveReseed?.({
			seed: { type: 'note', path: 'Related.md' },
			nodes: [{ id: 'Related.md', label: 'Related', filePath: 'Related.md', isSeed: true, hop: 0, radius: 10 }],
			edges: [],
		});
		await vi.runAllTimersAsync();
	});
});
