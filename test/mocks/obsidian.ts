if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
	(globalThis as unknown as { window: unknown }).window = globalThis;
}

// Vitest runs in plain Node, which lacks browser globals that Obsidian's
// Electron renderer always provides. Production code assumes they exist
// (no feature-detection guards); these globals stand in for the test run.
type G = typeof globalThis & {
	requestAnimationFrame?: (cb: FrameRequestCallback) => number;
	cancelAnimationFrame?: (handle: number) => void;
	ResizeObserver?: typeof ResizeObserver;
};
const g = globalThis as G;

if (typeof g.requestAnimationFrame !== 'function') {
	g.requestAnimationFrame = (cb: FrameRequestCallback): number =>
		setTimeout(() => cb(Date.now()), 0) as unknown as number;
}
if (typeof g.cancelAnimationFrame !== 'function') {
	g.cancelAnimationFrame = (handle: number): void => clearTimeout(handle);
}
if (typeof g.ResizeObserver !== 'function') {
	g.ResizeObserver = class MockResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
}
if (typeof g.getComputedStyle !== 'function') {
	g.getComputedStyle = (() => ({
		getPropertyValue: () => '',
		backgroundColor: '',
	})) as unknown as typeof getComputedStyle;
}
type GDoc = typeof globalThis & { document?: unknown };
const gDoc = globalThis as GDoc;
if (typeof gDoc.document === 'undefined') {
	gDoc.document = { body: {} } as unknown as Document;
}

export class MockElement {
	tagName: string;
	className: string = '';
	children: MockElement[] = [];
	private _textContent: string = '';
	get textContent(): string {
		if (this.children.length === 0) {
			return this._textContent;
		}
		return this._textContent + this.children.map((c) => c.textContent).join(' ');
	}
	set textContent(val: string) {
		this._textContent = val;
	}
	parentElement: MockElement | null = null;
	attributes: Record<string, string> = {};
	eventListeners: Record<string, Array<(e?: any) => void>> = {};
	style: Record<string, string> = {};
	width = 800;
	height = 600;
	checked = false;

	constructor(tagName = 'div') {
		this.tagName = tagName;
	}

	getBoundingClientRect() {
		return {
			left: 0,
			top: 0,
			width: this.width,
			height: this.height,
			right: this.width,
			bottom: this.height,
			x: 0,
			y: 0,
			toJSON: () => {},
		};
	}

	getContext(type: string) {
		if (type === '2d') {
			return {
				canvas: this,
				save: () => {},
				restore: () => {},
				scale: () => {},
				translate: () => {},
				clearRect: () => {},
				beginPath: () => {},
				arc: () => {},
				fill: () => {},
				stroke: () => {},
				moveTo: () => {},
				lineTo: () => {},
				fillText: () => {},
				strokeText: () => {},
				measureText: (text: string) => ({ width: text.length * 7 }),
				createRadialGradient: () => ({ addColorStop: () => {} }),
				fillStyle: '',
				strokeStyle: '',
				shadowColor: '',
				shadowBlur: 0,
				lineWidth: 1,
				font: '',
				textAlign: '',
				textBaseline: '',
				globalAlpha: 1,
			};
		}
		return null;
	}

	appendChild(child: MockElement) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	contains(other: MockElement | null | undefined): boolean {
		if (!other) return false;
		if (other === this) return true;
		let curr = other.parentElement;
		while (curr) {
			if (curr === this) return true;
			curr = curr.parentElement;
		}
		return false;
	}

	remove() {
		if (this.parentElement) {
			const idx = this.parentElement.children.indexOf(this);
			if (idx >= 0) this.parentElement.children.splice(idx, 1);
			this.parentElement = null;
		}
	}

	empty() {
		this.children = [];
		this.textContent = '';
	}

	setText(text: string) {
		this.textContent = text;
		return this;
	}

	setAttr(name: string, value: string) {
		this.attributes[name] = value;
		return this;
	}

	addClass(...classes: string[]) {
		const current = new Set(this.className.split(' ').filter(Boolean));
		for (const c of classes) current.add(c);
		this.className = [...current].join(' ');
		return this;
	}

	removeClass(...classes: string[]) {
		const toRemove = new Set(classes);
		const current = this.className.split(' ').filter((c) => !toRemove.has(c));
		this.className = current.join(' ');
		return this;
	}

	toggleClass(cls: string, val?: boolean) {
		const has = this.className.split(' ').includes(cls);
		const shouldHave = val !== undefined ? val : !has;
		if (shouldHave) {
			this.addClass(cls);
		} else {
			this.removeClass(cls);
		}
		return this;
	}

	createEl(
		tag: string,
		o?: { cls?: string; text?: string; attr?: Record<string, string> },
	) {
		const el = new MockElement(tag);
		if (o?.cls) el.className = o.cls;
		if (o?.text) el.textContent = o.text;
		if (o?.attr) el.attributes = { ...o.attr };
		el.parentElement = this;
		this.children.push(el);
		return el;
	}

