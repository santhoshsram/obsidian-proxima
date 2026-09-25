import { describe, it, expect } from 'vitest';
import { createObsidianLinkResolver } from '../../src/obsidian/link-resolver';
import type { App } from 'obsidian';

function mockApp(resolvedLinks: Record<string, Record<string, number>>): App {
	return {
		metadataCache: { resolvedLinks },
	} as unknown as App;
}

describe('createObsidianLinkResolver', () => {
	it('returns resolved outgoing markdown links, excluding non-markdown', () => {
		const app = mockApp({ 'A.md': { 'B.md': 1, 'note.png': 1 } });
		const resolver = createObsidianLinkResolver(app);
		expect(resolver.outgoing('A.md')).toEqual(['B.md']);
	});

	it('returns incoming backlinks across the whole vault', () => {
		const app = mockApp({
			'B.md': { 'A.md': 1 },
			'C.md': { 'A.md': 2, 'D.md': 1 },
		});
		const resolver = createObsidianLinkResolver(app);
		expect(resolver.incoming('A.md').sort()).toEqual(['B.md', 'C.md']);
	});

	it('returns empty arrays for notes with no links', () => {
		const app = mockApp({ 'A.md': {} });
		const resolver = createObsidianLinkResolver(app);
		expect(resolver.outgoing('X.md')).toEqual([]);
		expect(resolver.incoming('X.md')).toEqual([]);
	});

	it('excludes non-markdown backlink sources', () => {
		const app = mockApp({ 'canvas.canvas': { 'A.md': 1 } });
		const resolver = createObsidianLinkResolver(app);
		expect(resolver.incoming('A.md')).toEqual([]);
	});
});
