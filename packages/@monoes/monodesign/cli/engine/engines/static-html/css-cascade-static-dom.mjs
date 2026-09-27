// Static-HTML CSS cascade engine: the minimal DOM-like wrappers
// (StaticElement/StaticDocument) used when no real DOM is available. Split
// out of css-cascade.mjs (file-size sweep — pure move, no behaviour change).

import { makeStaticStyle } from './css-cascade.mjs';

class StaticElement {
  constructor(node, doc) {
    this.node = node;
    this._doc = doc;
    this.nodeType = 1;
    this.tagName = String(node.name || '').toUpperCase();
    this.nodeName = this.tagName;
  }
  get parentElement() {
    let cur = this.node.parent;
    while (cur && cur.type !== 'tag') cur = cur.parent;
    return cur ? this._doc.wrap(cur) : null;
  }
  get previousElementSibling() {
    let cur = this.node.prev;
    while (cur && cur.type !== 'tag') cur = cur.prev;
    return cur ? this._doc.wrap(cur) : null;
  }
  get children() {
    return (this.node.children || []).filter(child => child.type === 'tag').map(child => this._doc.wrap(child));
  }
  get childNodes() {
    return (this.node.children || []).map(child => {
      if (child.type === 'text') return { nodeType: 3, textContent: child.data || '' };
      if (child.type === 'tag') return this._doc.wrap(child);
      return { nodeType: 8, textContent: child.data || '' };
    });
  }
  get textContent() {
    return this._doc.domutils.textContent(this.node);
  }
  get className() {
    return this.getAttribute('class') || '';
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  getAttribute(name) {
    return this.node.attribs?.[name] ?? null;
  }
  querySelector(selector) {
    try {
      const found = this._doc.selectOne(selector, this.node.children || []);
      return found ? this._doc.wrap(found) : null;
    } catch {
      return null;
    }
  }
  querySelectorAll(selector) {
    try {
      return this._doc.selectAll(selector, this.node.children || []).map(node => this._doc.wrap(node));
    } catch {
      return [];
    }
  }
  closest(selector) {
    let cur = this.node;
    while (cur && cur.type === 'tag') {
      try {
        if (this._doc.is(cur, selector)) return this._doc.wrap(cur);
      } catch {
        return null;
      }
      cur = cur.parent;
      while (cur && cur.type !== 'tag') cur = cur.parent;
    }
    return null;
  }
  contains(other) {
    let cur = other?.node || null;
    while (cur) {
      if (cur === this.node) return true;
      cur = cur.parent;
    }
    return false;
  }
}

class StaticDocument {
  constructor(root, modules) {
    this.root = root;
    this.selectAll = modules.selectAll;
    this.selectOne = modules.selectOne;
    this.is = modules.is;
    this.domutils = modules.domutils;
    this._wrappers = new WeakMap();
    this._styleMap = new WeakMap();
  }
  wrap(node) {
    let wrapped = this._wrappers.get(node);
    if (!wrapped) {
      wrapped = new StaticElement(node, this);
      this._wrappers.set(node, wrapped);
    }
    return wrapped;
  }
  querySelectorAll(selector) {
    try {
      return this.selectAll(selector, this.root.children || []).map(node => this.wrap(node));
    } catch {
      return [];
    }
  }
  querySelector(selector) {
    try {
      const found = this.selectOne(selector, this.root.children || []);
      return found ? this.wrap(found) : null;
    } catch {
      return null;
    }
  }
  get documentElement() {
    return this.querySelector('html');
  }
  get body() {
    return this.querySelector('body');
  }
  setStyle(node, style) {
    this._styleMap.set(node, style);
  }
  getStyle(el) {
    return this._styleMap.get(el.node) || makeStaticStyle();
  }
}

export { StaticElement, StaticDocument };
