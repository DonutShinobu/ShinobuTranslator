import { DETECTION_MASK_EDGE_SEARCH_ROWS } from '@shinobu/image-pipeline';
import { readingLogicalPageMemberLimit } from '../core/types';

export type GigaViewerTtbSliceProbe = {
  pageIndex: number;
  width: number;
  height: number;
  topTouches: boolean;
  bottomTouches: boolean;
  topStrength: number;
  bottomStrength: number;
};

export type GigaViewerTtbBoundaryDecision = {
  leftPageIndex: number;
  rightPageIndex: number;
  leftBottomTouches: boolean;
  rightTopTouches: boolean;
  connectionStrength: number;
  decision: 'joined' | 'split-clean' | 'split-repartition';
};

export type GigaViewerTtbLogicalPage = {
  pageIndices: readonly number[];
  width: number;
  height: number;
};

export type GigaViewerTtbLogicalPagePlan = {
  pages: readonly GigaViewerTtbLogicalPage[];
  boundaries: readonly GigaViewerTtbBoundaryDecision[];
};

type PartitionCandidate = {
  groups: number[][];
  groupCount: number;
  maxCutStrength: number;
  totalCutStrength: number;
  singletonCount: number;
  cuts: number[];
};

function compareCuts(left: readonly number[], right: readonly number[]): number {
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function isBetterCandidate(
  candidate: PartitionCandidate,
  current: PartitionCandidate | undefined,
): boolean {
  if (!current) return true;
  if (candidate.maxCutStrength !== current.maxCutStrength) {
    return candidate.maxCutStrength < current.maxCutStrength;
  }
  if (candidate.totalCutStrength !== current.totalCutStrength) {
    return candidate.totalCutStrength < current.totalCutStrength;
  }
  if (candidate.groupCount !== current.groupCount) {
    return candidate.groupCount < current.groupCount;
  }
  if (candidate.singletonCount !== current.singletonCount) {
    return candidate.singletonCount < current.singletonCount;
  }
  return compareCuts(candidate.cuts, current.cuts) < 0;
}

function partitionConnectedChain(
  pageIndices: readonly number[],
  boundaryStrength: ReadonlyMap<number, number>,
): number[][] {
  const memo = new Map<number, PartitionCandidate>();
  const visit = (offset: number): PartitionCandidate => {
    const cached = memo.get(offset);
    if (cached) return cached;
    if (offset === pageIndices.length) {
      return {
        groups: [],
        groupCount: 0,
        maxCutStrength: 0,
        totalCutStrength: 0,
        singletonCount: 0,
        cuts: [],
      };
    }

    let best: PartitionCandidate | undefined;
    for (
      let size = 1;
      size <= readingLogicalPageMemberLimit && offset + size <= pageIndices.length;
      size += 1
    ) {
      const nextOffset = offset + size;
      const tail = visit(nextOffset);
      const cutAfter = nextOffset < pageIndices.length
        ? pageIndices[nextOffset - 1]
        : undefined;
      const cutStrength = cutAfter === undefined ? 0 : boundaryStrength.get(cutAfter) ?? 0;
      const candidate: PartitionCandidate = {
        groups: [pageIndices.slice(offset, nextOffset), ...tail.groups],
        groupCount: 1 + tail.groupCount,
        maxCutStrength: Math.max(tail.maxCutStrength, cutStrength),
        totalCutStrength: tail.totalCutStrength + cutStrength,
        singletonCount: tail.singletonCount + (size === 1 ? 1 : 0),
        cuts: cutAfter === undefined ? tail.cuts : [cutAfter, ...tail.cuts],
      };
      if (isBetterCandidate(candidate, best)) best = candidate;
    }
    if (!best) throw new Error('无法生成 GigaViewer TTB 逻辑分页');
    memo.set(offset, best);
    return best;
  };

  return visit(0).groups;
}

function validateProbes(probes: readonly GigaViewerTtbSliceProbe[]): void {
  if (probes.length === 0) return;
  const width = probes[0].width;
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    if (
      !Number.isInteger(probe.pageIndex)
      || probe.pageIndex !== index
      || !Number.isInteger(probe.width)
      || probe.width <= 0
      || !Number.isInteger(probe.height)
      || probe.height <= 0
      || !Number.isInteger(probe.topStrength)
      || probe.topStrength < 0
      || probe.topStrength > DETECTION_MASK_EDGE_SEARCH_ROWS
      || !Number.isInteger(probe.bottomStrength)
      || probe.bottomStrength < 0
      || probe.bottomStrength > DETECTION_MASK_EDGE_SEARCH_ROWS
      || probe.topTouches !== (probe.topStrength > 0)
      || probe.bottomTouches !== (probe.bottomStrength > 0)
    ) {
      throw new Error('GigaViewer TTB 切片必须按连续页码提供有效尺寸与边缘强度');
    }
    if (probe.width !== width) {
      throw new Error('GigaViewer TTB 切片必须等宽');
    }
  }
}

export function planGigaViewerTtbLogicalPages(
  probes: readonly GigaViewerTtbSliceProbe[],
): GigaViewerTtbLogicalPagePlan {
  validateProbes(probes);
  if (probes.length === 0) return { pages: [], boundaries: [] };

  const boundaries: GigaViewerTtbBoundaryDecision[] = [];
  const boundaryStrength = new Map<number, number>();
  for (let index = 0; index < probes.length - 1; index += 1) {
    const left = probes[index];
    const right = probes[index + 1];
    const connectionStrength = left.bottomStrength + right.topStrength;
    boundaryStrength.set(left.pageIndex, connectionStrength);
    boundaries.push({
      leftPageIndex: left.pageIndex,
      rightPageIndex: right.pageIndex,
      leftBottomTouches: left.bottomTouches,
      rightTopTouches: right.topTouches,
      connectionStrength,
      decision: connectionStrength === 0 ? 'split-clean' : 'joined',
    });
  }

  const groups: number[][] = [];
  let chainStart = 0;
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length; boundaryIndex += 1) {
    if (boundaries[boundaryIndex].connectionStrength !== 0) continue;
    const chain = probes.slice(chainStart, boundaryIndex + 1).map(({ pageIndex }) => pageIndex);
    groups.push(...partitionConnectedChain(chain, boundaryStrength));
    chainStart = boundaryIndex + 1;
  }
  groups.push(...partitionConnectedChain(
    probes.slice(chainStart).map(({ pageIndex }) => pageIndex),
    boundaryStrength,
  ));

  const splitAfter = new Set<number>();
  for (let index = 0; index < groups.length - 1; index += 1) {
    splitAfter.add(groups[index][groups[index].length - 1]);
  }
  for (const boundary of boundaries) {
    if (boundary.connectionStrength > 0 && splitAfter.has(boundary.leftPageIndex)) {
      boundary.decision = 'split-repartition';
    }
  }

  const byPageIndex = new Map(probes.map((probe) => [probe.pageIndex, probe]));
  const pages = groups.map((pageIndices): GigaViewerTtbLogicalPage => ({
    pageIndices,
    width: probes[0].width,
    height: pageIndices.reduce((sum, pageIndex) => {
      const probe = byPageIndex.get(pageIndex);
      if (!probe) throw new Error(`GigaViewer TTB 切片 ${pageIndex} 不存在`);
      return sum + probe.height;
    }, 0),
  }));

  return { pages, boundaries };
}
