/**
 * Turn raw chunk-level search results into note-level relatedness:
 * group by file, keep the top chunks per note, rank notes by their best
 * chunk.
 */

import type { ScoredChunk } from '../index/chunk-index';

export interface RelatedNote {
	filePath: string;
	/** Score of the note's best-matching chunk. */
	bestScore: number;
	/** Top-scoring chunks, best first, at most `maxChunksPerNote`. */
	chunks: ScoredChunk[];
	/** Heading in the source note that produced the strongest match. */
	matchedSourceHeading?: string;
	/**
	 * Wikilink relationship to the source note: 'out' = source links here,
	 * 'in' = this note links to source (backlink), 'both' = mutual links.
	 */
	linkDirection?: 'out' | 'in' | 'both';
}

export interface LinkSets {
	/** Resolved markdown paths the source note links to. */
	outgoing: string[];
	/** Resolved markdown paths that link to the source note. */
	incoming: string[];
}

/**
 * Annotate semantic results with their wikilink direction and append any
 * directly-linked notes that did not surface semantically (the inclusion
 * guarantee). Linked-only notes carry no chunks and are appended after the
 * semantic matches, discovery-first, outside the `maxNotes` limit.
 */
export function mergeLinkedNotes(
	notes: RelatedNote[],
	sourcePath: string,
	links: LinkSets,
): RelatedNote[] {
	const outgoing = new Set(links.outgoing);
	const incoming = new Set(links.incoming);

	const directionFor = (path: string): 'out' | 'in' | 'both' | undefined => {
		const hasOut = outgoing.has(path);
		const hasIn = incoming.has(path);
		if (hasOut && hasIn) return 'both';
		if (hasOut) return 'out';
		if (hasIn) return 'in';
		return undefined;
	};

	const annotated = notes.map((note) => {
		const linkDirection = directionFor(note.filePath);
		return linkDirection ? { ...note, linkDirection } : note;
	});

	const present = new Set(annotated.map((n) => n.filePath));
	const appended: RelatedNote[] = [];
	for (const path of [...outgoing, ...incoming]) {
		if (path === sourcePath || present.has(path)) continue;
		present.add(path);
		appended.push({
			filePath: path,
			bestScore: 0,
			chunks: [],
			linkDirection: directionFor(path),
		});
	}

	return [...annotated, ...appended];
}

export interface RelatedOptions {
	/** Active note to exclude from results (don't relate a note to itself). */
	excludeFile?: string;
	maxNotes: number;
	maxChunksPerNote: number;
}

/**
 * Group scored chunks (assumed pre-filtered by score threshold) into
 * related notes. Input order doesn't matter; output is ranked by each
 * note's best chunk score, descending.
 */
export function relatedNotes(
	scored: ScoredChunk[],
	options: RelatedOptions,
): RelatedNote[] {
	const byFile = new Map<string, ScoredChunk[]>();
	for (const chunk of scored) {
		if (chunk.record.filePath === options.excludeFile) {
			continue;
		}
		const group = byFile.get(chunk.record.filePath);
		if (group) {
			group.push(chunk);
		} else {
			byFile.set(chunk.record.filePath, [chunk]);
		}
	}

	const notes: RelatedNote[] = [];
	for (const [filePath, chunks] of byFile) {
		const bestPerChunk = new Map<string, ScoredChunk>();
		for (const chunk of chunks) {
			const existing = bestPerChunk.get(chunk.record.id);
			if (!existing || chunk.score > existing.score) {
				bestPerChunk.set(chunk.record.id, chunk);
			}
		}
		const uniqueChunks = [...bestPerChunk.values()];
		uniqueChunks.sort((a, b) => b.score - a.score);
		const top = uniqueChunks.slice(0, options.maxChunksPerNote);
		const best = top[0];
		if (best) {
			notes.push({
				filePath,
				bestScore: best.score,
				chunks: top,
				matchedSourceHeading: best.matchedSourceHeading,
			});
		}
	}
	notes.sort((a, b) => b.bestScore - a.bestScore);
	return notes.slice(0, options.maxNotes);
}
