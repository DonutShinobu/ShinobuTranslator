import { describe, expect, it } from 'vitest';

import {
  planGigaViewerTtbLogicalPages,
  type GigaViewerTtbSliceProbe,
} from '../../../apps/extension/src/content/readerEngines/gigaViewerTtbPagination';

function probes(
  edges: ReadonlyArray<readonly [bottomTouches: boolean, nextTopTouches: boolean]>,
): GigaViewerTtbSliceProbe[] {
  return Array.from({ length: edges.length + 1 }, (_, pageIndex) => ({
    pageIndex,
    width: 720,
    height: 703,
    topTouches: pageIndex === 0 ? false : edges[pageIndex - 1][1],
    bottomTouches: pageIndex === edges.length ? false : edges[pageIndex][0],
  }));
}

describe('planGigaViewerTtbLogicalPages', () => {
  it('joins a boundary when either side has raw mask in its two-pixel edge', () => {
    const plan = planGigaViewerTtbLogicalPages(probes([
      [true, false],
      [false, false],
      [false, true],
    ]));

    expect(plan.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(plan.boundaries).toEqual([
      {
        leftPageIndex: 0,
        rightPageIndex: 1,
        leftBottomTouches: true,
        rightTopTouches: false,
        risk: 1,
        decision: 'joined',
      },
      {
        leftPageIndex: 1,
        rightPageIndex: 2,
        leftBottomTouches: false,
        rightTopTouches: false,
        risk: 0,
        decision: 'split-clean',
      },
      {
        leftPageIndex: 2,
        rightPageIndex: 3,
        leftBottomTouches: false,
        rightTopTouches: true,
        risk: 1,
        decision: 'joined',
      },
    ]);
  });

  it('cuts the lowest-risk seam when four connected slices exceed the limit', () => {
    const plan = planGigaViewerTtbLogicalPages(probes([
      [true, true],
      [true, false],
      [true, true],
    ]));

    expect(plan.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(plan.boundaries.map((boundary) => [boundary.risk, boundary.decision])).toEqual([
      [2, 'joined'],
      [1, 'split-max-slices'],
      [2, 'joined'],
    ]);
  });

  it('uses the confirmed deterministic tie-breaks for equal-risk chains', () => {
    const five = planGigaViewerTtbLogicalPages(probes([
      [true, false],
      [true, false],
      [true, false],
      [true, false],
    ]));
    expect(five.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);

    const seven = planGigaViewerTtbLogicalPages(probes([
      [true, true],
      [true, true],
      [true, false],
      [true, true],
      [true, true],
      [true, false],
    ]));
    expect(seven.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6],
    ]);
  });

  it('rejects non-contiguous or unequal-width source slices', () => {
    expect(() => planGigaViewerTtbLogicalPages([
      { pageIndex: 0, width: 720, height: 703, topTouches: false, bottomTouches: false },
      { pageIndex: 2, width: 720, height: 703, topTouches: false, bottomTouches: false },
    ])).toThrow('连续');

    expect(() => planGigaViewerTtbLogicalPages([
      { pageIndex: 0, width: 720, height: 703, topTouches: false, bottomTouches: false },
      { pageIndex: 1, width: 719, height: 703, topTouches: false, bottomTouches: false },
    ])).toThrow('等宽');
  });
});
