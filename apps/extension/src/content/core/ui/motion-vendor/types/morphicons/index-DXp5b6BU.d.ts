import { c as SpringPreset, n as IconInput } from "./types-JAF3s76Y.js";
//#region src/dom/index.d.ts
/** Target element, structurally typed: any object with setAttribute works
 *  (a real SVGPathElement, or a fake in tests). */
interface PathEl {
  setAttribute(name: string, value: string): void;
}
/** Morph physics: named preset or custom spring. */
interface MorphOptions {
  stiffness?: number;
  damping?: number;
}
/** Reduced-motion policy. `"never"` (default): morphs always animate,
 *  ignoring the OS setting. `"user"`: while the OS reduce-motion setting is
 *  on, `morphTo` degrades to an instant `set`. `"always"`: every `morphTo`
 *  jumps (tests, screenshots). */
type ReducedMotionMode = "never" | "user" | "always";
interface CreateMorphOptions {
  /** Reduced-motion policy; also live via the `reducedMotion` property. */
  reducedMotion?: ReducedMotionMode;
}
interface Morph {
  /** Animates toward the icon with spring physics. Interruptible: mid-flight
   *  it re-plans from the intermediate shape while preserving velocity. */
  morphTo(icon: IconInput, spring?: SpringPreset | MorphOptions): void;
  /** Jumps to the icon without animating (canonical d, no frames). */
  set(icon: IconInput): void;
  /** Renders the morph toward `icon` frozen at t (no spring) — the
   *  controlled-mode primitive: scrubbing, gestures, scroll. A later
   *  morphTo takes off from that intermediate shape. */
  seek(icon: IconInput, t: number): void;
  /** Current progress (t of the last frame; 1 at rest). Assigning it is
   *  equivalent to seek(target, t) on the active target. */
  progress: number;
  /** Reduced-motion policy, live: assigning it applies to the next morphTo. */
  reducedMotion: ReducedMotionMode;
  /** Unregisters the instance; later calls are no-ops. */
  destroy(): void;
}
/** Canonical `d` of an icon: the input string verbatim, or the real cubics
 *  quantized to 4 decimals (the at-rest snap; engine-stable bytes so SSR
 *  hydration matches, see fmtCanon in core/serialize). Exported because it
 *  is what a binding renders at SSR/rest before any runtime exists. */
declare function canonicalD(icon: IconInput): string;
/** Creates the morph instance over a `<path>` and paints the initial icon. */
declare function createMorph(el: PathEl, icon: IconInput, options?: CreateMorphOptions): Morph;
//#endregion
export { ReducedMotionMode as a, PathEl as i, Morph as n, canonicalD as o, MorphOptions as r, createMorph as s, CreateMorphOptions as t };