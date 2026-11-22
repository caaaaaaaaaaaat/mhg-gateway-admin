// SPDX-License-Identifier: GPL-3.0-or-later
//
// A minimal DOM implementation, just complete enough to execute public/app.js in
// Node.
//
// Why this exists: the front end is a hand-written module with no framework, so
// nothing else parses it. A single unbalanced parenthesis in a deeply nested h()
// call shipped once and produced a blank page -- every server-side test passed,
// because they only checked that the file could be fetched and contained the
// expected endpoint strings. This shim lets the test suite actually run the file,
// which is the only way to catch a syntax error or a missing DOM call before a
// user opens the page.
//
// It is deliberately small. Anything not needed by app.js is absent rather than
// silently faked, so a genuinely new DOM dependency shows up as a failing test.

class DomNode {
    constructor(nodeName, ownerDocument) {
        this.nodeName = nodeName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.childNodes = [];
        this.attributes = new Map();
        this._listeners = new Map();
        this.className = '';
        this.id = '';
        // Mirrors CSSStyleDeclaration closely enough for app.js: `cssText` is the
        // path h() uses (see the comment there about CSP and inline styles), and
        // individual properties remain assignable.
        this.style = {
            _props: new Map(),
            get cssText() {
                return [...this._props.entries()].map(([k, v]) => `${k}: ${v}`).join('; ');
            },
            set cssText(text) {
                this._props.clear();
                for (const declaration of String(text).split(';')) {
                    const index = declaration.indexOf(':');
                    if (index === -1) continue;
                    const name = declaration.slice(0, index).trim();
                    const value = declaration.slice(index + 1).trim();
                    if (name && value) this._props.set(name, value);
                }
            },
            setProperty(name, value) { this._props.set(name, value); },
            getPropertyValue(name) { return this._props.get(name) ?? ''; },
            removeProperty(name) { this._props.delete(name); },
        };
        this.dataset = {};
        this.hidden = false;
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.parentNode = null;
        this.classList = {
            add: (...names) => { this.className = [...new Set([...this._classes(), ...names])].join(' '); },
            remove: (...names) => { this.className = this._classes().filter((c) => !names.includes(c)).join(' '); },
            contains: (name) => this._classes().includes(name),
            toggle: (name, force) => {
                const has = this._classes().includes(name);
                const shouldHave = force === undefined ? !has : Boolean(force);
                if (shouldHave && !has) this.classList.add(name);
                if (!shouldHave && has) this.classList.remove(name);
                return shouldHave;
            },
        };
    }

    _classes() {
        return String(this.className ?? '').split(/\s+/).filter(Boolean);
    }

    append(...nodes) {
        for (const node of nodes) {
            const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
            if (!child) continue;
            child.parentNode = this;
            this.childNodes.push(child);
        }
    }

    appendChild(node) {
        this.append(node);
        return node;
    }

    prepend(node) {
        const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
        child.parentNode = this;
        this.childNodes.unshift(child);
    }

