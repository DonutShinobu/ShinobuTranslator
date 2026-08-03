const SVG_NS = 'http://www.w3.org/2000/svg';

type SvgNode = {
  tag: 'circle' | 'path' | 'rect' | 'text';
  attributes: Record<string, string>;
  text?: string;
};

type IconDefinition = {
  viewBox: string;
  attributes?: Record<string, string>;
  children: SvgNode[];
};

const imageFrame: SvgNode[] = [
  { tag: 'rect', attributes: { x: '1.5', y: '3', width: '13', height: '10', rx: '1.5' } },
  { tag: 'circle', attributes: { cx: '5', cy: '6', r: '1.5', fill: 'currentColor' } },
  { tag: 'path', attributes: { d: 'M1.5 11l4-3 2 2 3-2.5 3.5 2.5' } },
];

const icons = {
  translate: {
    viewBox: '0 0 16 16',
    children: [
      { tag: 'text', attributes: { x: '1.5', y: '11', 'font-size': '8.5', fill: 'currentColor', 'font-family': 'sans-serif', 'font-weight': '700' }, text: '文' },
      { tag: 'text', attributes: { x: '8.5', y: '11', 'font-size': '8.5', fill: 'currentColor', 'font-family': 'sans-serif', 'font-weight': '700' }, text: 'A' },
    ],
  },
  original: {
    viewBox: '0 0 16 16',
    attributes: { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    children: imageFrame,
  },
  translated: {
    viewBox: '0 0 16 16',
    attributes: { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    children: [
      ...imageFrame,
      { tag: 'rect', attributes: { x: '5', y: '5.5', width: '7.5', height: '4', rx: '1', fill: 'currentColor', opacity: '0.75' } },
    ],
  },
  retry: {
    viewBox: '0 0 16 16',
    attributes: { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    children: [
      { tag: 'path', attributes: { d: 'M13 8A5 5 0 1 1 8 3' } },
      { tag: 'path', attributes: { d: 'M8 3l2.5 2.5' } },
    ],
  },
  confirm: {
    viewBox: '0 0 24 24',
    attributes: { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    children: [{ tag: 'path', attributes: { d: 'M20 6 9 17l-5-5' } }],
  },
  close: {
    viewBox: '0 0 24 24',
    attributes: { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    children: [
      { tag: 'path', attributes: { d: 'M18 6 6 18' } },
      { tag: 'path', attributes: { d: 'm6 6 12 12' } },
    ],
  },
  spinner: {
    viewBox: '0 0 16 16',
    children: [{ tag: 'circle', attributes: { cx: '8', cy: '8', r: '6' } }],
  },
} satisfies Record<string, IconDefinition>;

export type IconKey = Exclude<keyof typeof icons, 'spinner'>;

export function createIcon(key: keyof typeof icons): SVGSVGElement {
  const definition = icons[key];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', definition.viewBox);
  const rootAttributes: Record<string, string> = 'attributes' in definition
    ? definition.attributes
    : {};
  for (const [name, value] of Object.entries(rootAttributes)) {
    svg.setAttribute(name, value);
  }
  for (const childDefinition of definition.children) {
    const child = document.createElementNS(SVG_NS, childDefinition.tag);
    for (const [name, value] of Object.entries(childDefinition.attributes)) {
      child.setAttribute(name, value);
    }
    if ('text' in childDefinition && childDefinition.text) {
      child.textContent = childDefinition.text;
    }
    svg.appendChild(child);
  }
  return svg;
}

export function replaceIcon(container: HTMLElement, key: IconKey): void {
  container.replaceChildren(createIcon(key));
  container.dataset.icon = key;
}
