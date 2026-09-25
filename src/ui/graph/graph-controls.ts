/**
 * Graph legend + Related/Linked toggle controls, and pure data filtering.
 *
 * The controls are mounted in both the sidebar graph and the full-screen
 * modal. Toggling re-filters the raw GraphData before it reaches the engine,
 * so layout (orbit vs. similarity band) recomputes correctly.
 */

import type ProximaPlugin from '../../main';
import type { GraphData, GraphNode } from '../../search/graph';

export interface GraphViewOptions {
	showRelated: boolean;
	showWikilinks: boolean;
}

function edgeEndpointId(endpoint: string | GraphNode): string {
	return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

/**
 * Filter GraphData to the enabled link types. When a type is hidden, its
 * provenance fields are stripped from survivors so physics/rendering treat
 * them as purely the remaining type.
 */
export function filterGraphData(data: GraphData, opts: GraphViewOptions): GraphData {
	let nodes = data.nodes;
	let edges = data.edges;

	if (opts.showWikilinks) {
		// Wikilink precedence over semantic hop roles: a note that is both a
		// wikilink target and a hop-2 satellite is promoted to a first-class
		// hop-1 orbit node (green, on the ring) instead of a dim satellite.
		nodes = nodes.map((n) =>
			(n.viaLink || n.linkDirection) && n.hop > 1
				? { ...n, hop: 1, parentId: undefined, radius: 7 }
				: n,
		);
	} else {
		nodes = nodes
			.filter((n) => !n.viaLink)
			.map((n) => ({ ...n, viaLink: undefined, linkDirection: undefined }));
		edges = edges
			.filter((e) => !(e.wikiLink && e.similarity === undefined))
			.map((e) => ({ ...e, wikiLink: undefined }));
	}

	if (!opts.showRelated) {
		nodes = nodes.filter(
			(n) => n.isSeed || n.viaLink || n.linkDirection !== undefined,
		);
		edges = edges
			.filter((e) => Boolean(e.wikiLink))
			.map((e) => ({ ...e, similarity: undefined }));
	}

	const nodeIds = new Set(nodes.map((n) => n.id));
	edges = edges.filter((e) => {
		const s = edgeEndpointId(e.source);
		const t = edgeEndpointId(e.target);
		return nodeIds.has(s) && nodeIds.has(t);
	});

	return { ...data, nodes, edges };
}

export class GraphControls {
	private relatedCb: HTMLInputElement;
	private linkedCb: HTMLInputElement;

	constructor(
		container: HTMLElement,
		private plugin: ProximaPlugin,
		private onChange: () => void,
	) {
		const panel = container.createDiv({ cls: 'proxima-graph-controls' });

		const legend = panel.createDiv({ cls: 'proxima-graph-legend' });
		this.legendItem(legend, 'Related', 'proxima-graph-legend-swatch--related');
		this.legendItem(legend, 'Linked', 'proxima-graph-legend-swatch--linked');

		const toggles = panel.createDiv({ cls: 'proxima-graph-control-toggles' });
		this.relatedCb = this.renderToggle(toggles, 'Related', 'graphShowRelated', 'graphShowWikilinks');
		this.linkedCb = this.renderToggle(toggles, 'Linked', 'graphShowWikilinks', 'graphShowRelated');

		this.updateActive();
	}

	getOptions(): GraphViewOptions {
		return {
			showRelated: this.plugin.settings.graphShowRelated !== false,
			showWikilinks: this.plugin.settings.graphShowWikilinks === true,
		};
	}

	private legendItem(parent: HTMLElement, label: string, swatchCls: string): void {
		const item = parent.createDiv({ cls: 'proxima-graph-legend-item' });
		item.createSpan({ cls: `proxima-graph-legend-swatch ${swatchCls}` });
		item.createSpan({ cls: 'proxima-graph-legend-label', text: label });
	}

	private renderToggle(
		parent: HTMLElement,
		label: string,
		key: 'graphShowRelated' | 'graphShowWikilinks',
		otherKey: 'graphShowRelated' | 'graphShowWikilinks',
	): HTMLInputElement {
		const row = parent.createDiv({ cls: 'proxima-graph-control-row' });
		const cb = row.createEl('input', {
			cls: 'proxima-graph-control-toggle',
			attr: { type: 'checkbox', id: `proxima-graph-toggle-${key}` },
		});
		row.createEl('label', {
			attr: { for: `proxima-graph-toggle-${key}` },
			text: label,
		});
		cb.addEventListener('click', () => {
			this.toggle(key, otherKey, cb);
		});
		return cb;
	}

	private toggle(
		key: 'graphShowRelated' | 'graphShowWikilinks',
		otherKey: 'graphShowRelated' | 'graphShowWikilinks',
		cb: HTMLInputElement,
	): void {
		const current = this.plugin.settings[key] !== false;
		// Prevent turning off the last enabled link type.
		if (current && this.plugin.settings[otherKey] === false) {
			cb.checked = true;
			this.updateActive();
			return;
		}
		this.plugin.settings[key] = !current;
		void this.plugin.saveSettings();
		this.updateActive();
		this.onChange();
	}

	private updateActive(): void {
		this.relatedCb.checked = this.plugin.settings.graphShowRelated !== false;
		this.linkedCb.checked = this.plugin.settings.graphShowWikilinks === true;
	}
}
