import { describe, expect, it } from 'vitest';

import {
  planGigaViewerTtbLogicalPages,
  type GigaViewerTtbSliceProbe,
} from '../../../apps/extension/src/content/readerEngines/gigaViewerTtbPagination';

function probes(
  edges: ReadonlyArray<readonly [bottomStrength: number, nextTopStrength: number]>,
): GigaViewerTtbSliceProbe[] {
  return Array.from({ length: edges.length + 1 }, (_, pageIndex) => ({
    pageIndex,
    width: 720,
    height: 703,
    topTouches: pageIndex > 0 && edges[pageIndex - 1][1] > 0,
    bottomTouches: pageIndex < edges.length && edges[pageIndex][0] > 0,
    topStrength: pageIndex === 0 ? 0 : edges[pageIndex - 1][1],
    bottomStrength: pageIndex === edges.length ? 0 : edges[pageIndex][0],
  }));
}

describe('planGigaViewerTtbLogicalPages', () => {
  it('joins a boundary when either side has raw mask in its 16-row edge band', () => {
    const plan = planGigaViewerTtbLogicalPages(probes([
      [16, 0],
      [0, 0],
      [0, 1],
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
        connectionStrength: 16,
        decision: 'joined',
      },
      {
        leftPageIndex: 1,
        rightPageIndex: 2,
        leftBottomTouches: false,
        rightTopTouches: false,
        connectionStrength: 0,
        decision: 'split-clean',
      },
      {
        leftPageIndex: 2,
        rightPageIndex: 3,
        leftBottomTouches: false,
        rightTopTouches: true,
        connectionStrength: 1,
        decision: 'joined',
      },
    ]);
  });

  it('allows up to five connected slices in one logical page', () => {
    const plan = planGigaViewerTtbLogicalPages(probes([
      [16, 16],
      [16, 16],
      [16, 16],
      [16, 16],
    ]));

    expect(plan.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1, 2, 3, 4],
    ]);
  });

  it('cuts the weakest seam when six connected slices exceed the limit', () => {
    const plan = planGigaViewerTtbLogicalPages(probes([
      [16, 16],
      [16, 8],
      [1, 0],
      [16, 8],
      [16, 16],
    ]));

    expect(plan.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(plan.boundaries.map((boundary) => [
      boundary.connectionStrength,
      boundary.decision,
    ])).toEqual([
      [32, 'joined'],
      [24, 'joined'],
      [1, 'split-repartition'],
      [24, 'joined'],
      [32, 'joined'],
    ]);
  });

  it('prefers safer cuts even when that creates more logical pages', () => {
    const plan = planGigaViewerTtbLogicalPages(probes([
      [16, 4],
      [16, 4],
      [1, 0],
      [16, 4],
      [16, 16],
      [16, 4],
      [1, 0],
      [16, 4],
      [16, 4],
    ]));

    expect(plan.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1, 2],
      [3, 4, 5, 6],
      [7, 8, 9],
    ]);
    expect(plan.boundaries.filter(({ decision }) => decision === 'split-repartition'))
      .toEqual([
        expect.objectContaining({ leftPageIndex: 2, connectionStrength: 1 }),
        expect.objectContaining({ leftPageIndex: 6, connectionStrength: 1 }),
      ]);
  });

  it('uses deterministic tie-breaks after cut strength and page count are equal', () => {
    const plan = planGigaViewerTtbLogicalPages(probes([
      [16, 16],
      [16, 16],
      [16, 16],
      [16, 16],
      [16, 16],
      [16, 16],
    ]));

    expect(plan.pages.map((page) => page.pageIndices)).toEqual([
      [0, 1],
      [2, 3, 4, 5, 6],
    ]);
  });

  it('rejects non-contiguous or unequal-width source slices', () => {
    expect(() => planGigaViewerTtbLogicalPages([
      {
        pageIndex: 0, width: 720, height: 703,
        topTouches: false, bottomTouches: false, topStrength: 0, bottomStrength: 0,
      },
      {
        pageIndex: 2, width: 720, height: 703,
        topTouches: false, bottomTouches: false, topStrength: 0, bottomStrength: 0,
      },
    ])).toThrow('连续');

    expect(() => planGigaViewerTtbLogicalPages([
      {
        pageIndex: 0, width: 720, height: 703,
        topTouches: false, bottomTouches: false, topStrength: 0, bottomStrength: 0,
      },
      {
        pageIndex: 1, width: 719, height: 703,
        topTouches: false, bottomTouches: false, topStrength: 0, bottomStrength: 0,
      },
    ])).toThrow('等宽');
  });
});
