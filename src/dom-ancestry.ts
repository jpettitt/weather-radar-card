/**
 * The nearest element named `tagName` above `node`, looking through shadow
 * roots to their hosts. HA nests cards in several shadow trees, so a plain
 * parentElement walk stops at the first one.
 */
export function closestAncestor(node: Node, tagName: string): Element | null {
  const want = tagName.toUpperCase();
  let el: Node | null = node.parentNode;
  while (el) {
    if ((el as Element).tagName === want) return el as Element;
    el = el instanceof ShadowRoot ? el.host : el.parentNode;
  }
  return null;
}

export function hasAncestor(node: Node, tagName: string): boolean {
  return closestAncestor(node, tagName) !== null;
}

/** Every element named `tagName` in `root`, inside shadow trees too. */
export function deepQueryAll(root: ParentNode, tagName: string): Element[] {
  const out: Element[] = [];
  const walk = (r: ParentNode): void => {
    for (const el of r.querySelectorAll('*')) {
      if (el.tagName === tagName.toUpperCase()) out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}