	createDiv(o?: { cls?: string; text?: string }) {
		return this.createEl('div', o);
	}

	createSpan(o?: { cls?: string; text?: string }) {
		return this.createEl('span', o);
	}

	addEventListener(type: string, listener: (e?: any) => void) {
		if (!this.eventListeners[type]) this.eventListeners[type] = [];
		this.eventListeners[type].push(listener);
	}

	removeEventListener(type: string, listener: (e?: any) => void) {
		if (this.eventListeners[type]) {
			this.eventListeners[type] = this.eventListeners[type].filter((l) => l !== listener);
		}
	}

	click() {
		for (const fn of this.eventListeners['click'] ?? []) {
			fn();
		}
	}

	querySelector(selector: string): MockElement | null {
		for (const child of this.children) {
			if (
				selector.startsWith('.') &&
				child.className.split(' ').includes(selector.slice(1))
			) {
				return child;
			}
			if (child.tagName.toLowerCase() === selector.toLowerCase()) {
				return child;
			}
			const found = child.querySelector(selector);
			if (found) return found;
		}
		return null;
	}

	querySelectorAll(selector: string): MockElement[] {
		const results: MockElement[] = [];
		for (const child of this.children) {
			if (
				selector.startsWith('.') &&
				child.className.split(' ').includes(selector.slice(1))
			) {
				results.push(child);
			} else if (child.tagName.toLowerCase() === selector.toLowerCase()) {
				results.push(child);
			}
			results.push(...child.querySelectorAll(selector));
		}
		return results;
	}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: any;
	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = new MockElement('div');
	}
}

export class Setting {
	constructor(public containerEl: any) {}
	setName() { return this; }
	setDesc() { return this; }
	addButton() { return this; }
	addToggle(cb?: (toggle: any) => void) {
		if (cb) {
			cb({
				setValue: () => ({ onChange: () => {} }),
			});
		}
		return this;
	}
	addDropdown() { return this; }
	addText() { return this; }
	addSlider() { return this; }
}

export class ButtonComponent {}
export class Notice {
	constructor(public message: string, public duration?: number) {}
}

export class ItemView {
	app: any;
	leaf: any;
	contentEl: MockElement;
	containerEl: MockElement;

	constructor(leaf: any) {
		this.leaf = leaf;
		this.app = leaf?.app;
		this.contentEl = new MockElement('div');
		this.containerEl = new MockElement('div');
		this.containerEl.children.push(this.contentEl);
	}

	getViewType(): string {
		return '';
	}
	getDisplayText(): string {
		return '';
	}
	getIcon(): string {
		return '';
	}
	onload(): void {}
	onunload(): void {}
	registerEvent(_eventRef: any): void {}
	registerDomEvent(el: MockElement, type: string, callback: (e?: any) => void): void {
		el.addEventListener(type, callback);
	}
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}

export class WorkspaceLeaf {
	app: any;
	view: any;
	constructor(app?: any) {
		this.app = app;
	}
	openFile() {
		return Promise.resolve();
	}
}

export class MarkdownView {
	editor: any;
	file: any;
}

export class TFile {
	path: string = '';
	basename: string = '';
	extension: string = '';
	constructor(path = '') {
		this.path = path;
		const parts = path.split('/');
		const file = parts[parts.length - 1] ?? '';
		const dot = file.lastIndexOf('.');
		this.basename = dot >= 0 ? file.slice(0, dot) : file;
		this.extension = dot >= 0 ? file.slice(dot + 1) : '';
	}
}

export class Plugin {
	app: any;
	manifest: any;
	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}
	addCommand() {}
	addSettingTab() {}
	addStatusBarItem() {
		return new MockElement('div');
	}
	addRibbonIcon(_icon: string, _title: string, _callback: () => void) {
		return new MockElement('div');
	}
	registerView() {}
	registerEvent() {}
	loadData() {
		return Promise.resolve({});
	}
	saveData() {
		return Promise.resolve();
	}
}

export class Modal {
	app: any;
	containerEl: MockElement;
	modalEl: MockElement;
	contentEl: MockElement;
	titleEl: MockElement;
	closeButtonEl: MockElement;
	scope: any;

	constructor(app: any) {
		this.app = app;
		this.containerEl = new MockElement('div');
		this.modalEl = new MockElement('div');
		this.contentEl = new MockElement('div');
		this.titleEl = new MockElement('div');
		this.closeButtonEl = new MockElement('button');
		this.closeButtonEl.className = 'modal-close-button mod-raised';
		this.containerEl.children.push(this.modalEl);
		this.modalEl.children.push(this.titleEl, this.closeButtonEl, this.contentEl);
	}

	open(): void {
		this.onOpen();
	}

	close(): void {
		this.onClose();
	}

	onOpen(): void {}
	onClose(): void {}
}

export function setIcon(parent: any, iconId: string) {
	if (parent && typeof parent.createSpan === 'function') {
		parent.createSpan({ cls: `svg-icon lucide-${iconId}` });
	}
}
