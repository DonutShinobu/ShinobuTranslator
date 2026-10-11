//#region src/core/spring.d.ts
declare class Spring {
  x: number;
  v: number;
  k: number;
  c: number;
  config(k: number, c: number): void;
  /** Starts (or restarts mid-flight) preserving velocity. */
  start(): void;
  /** Advances dt seconds. Returns true on settle (|1−x| < 0.001 ∧ |v| < 0.02). */
  step(dt: number): boolean;
}
/** Spring presets (ζ = c/(2√k)) with the API's public names. */
declare const SPRING_PRESETS: {
  /** ζ = 1.00 — critically damped, no overshoot. */
  readonly smooth: {
    readonly k: 170;
    readonly c: 26;
  };
  /** ζ = 0.73 — fast, subtle overshoot. */
  readonly snappy: {
    readonly k: 420;
    readonly c: 30;
  };
  /** ζ = 0.40 — playful. */
  readonly bouncy: {
    readonly k: 300;
    readonly c: 14;
  };
};
type SpringPreset = keyof typeof SPRING_PRESETS;
//#endregion
//#region src/core/types.d.ts
/** Attributes of an icon node (values as Lucide exports them: string or
 *  number). `undefined` is allowed on purpose — lucide's SVGProps includes it
 *  and the runtime treats an undefined attr as absent (fallback). */
type IconNodeAttrs = Record<string, string | number | undefined>;
/** Lucide-style icon data: a `[tag, attrs]` list. Structurally typed —
 *  Lucide is neither a dependency nor a peer; Feather/Tabler/custom paths
 *  work just the same. */
type IconNode = ReadonlyArray<readonly [string, IconNodeAttrs]>;
/** Input accepted by the core: an IconNode or a raw `d` attribute.
 *  (SVGElement is resolved in the dom layer — the core never touches DOM.) */
type IconInput = IconNode | string;
/** Normalized subpath: a chain of cubics packed as points
 *  [p0, c1, c2, p1, c1', c2', p2, …] → Float64Array of length 2·(3m+1),
 *  with m = number of segments. Consecutive segments share an endpoint. */
interface CubicPath {
  pts: Float64Array;
  closed: boolean;
}
/** Subpath sampled at N points by arc length + its topology. It is the
 *  currency between resample and plan; an intermediate shape (interruption)
 *  is also a list of Sampled. */
interface Sampled {
  pts: Float64Array;
  closed: boolean;
}
//#endregion
export { Sampled as a, SpringPreset as c, IconNodeAttrs as i, IconInput as n, SPRING_PRESETS as o, IconNode as r, Spring as s, CubicPath as t };