import { describe, it, expect } from 'vitest';
import { relatedNotes, mergeLinkedNotes } from '../../src/search/related';
import type { ScoredChunk } from '../../src/index/chunk-index';

function scored(filePath: string, text: string, score: number): ScoredChunk {
	return {
		record: {
			id: `id-${text}`,
			filePath,
			headingPath: [text],
			titleContext: text,
			text,
			vectorRow: 0,
		},
		score,
	};
}

describe('relatedNotes', () => {
	it('groups chunks by file, best note first', () => {
		const results = relatedNotes(
			[
				scored('a.md', 'a1', 0.9),
				scored('b.md', 'b1', 0.95),
				scored('a.md', 'a2', 0.8),
			],
			{ maxNotes: 10, maxChunksPerNote: 3 },
		);
		expect(results.map((r) => r.filePath)).toEqual(['b.md', 'a.md']);
		expect(results[0]?.bestScore).toBeCloseTo(0.95);
	});

	it('excludes the active note', () => {
		const results = relatedNotes(
			[scored('self.md', 's1', 0.99), scored('other.md', 'o1', 0.5)],
			{ excludeFile: 'self.md', maxNotes: 10, maxChunksPerNote: 3 },
		);
		expect(results.map((r) => r.filePath)).toEqual(['other.md']);
	});

	it('keeps only the top chunks per note, sorted by score', () => {
		const results = relatedNotes(
			[
				scored('a.md', 'worst', 0.6),
				scored('a.md', 'best', 0.9),
				scored('a.md', 'mid', 0.7),
			],
			{ maxNotes: 10, maxChunksPerNote: 2 },
		);
		expect(results[0]?.chunks.map((c) => c.record.text)).toEqual([
			'best',
			'mid',
		]);
	});

	it('limits the number of notes', () => {
		const results = relatedNotes(
			[
				scored('a.md', 'a1', 0.9),
				scored('b.md', 'b1', 0.8),
				scored('c.md', 'c1', 0.7),
			],
			{ maxNotes: 2, maxChunksPerNote: 3 },
		);
		expect(results.map((r) => r.filePath)).toEqual(['a.md', 'b.md']);
	});

	it('returns an empty list when nothing matches', () => {
		expect(
			relatedNotes([], { maxNotes: 10, maxChunksPerNote: 3 }),
		).toEqual([]);
	});
});

describe('mergeLinkedNotes', () => {
	it('annotates semantic notes with their wikilink direction', () => {
		const notes = [
			{ filePath: 'a.md', bestScore: 0.9, chunks: [scored('a.md', 'a', 0.9)] },
			{ filePath: 'b.md', bestScore: 0.8, chunks: [scored('b.md', 'b', 0.8)] },
			{ filePath: 'c.md', bestScore: 0.7, chunks: [scored('c.md', 'c', 0.7)] },
		];
		const out = mergeLinkedNotes(notes, 'self.md', {
			outgoing: ['a.md', 'b.md'],
			incoming: ['b.md'],
		});
		expect(out[0]?.linkDirection).toBe('out');
		expect(out[1]?.linkDirection).toBe('both');
		expect(out[2]?.linkDirection).toBeUndefined();
	});

	it('appends linked-only notes after semantic matches', () => {
		const notes = [
			{ filePath: 'a.md', bestScore: 0.9, chunks: [scored('a.md', 'a', 0.9)] },
		];
		const out = mergeLinkedNotes(notes, 'self.md', {
			outgoing: ['linked.md'],
			incoming: ['back.md'],
		});
		expect(out.map((n) => n.filePath)).toEqual(['a.md', 'linked.md', 'back.md']);
		expect(out[1]?.linkDirection).toBe('out');
		expect(out[1]?.chunks).toEqual([]);
		expect(out[2]?.linkDirection).toBe('in');
	});

	it('excludes the source note and de-duplicates links', () => {
		const out = mergeLinkedNotes([], 'self.md', {
			outgoing: ['self.md', 'x.md'],
			incoming: ['x.md'],
		});
		expect(out.map((n) => n.filePath)).toEqual(['x.md']);
		expect(out[0]?.linkDirection).toBe('both');
	});
});
