/**
 * Resolves wikilinks for a note from Obsidian's live metadata cache.
 *
 * Outgoing links are the targets of `[[...]]` links authored in the note;
 * incoming links are backlinks (notes that link to this note). Unresolved
 * (dangling) links are never present in `resolvedLinks`, so they are
 * naturally excluded.
 */

import type { App } from 'obsidian';

export interface LinkResolver {
	/** Resolved markdown paths this note links to. */
	outgoing(path: string): string[];
	/** Resolved markdown paths that link to this note (backlinks). */
	incoming(path: string): string[];
}

function isMarkdown(path: string): boolean {
	return path.endsWith('.md');
}

/** Build a resolver backed by `app.metadataCache.resolvedLinks`. */
export function createObsidianLinkResolver(app: App): LinkResolver {
	// The metadata cache is always present in Obsidian, but test fakes may
	// omit `app` or its cache; guard so semantic-only call sites never crash.
	const getResolved = (): Record<string, Record<string, number>> => {
		const cache = (
			app as
				| {
						metadataCache?: {
							resolvedLinks?: Record<string, Record<string, number>>;
						};
				  }
				| undefined
		)?.metadataCache;
		return cache?.resolvedLinks ?? {};
	};

	return {
		outgoing(path: string): string[] {
			const targets = getResolved()[path];
			if (!targets) return [];
			return Object.keys(targets).filter(isMarkdown);
		},
		incoming(path: string): string[] {
			const backlinks: string[] = [];
			for (const [source, targets] of Object.entries(getResolved())) {
				if (targets && path in targets) {
					backlinks.push(source);
				}
			}
			return backlinks.filter(isMarkdown);
		},
	};
}
