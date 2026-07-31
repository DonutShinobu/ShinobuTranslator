const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export type IconKey =
  | 'translate'
  | 'original'
  | 'translated'
  | 'retry'
  | 'confirm'
  | 'close'
  | 'spinner';

function createSvgNode(
  name: string,
  attributes: Record<string, string>,
): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, value);
  }
  return element;
}

function createSvg(
  viewBox: string,
  attributes: Record<string, string> = {},
): SVGSVGElement {
  return createSvgNode('svg', {
    viewBox,
    ...attributes,
  }) as SVGSVGElement;
}

function appendTranslateIcon(svg: SVGSVGElement): void {
  for (const [x, text] of [['1.5', '文'], ['8.5', 'A']]) {
    const element = createSvgNode('text', {
      x,
      y: '11',
      'font-size': '8.5',
      fill: 'currentColor',
      'font-family': 'sans-serif',
      'font-weight': '700',
    });
    element.textContent = text;
    svg.appendChild(element);
  }
}

function appendImageIcon(
  svg: SVGSVGElement,
  translated: boolean,
): void {
  svg.appendChild(createSvgNode('rect', {
    x: '1.5',
    y: '3',
    width: '13',
    height: '10',
    rx: '1.5',
  }));
  svg.appendChild(createSvgNode('circle', {
    cx: '5',
    cy: '6',
    r: '1.5',
    fill: 'currentColor',
  }));
  svg.appendChild(createSvgNode('path', {
    d: 'M1.5 11l4-3 2 2 3-2.5 3.5 2.5',
  }));
  if (translated) {
    svg.appendChild(createSvgNode('rect', {
      x: '5',
      y: '5.5',
      width: '7.5',
      height: '4',
      rx: '1',
      fill: 'currentColor',
      opacity: '0.75',
    }));
  }
}

function createIcon(key: IconKey): SVGSVGElement {
  if (key === 'translate') {
    const svg = createSvg('0 0 16 16');
    appendTranslateIcon(svg);
    return svg;
  }
  if (key === 'spinner') {
    const svg = createSvg('0 0 16 16');
    svg.appendChild(createSvgNode('circle', {
      cx: '8',
      cy: '8',
      r: '6',
    }));
    return svg;
  }

  const strokeAttributes = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  if (key === 'original' || key === 'translated') {
    const svg = createSvg('0 0 16 16', {
      ...strokeAttributes,
      'stroke-width': '1.3',
    });
    appendImageIcon(svg, key === 'translated');
    return svg;
  }
  if (key === 'retry') {
    const svg = createSvg('0 0 16 16', {
      ...strokeAttributes,
      'stroke-width': '1.4',
    });
    svg.appendChild(createSvgNode('path', {
      d: 'M13 8A5 5 0 1 1 8 3',
    }));
    svg.appendChild(createSvgNode('path', {
      d: 'M8 3l2.5 2.5',
    }));
    return svg;
  }

  const svg = createSvg('0 0 24 24', {
    ...strokeAttributes,
    'stroke-width': '2.4',
  });
  if (key === 'confirm') {
    svg.appendChild(createSvgNode('path', {
      d: 'M20 6 9 17l-5-5',
    }));
  } else {
    svg.appendChild(createSvgNode('path', { d: 'M18 6 6 18' }));
    svg.appendChild(createSvgNode('path', { d: 'm6 6 12 12' }));
  }
  return svg;
}

export function replaceSvgIcon(
  container: Element,
  key: IconKey,
): void {
  container.replaceChildren(createIcon(key));
  container.setAttribute('data-icon', key);
}
