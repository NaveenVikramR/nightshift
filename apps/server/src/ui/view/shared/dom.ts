/**
 * The ONLY way cards create DOM. Text always goes in as text nodes and
 * attributes through setAttribute, so tool data (including untrusted alert
 * annotations, commit messages and advisory text) can never become markup.
 * ESLint bans innerHTML / outerHTML / insertAdjacentHTML / document.write in src/ui.
 */
export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined>;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Event handlers and URL-bearing attributes are never set from data. */
function checkAttr(name: string): void {
  const n = name.toLowerCase();
  if (n.startsWith('on') || n === 'href' || n === 'src' || n === 'style' || n === 'srcdoc') {
    throw new Error(`attribute "${name}" is not allowed in cards`);
  }
}

function apply(node: Element, attrs: Attrs, children: Child[]): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    checkAttr(name);
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(
      typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c,
    );
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  apply(node, attrs, children);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, attrs, children);
  return node;
}

/** Replace everything inside `root`. */
export function mount(root: Element, ...children: Child[]): void {
  root.replaceChildren();
  apply(root, {}, children);
}