    replaceChildren(...nodes) {
        this.childNodes = [];
        this.append(...nodes);
    }

    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.childNodes.indexOf(this);
        if (index >= 0) this.parentNode.childNodes.splice(index, 1);
        this.parentNode = null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'id') this.id = String(value);
        if (name === 'class') this.className = String(value);
        if (name === 'value') this.value = String(value);
        if (name === 'hidden') this.hidden = true;
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(handler);
    }

    removeEventListener(type, handler) {
        const list = this._listeners.get(type) ?? [];
        this._listeners.set(type, list.filter((item) => item !== handler));
    }

    /** Test-only: invoke registered handlers, which a real browser would do. */
    emit(type, event = {}) {
        for (const handler of [...(this._listeners.get(type) ?? [])]) {
            handler.call(this, { type, target: this, preventDefault() {}, ...event });
        }
    }

    focus() { this.ownerDocument.activeElement = this; }
    select() {}
    showModal() { this.open = true; }
    close() {
        this.open = false;
        this.emit('close');
    }

    get textContent() {
        return this.childNodes.map((child) => child.textContent ?? '').join('');
    }

    set textContent(value) {
        this.childNodes = [];
        if (value !== '' && value !== null && value !== undefined) {
            this.childNodes.push(this.ownerDocument.createTextNode(String(value)));
        }
    }

    // app.js only writes static trusted markup; storing it is enough.
    set innerHTML(value) {
        this._innerHTML = String(value);
        this.childNodes = [];
    }

    get innerHTML() {
        return this._innerHTML ?? '';
    }

    get children() {
        return this.childNodes.filter((node) => node instanceof DomNode);
    }

    get firstChild() {
        return this.childNodes[0] ?? null;
    }

    matches(selector) {
        const trimmed = selector.trim();
        if (trimmed.startsWith('#')) return this.id === trimmed.slice(1);
        if (trimmed.startsWith('.')) return this.classList.contains(trimmed.slice(1));
        return this.nodeName === trimmed.toUpperCase();
    }

    querySelectorAll(selector) {
        const found = [];
        const walk = (node) => {
            for (const child of node.children) {
                if (child.matches(selector)) found.push(child);
                walk(child);
            }
        };
        walk(this);
        return found;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

class DomText extends DomNode {
    constructor(text, ownerDocument) {
        super('#text', ownerDocument);
        this.data = String(text);
    }

    get textContent() {
        return this.data;
    }

    set textContent(value) {
        this.data = String(value);
    }

    matches() {
        return false;
    }
}

/**
 * Build a document with one `<div id="app">` already present, matching what
 * public/index.html provides, so app.js can bootstrap unmodified.
 */
export function createDom() {
    const document = {
        hidden: false,
        activeElement: null,
        _byId: new Map(),
        createElement(tag) {
            const element = new DomNode(tag, document);
            return element;
        },
        createTextNode(text) {
            return new DomText(text, document);
        },
        getElementById(id) {
            return document._byId.get(id) ?? null;
        },
        querySelector(selector) {
            return document.body.querySelector(selector);
        },
        querySelectorAll(selector) {
            return document.body.querySelectorAll(selector);
        },
    };

    const html = new DomNode('html', document);
    const body = new DomNode('body', document);
    const app = new DomNode('div', document);
    app.id = 'app';
    html.append(body);
    body.append(app);
    document.documentElement = html;
    document.body = body;
    document._byId.set('app', app);

    const window = {
        _listeners: new Map(),
        addEventListener(type, handler) {
            if (!window._listeners.has(type)) window._listeners.set(type, []);
            window._listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            const list = window._listeners.get(type) ?? [];
            window._listeners.set(type, list.filter((item) => item !== handler));
        },
        emit(type, event = {}) {
            for (const handler of [...(window._listeners.get(type) ?? [])]) {
                handler({ type, preventDefault() {}, ...event });
            }
        },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };

    const location = { hash: '', href: 'http://localhost/', pathname: '/' };

    return { document, window, location, app, body, Node: DomNode, Text: DomText };
}

/**
 * A fetch stand-in driven by a route table, so app.js's own bootstrap runs and
 * renders. Unmatched routes 404 like the real server does.
 */
export function createFetchStub(routes, { onRequest = () => {} } = {}) {
    return async function fetchStub(input, init = {}) {
        const url = typeof input === 'string' ? input : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
        const method = (init.method ?? 'GET').toUpperCase();
        onRequest({ path, method, init });
        const key = `${method} ${path}`;
        const handler = routes[key] ?? routes[`* ${path}`];
        if (!handler) {
            return {
                ok: false,
                status: 404,
                headers: { get: () => 'application/json' },
                async json() {
                    return { error: { message: '未找到该接口', code: 'not_found' } };
                },
                async text() { return ''; },
            };
        }
        const result = typeof handler === 'function' ? handler(init) : handler;
        const status = result.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
            async json() { return result.body; },
            async text() { return JSON.stringify(result.body ?? ''); },
        };
    };
}
