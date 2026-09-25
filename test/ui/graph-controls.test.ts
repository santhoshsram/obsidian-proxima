import { describe, it, expect, vi } from 'vitest';
import { filterGraphData, GraphControls } from '../../src/ui/graph/graph-controls';
import { MockElement } from '../mocks/obsidian';
import type { GraphData } from '../../src/search/graph';
import type ProximaPlugin from '../../src/main';

const data: GraphData = {
	seed: { type: 'note', path: 'Seed.md' },
	nodes: [
		{ id: 'Seed.md', label: 'Seed', filePath: 'Seed.md', isSeed: true, hop: 0 },
		{ id: 'Related.md', label: 'Related', filePath: 'Related.md', isSeed: false, hop: 1, similarity: 0.9 },
		{ id: 'Linked.md', label: 'Linked', filePath: 'Linked.md', isSeed: false, hop: 1, viaLink: true, linkDirection: 'out' },
		{ id: 'Dual.md', label: 'Dual', filePath: 'Dual.md', isSeed: false, hop: 1, similarity: 0.8, linkDirection: 'in' },
	],
	edges: [
		{ id: 'a', source: 'Seed.md', target: 'Related.md', similarity: 0.9 },
		{ id: 'b', source: 'Seed.md', target: 'Linked.md', wikiLink: 'forward' },
		{ id: 'c', source: 'Seed.md', target: 'Dual.md', similarity: 0.8, wikiLink: 'back' },
	],
};

describe('filterGraphData', () => {
	it('returns data unchanged when both types are enabled', () => {
		expect(filterGraphData(data, { showRelated: true, showWikilinks: true })).toEqual(data);
	});

	it('drops wiki-only nodes and pure wiki edges when wikilinks hidden', () => {
		const out = filterGraphData(data, { showRelated: true, showWikilinks: false });
		expect(out.nodes.map((n) => n.id)).toEqual(['Seed.md', 'Related.md', 'Dual.md']);
		expect(out.edges.map((e) => e.id)).toEqual(['a', 'c']);

		const dualEdge = out.edges.find((e) => e.id === 'c');
		expect(dualEdge?.wikiLink).toBeUndefined();
		const dualNode = out.nodes.find((n) => n.id === 'Dual.md');
		expect(dualNode?.linkDirection).toBeUndefined();
	});

	it('drops semantic-only nodes and pure semantic edges when related hidden', () => {
		const out = filterGraphData(data, { showRelated: false, showWikilinks: true });
		expect(out.nodes.map((n) => n.id).sort()).toEqual(['Dual.md', 'Linked.md', 'Seed.md']);
		expect(out.edges.map((e) => e.id).sort()).toEqual(['b', 'c']);

		const dualEdge = out.edges.find((e) => e.id === 'c');
		expect(dualEdge?.similarity).toBeUndefined();
	});
});

describe('GraphControls', () => {
	function makePlugin(settings: { graphShowRelated: boolean; graphShowWikilinks: boolean }) {
		const saveSettings = vi.fn().mockResolvedValue(undefined);
		return {
			plugin: { settings, saveSettings } as unknown as ProximaPlugin,
			saveSettings,
		};
	}

	it('defaults to Related on and Linked off', () => {
		const { plugin } = makePlugin({ graphShowRelated: true, graphShowWikilinks: false });
		const onChange = vi.fn();
		const container = new MockElement('div');
		const controls = new GraphControls(container as unknown as HTMLElement, plugin, onChange);
		expect(controls.getOptions()).toEqual({ showRelated: true, showWikilinks: false });
	});

	it('persists toggles and blocks turning off the last enabled type', () => {
		const { plugin, saveSettings } = makePlugin({ graphShowRelated: true, graphShowWikilinks: false });
		const onChange = vi.fn();
		const container = new MockElement('div');
		const controls = new GraphControls(container as unknown as HTMLElement, plugin, onChange);

		const toggles = container.querySelectorAll('.proxima-graph-control-toggle');
		const relatedCb = toggles[0]!;
		const linkedCb = toggles[1]!;

		// Related on, Linked off: turning Related off is blocked.
		relatedCb.click();
		expect(controls.getOptions()).toEqual({ showRelated: true, showWikilinks: false });
		expect(onChange).not.toHaveBeenCalled();
		expect(saveSettings).not.toHaveBeenCalled();

		// Turn Linked on → persisted.
		linkedCb.click();
		expect(plugin.settings.graphShowWikilinks).toBe(true);
		expect(saveSettings).toHaveBeenCalled();

		// Now Related can be turned off.
		relatedCb.click();
		expect(controls.getOptions()).toEqual({ showRelated: false, showWikilinks: true });
		expect(onChange).toHaveBeenCalled();
	});
});
