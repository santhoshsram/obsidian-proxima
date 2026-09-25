import { describe, it, expect, vi } from 'vitest';
import {
	DEFAULT_SETTINGS,
	formatLastIndexed,
	formatModelStatus,
	renderModelStatus,
} from '../src/settings';

describe('settings', () => {
	it('includes lastIndexedAt default as null', () => {
		expect(DEFAULT_SETTINGS.lastIndexedAt).toBeNull();
	});

	it('defaults debugLogging to false', () => {
		expect(DEFAULT_SETTINGS.debugLogging).toBe(false);
	});

	it('defaults retrievalStrategy to maxsim', () => {
		expect(DEFAULT_SETTINGS.retrievalStrategy).toBe('maxsim');
	});

	it('defaults openInNewTab to true', () => {
		expect(DEFAULT_SETTINGS.openInNewTab).toBe(true);
	});

	it('defaults sidebarViewMode to list', () => {
		expect(DEFAULT_SETTINGS.sidebarViewMode).toBe('list');
	});

	it('defaults graphShowRelated to true', () => {
		expect(DEFAULT_SETTINGS.graphShowRelated).toBe(true);
	});

	it('defaults graphShowWikilinks to false', () => {
		expect(DEFAULT_SETTINGS.graphShowWikilinks).toBe(false);
	});

	it('formats null or undefined timestamp as Never', () => {
		expect(formatLastIndexed(null)).toBe('Never');
		expect(formatLastIndexed(undefined)).toBe('Never');
	});

	it('formats a timestamp for today with time', () => {
		const now = new Date();
		const formatted = formatLastIndexed(now.getTime());
		expect(formatted).toContain('Today at');
	});

	it('formats an older timestamp with date and time', () => {
		const past = new Date('2024-01-15T12:00:00Z');
		const formatted = formatLastIndexed(past.getTime());
		expect(formatted).not.toContain('Today');
		expect(formatted).toContain('Jan');
		expect(formatted).toContain('15');
	});

	it('formats model statuses correctly', () => {
		expect(formatModelStatus(undefined)).toBe('Not loaded');
		expect(formatModelStatus({ state: 'idle' })).toBe('Not loaded');
		expect(formatModelStatus({ state: 'downloading', progress: 45 })).toBe(
			'Downloading (45%)',
		);
		expect(formatModelStatus({ state: 'loading' })).toBe('Loading…');
		expect(formatModelStatus({ state: 'ready', device: 'webgpu' })).toBe(
			'Ready (WEBGPU)',
		);
		expect(formatModelStatus({ state: 'ready' })).toBe('Ready');
		expect(formatModelStatus({ state: 'error' })).toBe('Failed to load');
	});

	it('renders model status into DOM with correct classes', () => {
		const createdSpans: Array<{ cls?: string; text?: string }> = [];
		const fakeEl = {
			empty: vi.fn(),
			createSpan: vi.fn((opts?: { cls?: string; text?: string }) => {
				createdSpans.push(opts ?? {});
				return fakeEl;
			}),
		} as unknown as HTMLElement;

		renderModelStatus(fakeEl, { state: 'ready', device: 'webgpu' });
		expect(
			createdSpans.some(
				(s) =>
					s.text === 'Ready (WEBGPU)' &&
					s.cls?.includes('is-ready'),
			),
		).toBe(true);

		createdSpans.length = 0;
		renderModelStatus(fakeEl, { state: 'downloading', progress: 50 });
		expect(
			createdSpans.some(
				(s) =>
					s.text === 'Downloading (50%)' &&
					s.cls?.includes('is-downloading'),
			),
		).toBe(true);
	});
});
