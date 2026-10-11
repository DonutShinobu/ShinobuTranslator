/*! Official morphicons@1.7.1 and torph@0.1.3.
MIT License

Copyright (c) 2026 Guillermo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

MIT License

Copyright (c) 2025 Lochie Axon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// node_modules/morphicons/dist/normalize-CYnN3Npw.js
var COMMANDS = "MmLlHhVvCcSsQqTtAaZz";
function parsePath(d) {
  const subs = [];
  const n = d.length;
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cur = null;
  let cmd = "";
  let px = 0;
  let py = 0;
  let prev = "";
  let started = false;
  const err = (msg) => {
    throw new Error(`morphicons: ${msg} at d[${i}]`);
  };
  const isDigit = (c) => c >= 48 && c <= 57;
  const skip = () => {
    while (i < n) {
      const c = d.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++;
      else break;
    }
  };
  const num = () => {
    skip();
    const start = i;
    if (i < n && (d[i] === "+" || d[i] === "-")) i++;
    let dig = false;
    while (i < n && isDigit(d.charCodeAt(i))) {
      i++;
      dig = true;
    }
    if (i < n && d[i] === ".") {
      i++;
      while (i < n && isDigit(d.charCodeAt(i))) {
        i++;
        dig = true;
      }
    }
    if (!dig) err("expected number");
    if (i < n && (d[i] === "e" || d[i] === "E")) {
      const save = i;
      i++;
      if (i < n && (d[i] === "+" || d[i] === "-")) i++;
      let ed = false;
      while (i < n && isDigit(d.charCodeAt(i))) {
        i++;
        ed = true;
      }
      if (!ed) i = save;
    }
    return Number(d.slice(start, i));
  };
  const flag = () => {
    skip();
    const c = d[i];
    if (c === "0" || c === "1") {
      i++;
      return c === "1" ? 1 : 0;
    }
    return err("expected arc flag (0|1)");
  };
  const open = () => {
    if (!started) err("path must start with M/m");
    if (!cur) {
      cur = {
        x0: cx,
        y0: cy,
        segs: [],
        closed: false
      };
      subs.push(cur);
    }
    return cur;
  };
  let rel = false;
  const nx = () => num() + (rel ? cx : 0);
  const ny = () => num() + (rel ? cy : 0);
  while (true) {
    skip();
    if (i >= n) break;
    const ch = d[i];
    if (COMMANDS.includes(ch)) {
      cmd = ch;
      i++;
    } else if (cmd === "") err("path must start with M/m");
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    else if (cmd === "Z" || cmd === "z") err("stray data after Z");
    rel = cmd >= "a";
    switch (rel ? cmd.toUpperCase() : cmd) {
      case "M": {
        started = true;
        const x = nx();
        const y = ny();
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        cur = {
          x0: x,
          y0: y,
          segs: [],
          closed: false
        };
        subs.push(cur);
        prev = "";
        break;
      }
      case "L": {
        const x = nx();
        const y = ny();
        open().segs.push([
          "L",
          x,
          y
        ]);
        cx = x;
        cy = y;
        prev = "";
        break;
      }
      case "H": {
        const x = nx();
        open().segs.push([
          "L",
          x,
          cy
        ]);
        cx = x;
        prev = "";
        break;
      }
      case "V": {
        const y = ny();
        open().segs.push([
          "L",
          cx,
          y
        ]);
        cy = y;
        prev = "";
        break;
      }
      case "C":
      case "S": {
        let x1;
        let y1;
        if (cmd === "C" || cmd === "c") {
          x1 = nx();
          y1 = ny();
        } else {
          x1 = prev === "C" ? 2 * cx - px : cx;
          y1 = prev === "C" ? 2 * cy - py : cy;
        }
        const x2 = nx();
        const y2 = ny();
        const x = nx();
        const y = ny();
        open().segs.push([
          "C",
          x1,
          y1,
          x2,
          y2,
          x,
          y
        ]);
        px = x2;
        py = y2;
        cx = x;
        cy = y;
        prev = "C";
        break;
      }
      case "Q":
      case "T": {
        let x1;
        let y1;
        if (cmd === "Q" || cmd === "q") {
          x1 = nx();
          y1 = ny();
        } else {
          x1 = prev === "Q" ? 2 * cx - px : cx;
          y1 = prev === "Q" ? 2 * cy - py : cy;
        }
        const x = nx();
        const y = ny();
        open().segs.push([
          "Q",
          x1,
          y1,
          x,
          y
        ]);
        px = x1;
        py = y1;
        cx = x;
        cy = y;
        prev = "Q";
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const x = nx();
        const y = ny();
        open().segs.push([
          "A",
          rx,
          ry,
          rot,
          large,
          sweep,
          x,
          y
        ]);
        cx = x;
        cy = y;
        prev = "";
        break;
      }
      case "Z":
        if (cur) {
          cur.closed = true;
          cur = null;
        }
        cx = sx;
        cy = sy;
        prev = "";
        break;
      default:
        err(`unsupported command "${cmd}"`);
    }
  }
  return subs.filter((s) => s.segs.length > 0);
}
function fmt(v) {
  return String(Math.round(v * 100) / 100);
}
function serialize(subs, closed) {
  let d = "";
  for (let k2 = 0; k2 < subs.length; k2++) {
    const o = subs[k2];
    const n = o.length / 2;
    d += `M${fmt(o[0])} ${fmt(o[1])}`;
    for (let i = 1; i < n; i++) d += `L${fmt(o[2 * i])} ${fmt(o[2 * i + 1])}`;
    if (closed?.[k2]) d += "Z";
  }
  return d;
}
function fmtCanon(v) {
  return String(Math.round(v * 1e4) / 1e4);
}
function cubicsToPathD(paths) {
  let d = "";
  for (const { pts, closed } of paths) {
    d += `M${fmtCanon(pts[0])} ${fmtCanon(pts[1])}`;
    for (let i = 2; i < pts.length; i += 6) d += `C${fmtCanon(pts[i])} ${fmtCanon(pts[i + 1])} ${fmtCanon(pts[i + 2])} ${fmtCanon(pts[i + 3])} ${fmtCanon(pts[i + 4])} ${fmtCanon(pts[i + 5])}`;
    if (closed) d += "Z";
  }
  return d;
}
var KAPPA = 4 / 3 * Math.tan(Math.PI / 8);
var TAU = 2 * Math.PI;
function builder(x0, y0) {
  const pts = [x0, y0];
  let cx = x0;
  let cy = y0;
  const cubic = (x1, y1, x2, y2, x, y) => {
    pts.push(x1, y1, x2, y2, x, y);
    cx = x;
    cy = y;
  };
  const line = (x, y) => {
    if (Math.abs(x - cx) < 1e-12 && Math.abs(y - cy) < 1e-12) return;
    cubic(cx + (x - cx) / 3, cy + (y - cy) / 3, cx + 2 * (x - cx) / 3, cy + 2 * (y - cy) / 3, x, y);
  };
  const quad = (x1, y1, x, y) => {
    cubic(cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy), x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y), x, y);
  };
  const arc = (rx0, ry0, rotDeg, large, sweep, x, y) => {
    const x1 = cx;
    const y1 = cy;
    if (Math.abs(x - x1) < 1e-12 && Math.abs(y - y1) < 1e-12) return;
    let rx = Math.abs(rx0);
    let ry = Math.abs(ry0);
    if (rx < 1e-12 || ry < 1e-12) {
      line(x, y);
      return;
    }
    const phi = rotDeg * Math.PI / 180;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);
    const hx = (x1 - x) / 2;
    const hy = (y1 - y) / 2;
    const x1p = cosP * hx + sinP * hy;
    const y1p = -sinP * hx + cosP * hy;
    const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if (lam > 1) {
      const s = Math.sqrt(lam);
      rx *= s;
      ry *= s;
    }
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    const xp2 = x1p * x1p;
    const yp2 = y1p * y1p;
    let rad = (rx2 * ry2 - rx2 * yp2 - ry2 * xp2) / (rx2 * yp2 + ry2 * xp2);
    if (rad < 0) rad = 0;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(rad);
    const cxp = co * rx * y1p / ry;
    const cyp = -co * ry * x1p / rx;
    const ccx = cosP * cxp - sinP * cyp + (x1 + x) / 2;
    const ccy = sinP * cxp + cosP * cyp + (y1 + y) / 2;
    const th1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
    let dth = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - th1;
    if (sweep === 0 && dth > 0) dth -= TAU;
    else if (sweep === 1 && dth < 0) dth += TAU;
    const slices = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
    const delta = dth / slices;
    const alpha = 4 / 3 * Math.tan(delta / 4);
    const ex = (t) => ccx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP;
    const ey = (t) => ccy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP;
    const dx = (t) => -rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP;
    const dy = (t) => -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP;
    let t0 = th1;
    let p0x = x1;
    let p0y = y1;
    for (let s = 1; s <= slices; s++) {
      const t1 = th1 + delta * s;
      const p1x = s === slices ? x : ex(t1);
      const p1y = s === slices ? y : ey(t1);
      cubic(p0x + alpha * dx(t0), p0y + alpha * dy(t0), p1x - alpha * dx(t1), p1y - alpha * dy(t1), p1x, p1y);
      t0 = t1;
      p0x = p1x;
      p0y = p1y;
    }
  };
  const finish = (closed) => {
    if (closed) line(pts[0], pts[1]);
    if (pts.length < 8) return null;
    return {
      pts: Float64Array.from(pts),
      closed
    };
  };
  return [
    cubic,
    line,
    quad,
    arc,
    finish
  ];
}
function lowerSubpath(raw) {
  const [cubic, line, quad, arc, finish] = builder(raw.x0, raw.y0);
  for (const s of raw.segs) switch (s[0]) {
    case "L":
      line(s[1], s[2]);
      break;
    case "C":
      cubic(s[1], s[2], s[3], s[4], s[5], s[6]);
      break;
    case "Q":
      quad(s[1], s[2], s[3], s[4]);
      break;
    case "A":
      arc(s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
  }
  return finish(raw.closed);
}
function attrNum(attrs, key, fallback = 0) {
  const v = attrs[key];
  if (v === void 0) return fallback;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function parsePoints(v) {
  const s = String(v ?? "").trim();
  if (!s) return [];
  const nums = s.split(/[\s,]+/).map(Number);
  if (nums.some((x) => !Number.isFinite(x))) throw new Error(`morphicons: invalid points: "${s}"`);
  return nums;
}
function polyPath(nums, closed) {
  if (nums.length < 4) return null;
  const [, line, , , finish] = builder(nums[0], nums[1]);
  for (let i = 2; i + 1 < nums.length; i += 2) line(nums[i], nums[i + 1]);
  return finish(closed);
}
function ellipsePath(cx, cy, rx, ry) {
  if (rx < 1e-12 || ry < 1e-12) return null;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  const e2 = cx + rx;
  const w2 = cx - rx;
  const s = cy + ry;
  const n = cy - ry;
  const [cubic, , , , finish] = builder(e2, cy);
  cubic(e2, cy + ky, cx + kx, s, cx, s);
  cubic(cx - kx, s, w2, cy + ky, w2, cy);
  cubic(w2, cy - ky, cx - kx, n, cx, n);
  cubic(cx + kx, n, e2, cy - ky, e2, cy);
  return finish(true);
}
function rectPath(attrs) {
  const x = attrNum(attrs, "x");
  const y = attrNum(attrs, "y");
  const w2 = attrNum(attrs, "width");
  const h = attrNum(attrs, "height");
  if (w2 < 1e-12 || h < 1e-12) return null;
  let rx = attrNum(attrs, "rx", NaN);
  let ry = attrNum(attrs, "ry", NaN);
  if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
  if (Number.isNaN(ry)) ry = rx;
  rx = Math.min(Math.max(rx, 0), w2 / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx < 1e-12 || ry < 1e-12) return polyPath([
    x,
    y,
    x + w2,
    y,
    x + w2,
    y + h,
    x,
    y + h
  ], true);
  const xa = x + rx;
  const xb = x + w2 - rx;
  const xr = x + w2;
  const ya = y + ry;
  const yb = y + h - ry;
  const yd = y + h;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  const [cubic, line, , , finish] = builder(xa, y);
  line(xb, y);
  cubic(xb + kx, y, xr, ya - ky, xr, ya);
  line(xr, yb);
  cubic(xr, yb + ky, xb + kx, yd, xb, yd);
  line(xa, yd);
  cubic(xa - kx, yd, x, yb + ky, x, yb);
  line(x, ya);
  cubic(x, ya - ky, xa - kx, y, xa, y);
  return finish(true);
}
function iconToCubics(input) {
  const out = [];
  const push = (p) => {
    if (p) out.push(p);
  };
  if (typeof input === "string") {
    for (const s of parsePath(input)) push(lowerSubpath(s));
    return out;
  }
  for (const [tag, attrs] of input) switch (tag) {
    case "path":
      for (const s of parsePath(String(attrs.d ?? ""))) push(lowerSubpath(s));
      break;
    case "line": {
      const [, line, , , finish] = builder(attrNum(attrs, "x1"), attrNum(attrs, "y1"));
      line(attrNum(attrs, "x2"), attrNum(attrs, "y2"));
      push(finish(false));
      break;
    }
    case "circle": {
      const r = attrNum(attrs, "r");
      push(ellipsePath(attrNum(attrs, "cx"), attrNum(attrs, "cy"), r, r));
      break;
    }
    case "ellipse":
      push(ellipsePath(attrNum(attrs, "cx"), attrNum(attrs, "cy"), attrNum(attrs, "rx"), attrNum(attrs, "ry")));
      break;
    case "rect":
      push(rectPath(attrs));
      break;
    case "polyline":
      push(polyPath(parsePoints(attrs.points), false));
      break;
    case "polygon":
      push(polyPath(parsePoints(attrs.points), true));
      break;
    default:
      throw new Error(`morphicons: unsupported tag <${tag}>`);
  }
  return out;
}

// node_modules/morphicons/dist/spring-CFHloqPP.js
function allocOutputs(plan) {
  return plan.items.map(() => new Float64Array(2 * plan.n));
}
function interpPolar(plan, t, out) {
  for (let k2 = 0; k2 < plan.items.length; k2++) {
    const it = plan.items[k2];
    const o = out[k2];
    const n = plan.n;
    const s = Math.exp(it.lnSigma * t);
    const ang = it.theta * t;
    const cos = Math.cos(ang) * s;
    const sin = Math.sin(ang) * s;
    let cx;
    let cy;
    if (it.block) {
      const [ox, oy] = it.block.off;
      const [dx, dy] = it.block.drift;
      cx = it.ca[0] + dx * t + (ox * cos - oy * sin - ox);
      cy = it.ca[1] + dy * t + (ox * sin + oy * cos - oy);
    } else {
      cx = it.ca[0] + (it.cb[0] - it.ca[0]) * t;
      cy = it.ca[1] + (it.cb[1] - it.ca[1]) * t;
    }
    for (let i = 0; i < n; i++) {
      const px = it.aC[2 * i] + (it.bT[2 * i] - it.aC[2 * i]) * t;
      const py = it.aC[2 * i + 1] + (it.bT[2 * i + 1] - it.aC[2 * i + 1]) * t;
      o[2 * i] = cx + px * cos - py * sin;
      o[2 * i + 1] = cy + px * sin + py * cos;
    }
  }
}
var LEN_WEIGHT = 0.35;
var LAMBDA = 0.05;
var GLOBAL_EPS = 5e-3;
var PERM_MAX = 8;
var SURJ_MAX = 1e5;
function centroid(p) {
  const n = p.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += p[2 * i];
    cy += p[2 * i + 1];
  }
  return [cx / n, cy / n];
}
function polyLen(p) {
  const n = p.length / 2;
  let L = 0;
  for (let i = 1; i < n; i++) L += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
  return L;
}
function reversePts(p) {
  const n = p.length / 2;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    out[2 * i] = p[2 * (n - 1 - i)];
    out[2 * i + 1] = p[2 * (n - 1 - i) + 1];
  }
  return out;
}
function rotatePts(p, off) {
  const n = p.length / 2;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const j2 = (i + off) % n;
    out[2 * i] = p[2 * j2];
    out[2 * i + 1] = p[2 * j2 + 1];
  }
  return out;
}
function procrustes(a, b, ca, cb) {
  const n = a.length / 2;
  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  let syy = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const ax = a[2 * i] - ca[0];
    const ay = a[2 * i + 1] - ca[1];
    const bx = b[2 * i] - cb[0];
    const by = b[2 * i + 1] - cb[1];
    sxx += ax * bx;
    syy += ay * by;
    sxy += ax * by;
    syx += ay * bx;
    na += ax * ax + ay * ay;
    nb += bx * bx + by * by;
  }
  const theta = Math.atan2(sxy - syx, sxx + syy);
  const num = Math.cos(theta) * (sxx + syy) + Math.sin(theta) * (sxy - syx);
  let sigma = na > 1e-12 ? num / na : 1;
  if (!(sigma > 1e-6)) sigma = 1e-6;
  const res2 = Math.max(0, sigma * sigma * na - 2 * sigma * num + nb);
  const res = nb > 1e-12 ? Math.sqrt(res2 / nb) : 0;
  return {
    theta,
    sigma,
    res
  };
}
function alignPair(aPts, bPts, aClosed = false, bClosed = false) {
  const ca = centroid(aPts);
  const cb = centroid(bPts);
  const varyA = aClosed && !bClosed;
  const base = varyA ? aPts : bPts;
  const offs = aClosed || bClosed ? base.length / 2 : 1;
  let bestScore = Number.POSITIVE_INFINITY;
  let best = base;
  let sim = {
    theta: 0,
    sigma: 1,
    res: 0
  };
  for (let dir = 0; dir < 2; dir++) {
    const walk = dir ? reversePts(base) : base;
    for (let off = 0; off < offs; off++) {
      const cand = off ? rotatePts(walk, off) : walk;
      const s = varyA ? procrustes(cand, bPts, ca, cb) : procrustes(aPts, cand, ca, cb);
      const score = s.res + LAMBDA * Math.abs(s.theta) / Math.PI;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
        sim = s;
      }
    }
  }
  return varyA ? {
    ca,
    cb,
    a: best,
    b: bPts,
    ...sim
  } : {
    ca,
    cb,
    a: aPts,
    b: best,
    ...sim
  };
}
function costMatrix(A, B) {
  const cbs = B.map(centroid);
  const lbs = B.map(polyLen);
  return A.map((a) => {
    const ca = centroid(a);
    const la = polyLen(a);
    return cbs.map((cb, j2) => Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) + LEN_WEIGHT * Math.abs(la - lbs[j2]));
  });
}
function bestPermutation(C2) {
  const n = C2.length;
  if (n > PERM_MAX) {
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j2 = 0; j2 < n; j2++) pairs.push([
      C2[i][j2],
      i,
      j2
    ]);
    pairs.sort((x, y) => x[0] - y[0]);
    const out = new Array(n).fill(-1);
    const used = new Array(n).fill(false);
    for (const [, i, j2] of pairs) if (out[i] < 0 && !used[j2]) {
      out[i] = j2;
      used[j2] = true;
    }
    return out;
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  let best = idx.slice();
  let bc = Number.POSITIVE_INFINITY;
  const perm = (arr, k2, acc) => {
    if (acc >= bc) return;
    if (k2 === n) {
      bc = acc;
      best = arr.slice();
      return;
    }
    for (let i = k2; i < n; i++) {
      [arr[k2], arr[i]] = [arr[i], arr[k2]];
      perm(arr, k2 + 1, acc + C2[k2][arr[k2]]);
      [arr[k2], arr[i]] = [arr[i], arr[k2]];
    }
  };
  perm(idx, 0, 0);
  return best;
}
function bestSurjection(C2) {
  const B = C2.length;
  const S = C2[0].length;
  if (S ** B > SURJ_MAX) {
    const f2 = C2.map((row) => {
      let m = 0;
      for (let j2 = 1; j2 < row.length; j2++) if (row[j2] < row[m]) m = j2;
      return m;
    });
    const mult2 = new Array(S).fill(0);
    for (const s of f2) mult2[s]++;
    for (let s = 0; s < S; s++) {
      if (mult2[s] > 0) continue;
      let bi = -1;
      let bc2 = Number.POSITIVE_INFINITY;
      for (let i = 0; i < B; i++) {
        if (mult2[f2[i]] < 2) continue;
        const extra = C2[i][s] - C2[i][f2[i]];
        if (extra < bc2) {
          bc2 = extra;
          bi = i;
        }
      }
      mult2[f2[bi]]--;
      f2[bi] = s;
      mult2[s]++;
    }
    return f2;
  }
  let best = null;
  let bc = Number.POSITIVE_INFINITY;
  const f = new Array(B);
  const mult = new Array(S).fill(0);
  const rec = (i, acc, covered) => {
    if (acc >= bc || S - covered > B - i) return;
    if (i === B) {
      bc = acc;
      best = f.slice();
      return;
    }
    for (let s = 0; s < S; s++) {
      f[i] = s;
      mult[s]++;
      rec(i + 1, acc + C2[i][s], covered + (mult[s] === 1 ? 1 : 0));
      mult[s]--;
    }
  };
  rec(0, 0, 0);
  if (!best) throw new Error("morphicons: no valid surjection (B < S)");
  return best;
}
function applyGlobal(items, n) {
  const T = items.length * n;
  const ga = new Float64Array(2 * T);
  const gb = new Float64Array(2 * T);
  items.forEach((it, k2) => {
    ga.set(it.a, 2 * n * k2);
    gb.set(it.bO, 2 * n * k2);
  });
  const gca = centroid(ga);
  const g = procrustes(ga, gb, gca, centroid(gb));
  if (g.res >= GLOBAL_EPS) return;
  const cos = Math.cos(-g.theta);
  const sin = Math.sin(-g.theta);
  const rc = Math.cos(g.theta);
  const rs = Math.sin(g.theta);
  for (const it of items) {
    let e2 = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
      const bx = it.bO[2 * i] - it.cb[0];
      const by = it.bO[2 * i + 1] - it.cb[1];
      it.bT[2 * i] = (bx * cos - by * sin) / g.sigma;
      it.bT[2 * i + 1] = (bx * sin + by * cos) / g.sigma;
      const ex = g.sigma * (rc * it.aC[2 * i] - rs * it.aC[2 * i + 1]) - bx;
      const ey = g.sigma * (rs * it.aC[2 * i] + rc * it.aC[2 * i + 1]) - by;
      e2 += ex * ex + ey * ey;
      nb += bx * bx + by * by;
    }
    it.theta = g.theta;
    it.lnSigma = Math.log(g.sigma);
    it.res = nb > 1e-12 ? Math.sqrt(e2 / nb) : 0;
    const s1 = Math.exp(it.lnSigma);
    const c1 = Math.cos(it.theta) * s1;
    const n1 = Math.sin(it.theta) * s1;
    const ox = it.ca[0] - gca[0];
    const oy = it.ca[1] - gca[1];
    const rx = ox * c1 - oy * n1 - ox;
    const ry = ox * n1 + oy * c1 - oy;
    it.block = {
      off: [ox, oy],
      drift: [it.cb[0] - it.ca[0] - rx, it.cb[1] - it.ca[1] - ry]
    };
  }
}
function buildPlan(srcSubs, dstSubs) {
  const p = srcSubs.length;
  const q2 = dstSubs.length;
  if (p === 0 || q2 === 0) throw new Error("morphicons: icon has no subpaths");
  const A = srcSubs.map((s) => s.pts);
  const B = dstSubs.map((s) => s.pts);
  const pairs = [];
  if (p === q2) {
    const perm = bestPermutation(costMatrix(A, B));
    for (let i = 0; i < p; i++) pairs.push([i, perm[i]]);
  } else if (p < q2) {
    const f = bestSurjection(costMatrix(B, A));
    for (let j2 = 0; j2 < q2; j2++) pairs.push([f[j2], j2]);
  } else {
    const f = bestSurjection(costMatrix(A, B));
    for (let i = 0; i < p; i++) pairs.push([i, f[i]]);
  }
  const n = A[0].length / 2;
  const items = pairs.map(([si, di]) => {
    const al = alignPair(A[si], B[di], srcSubs[si].closed, dstSubs[di].closed);
    const a = al.a;
    const aC = new Float64Array(2 * n);
    const bT = new Float64Array(2 * n);
    const bO = new Float64Array(2 * n);
    const cos = Math.cos(-al.theta);
    const sin = Math.sin(-al.theta);
    for (let i = 0; i < n; i++) {
      aC[2 * i] = a[2 * i] - al.ca[0];
      aC[2 * i + 1] = a[2 * i + 1] - al.ca[1];
      const bx = al.b[2 * i] - al.cb[0];
      const by = al.b[2 * i + 1] - al.cb[1];
      bT[2 * i] = (bx * cos - by * sin) / al.sigma;
      bT[2 * i + 1] = (bx * sin + by * cos) / al.sigma;
      bO[2 * i] = al.b[2 * i];
      bO[2 * i + 1] = al.b[2 * i + 1];
    }
    return {
      a,
      aC,
      bT,
      bO,
      ca: al.ca,
      cb: al.cb,
      theta: al.theta,
      lnSigma: Math.log(al.sigma),
      res: al.res,
      closed: srcSubs[si].closed && dstSubs[di].closed,
      block: null
    };
  });
  if (items.length > 1) applyGlobal(items, n);
  return {
    items,
    n
  };
}
var CORNER_THRESHOLD = Math.PI / 8;
var GX = [
  0.18343464249564978,
  0.525532409916329,
  0.7966664774136267,
  0.9602898564975363
];
var GW = [
  0.362683783378362,
  0.31370664587788727,
  0.22238103445337448,
  0.10122853629037626
];
function speed(p, k2, t) {
  const i = 6 * k2;
  const u = 1 - t;
  const c0 = 3 * u * u;
  const c1 = 6 * u * t;
  const c2 = 3 * t * t;
  const dx = c0 * (p[i + 2] - p[i]) + c1 * (p[i + 4] - p[i + 2]) + c2 * (p[i + 6] - p[i + 4]);
  const dy = c0 * (p[i + 3] - p[i + 1]) + c1 * (p[i + 5] - p[i + 3]) + c2 * (p[i + 7] - p[i + 5]);
  return Math.hypot(dx, dy);
}
function segLen(p, k2, t1 = 1) {
  const half = t1 / 2;
  let s = 0;
  for (let j2 = 0; j2 < 4; j2++) s += GW[j2] * (speed(p, k2, half + half * GX[j2]) + speed(p, k2, half - half * GX[j2]));
  return s * half;
}
function point(p, k2, t, out, o) {
  const i = 6 * k2;
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  out[o] = b0 * p[i] + b1 * p[i + 2] + b2 * p[i + 4] + b3 * p[i + 6];
  out[o + 1] = b0 * p[i + 1] + b1 * p[i + 3] + b2 * p[i + 5] + b3 * p[i + 7];
}
function tangent(p, k2, atEnd) {
  const i = 6 * k2;
  const b = atEnd ? i + 6 : i;
  const s = atEnd ? -1 : 1;
  for (const j2 of atEnd ? [
    4,
    2,
    0
  ] : [
    2,
    4,
    6
  ]) {
    const dx = s * (p[i + j2] - p[b]);
    const dy = s * (p[i + j2 + 1] - p[b + 1]);
    if (dx * dx + dy * dy > 1e-18) return [dx, dy];
  }
  return null;
}
function detectCorners(path, threshold = CORNER_THRESHOLD) {
  const p = path.pts;
  const m = (p.length / 2 - 1) / 3;
  const active = [];
  for (let k2 = 0; k2 < m; k2++) if (segLen(p, k2) > 1e-9) active.push(k2);
  if (active.length === 0) return [];
  const corners = /* @__PURE__ */ new Set();
  const test = (a, b) => {
    const u = tangent(p, a, true);
    const v = tangent(p, b, false);
    if (!u || !v) return;
    if (Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) > threshold) corners.add(b);
  };
  for (let j2 = 0; j2 + 1 < active.length; j2++) test(active[j2], active[j2 + 1]);
  if (path.closed && active.length > 1) test(active[active.length - 1], active[0]);
  return [...corners].sort((a, b) => a - b);
}
function invert(p, k2, s, ls) {
  if (s <= 0) return 0;
  if (s >= ls) return 1;
  let lo = 0;
  let hi = 1;
  let t = s / ls;
  for (let it = 0; it < 12; it++) {
    const f = segLen(p, k2, t) - s;
    if (Math.abs(f) < 1e-10 * ls + 1e-14) break;
    if (f > 0) hi = t;
    else lo = t;
    const sp = speed(p, k2, t);
    let nt2 = sp > 1e-12 ? t - f / sp : (lo + hi) / 2;
    if (!(nt2 > lo && nt2 < hi)) nt2 = (lo + hi) / 2;
    t = nt2;
  }
  return t;
}
function resamplePath(path, N = 64, cornerThreshold = CORNER_THRESHOLD) {
  const p = path.pts;
  const m = (p.length / 2 - 1) / 3;
  const out = new Float64Array(2 * N);
  const fill = () => {
    for (let i = 0; i < N; i++) {
      out[2 * i] = p[0];
      out[2 * i + 1] = p[1];
    }
    return out;
  };
  if (m < 1) return fill();
  const lens = new Array(m);
  let L = 0;
  for (let k2 = 0; k2 < m; k2++) {
    lens[k2] = segLen(p, k2);
    L += lens[k2];
  }
  if (L < 1e-12) return fill();
  const cs = detectCorners(path, cornerThreshold);
  const anchors = path.closed ? cs.length > 0 ? cs : [0] : [.../* @__PURE__ */ new Set([
    0,
    ...cs,
    m
  ])].sort((a, b) => a - b);
  const runs = [];
  if (path.closed) for (let j2 = 0; j2 < anchors.length; j2++) {
    const a = anchors[j2];
    const b = j2 + 1 < anchors.length ? anchors[j2 + 1] : anchors[0] + m;
    runs.push([a, b]);
  }
  else for (let j2 = 0; j2 + 1 < anchors.length; j2++) runs.push([anchors[j2], anchors[j2 + 1]]);
  const rl = runs.map(([a, b]) => {
    let s = 0;
    for (let k2 = a; k2 < b; k2++) s += lens[k2 % m];
    return s;
  });
  const intervals = path.closed ? N : N - 1;
  if (runs.length > intervals) throw new Error(`morphicons: N=${N} too small (${runs.length} runs)`);
  const total = rl.reduce((a, b) => a + b, 0) || 1;
  const ideal = rl.map((l) => intervals * l / total);
  const counts = ideal.map((q2) => Math.max(1, Math.floor(q2)));
  let R = intervals - counts.reduce((a, b) => a + b, 0);
  if (R > 0) {
    const order = ideal.map((q2, idx) => [Math.round((q2 - Math.floor(q2)) * 1e9), idx]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let j2 = 0; j2 < R; j2++) counts[order[j2 % counts.length][1]]++;
  }
  while (R < 0) {
    let bi = 0;
    for (let idx = 1; idx < counts.length; idx++) if (counts[idx] > counts[bi]) bi = idx;
    if (counts[bi] <= 1) break;
    counts[bi]--;
    R++;
  }
  let w2 = 0;
  for (let r = 0; r < runs.length; r++) {
    const [k0, k1] = runs[r];
    const cnt = counts[r];
    const Lr = rl[r];
    const vi = 6 * (k0 % m);
    out[2 * w2] = p[vi];
    out[2 * w2 + 1] = p[vi + 1];
    w2++;
    let seg = k0;
    let acc = 0;
    for (let j2 = 1; j2 < cnt; j2++) {
      const target = Lr * j2 / cnt;
      while (seg < k1 - 1 && acc + lens[seg % m] < target) {
        acc += lens[seg % m];
        seg++;
      }
      const k2 = seg % m;
      const ls = lens[k2];
      point(p, k2, ls > 1e-12 ? invert(p, k2, target - acc, ls) : 0, out, 2 * w2);
      w2++;
    }
  }
  if (!path.closed) {
    const vi = 6 * m;
    out[2 * w2] = p[vi];
    out[2 * w2 + 1] = p[vi + 1];
  }
  return out;
}
function resampleIcon(input, N = 64) {
  return iconToCubics(input).map((path) => ({
    pts: resamplePath(path, N),
    closed: path.closed
  }));
}
var Spring = class {
  x = 1;
  v = 0;
  k = 250;
  c = 24;
  config(k2, c) {
    this.k = k2;
    this.c = c;
  }
  /** Starts (or restarts mid-flight) preserving velocity. */
  start() {
    this.x = 0;
    if (this.v > 14) this.v = 14;
    if (this.v < -14) this.v = -14;
  }
  /** Advances dt seconds. Returns true on settle (|1−x| < 0.001 ∧ |v| < 0.02). */
  step(dt) {
    const steps = Math.max(1, Math.min(16, Math.ceil(dt / (1 / 240))));
    const s = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = this.k * (1 - this.x) - this.c * this.v;
      this.v += a * s;
      this.x += this.v * s;
    }
    return Math.abs(1 - this.x) < 1e-3 && Math.abs(this.v) < 0.02;
  }
};
var SPRING_PRESETS = {
  /** ζ = 1.00 — critically damped, no overshoot. */
  smooth: {
    k: 170,
    c: 26
  },
  /** ζ = 0.73 — fast, subtle overshoot. */
  snappy: {
    k: 420,
    c: 30
  },
  /** ζ = 0.40 — playful. */
  bouncy: {
    k: 300,
    c: 14
  }
};

// node_modules/morphicons/dist/dom.js
var tickers = /* @__PURE__ */ new Set();
var rafId = 0;
var last = -1;
function loop(ts) {
  const dt = last < 0 ? 0 : Math.min(Math.max((ts - last) / 1e3, 0), 0.1);
  last = ts;
  for (const tick of [...tickers]) tick(dt);
  if (tickers.size > 0) rafId = requestAnimationFrame(loop);
  else {
    rafId = 0;
    last = -1;
  }
}
function addTicker(tick) {
  tickers.add(tick);
  if (rafId === 0) {
    last = -1;
    rafId = requestAnimationFrame(loop);
  }
}
function removeTicker(tick) {
  tickers.delete(tick);
  if (tickers.size === 0 && rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    last = -1;
  }
}
var samples = /* @__PURE__ */ new WeakMap();
var canon = /* @__PURE__ */ new WeakMap();
var plans = /* @__PURE__ */ new WeakMap();
function sampledOf(icon) {
  if (typeof icon === "string") return resampleIcon(icon);
  let s = samples.get(icon);
  if (!s) {
    s = resampleIcon(icon);
    samples.set(icon, s);
  }
  return s;
}
function canonicalD(icon) {
  if (typeof icon === "string") return icon;
  let d = canon.get(icon);
  if (!d) {
    d = cubicsToPathD(iconToCubics(icon));
    canon.set(icon, d);
  }
  return d;
}
function planBetween(src, dst) {
  if (typeof src === "string" || typeof dst === "string") return buildPlan(sampledOf(src), sampledOf(dst));
  let inner = plans.get(src);
  if (!inner) {
    inner = /* @__PURE__ */ new WeakMap();
    plans.set(src, inner);
  }
  let p = inner.get(dst);
  if (!p) {
    p = buildPlan(sampledOf(src), sampledOf(dst));
    inner.set(dst, p);
  }
  return p;
}
function resolveSpring(s) {
  if (typeof s === "string") return SPRING_PRESETS[s];
  const d = SPRING_PRESETS.snappy;
  return {
    k: s?.stiffness ?? d.k,
    c: s?.damping ?? d.c
  };
}
function createMorph(el, icon, options) {
  const spring = new Spring();
  let reducedMotion = options?.reducedMotion ?? "never";
  let target = icon;
  let rest = true;
  let plan = null;
  let out = null;
  let closed = null;
  let t = 1;
  let flying = false;
  let dead = false;
  el.setAttribute("d", canonicalD(icon));
  const render = (tt2) => {
    const p = plan;
    const o = out;
    const cl = closed;
    if (!p || !o || !cl) return;
    t = tt2;
    interpPolar(p, tt2, o);
    el.setAttribute("d", serialize(o, cl));
  };
  const stop = () => {
    if (!flying) return;
    flying = false;
    removeTicker(tick);
  };
  const tick = (dt) => {
    const settled = spring.step(dt);
    render(spring.x);
    if (settled) {
      stop();
      settle();
    }
  };
  const settle = () => {
    rest = true;
    plan = null;
    out = null;
    closed = null;
    t = 1;
    spring.x = 1;
    spring.v = 0;
    el.setAttribute("d", canonicalD(target));
  };
  const snapshot = () => {
    const p = plan;
    const o = out;
    if (rest || !p || !o) return sampledOf(target);
    return o.map((buf, k2) => ({
      pts: Float64Array.from(buf),
      closed: p.items[k2].closed
    }));
  };
  const retarget = (icon2) => {
    plan = rest ? planBetween(target, icon2) : buildPlan(snapshot(), sampledOf(icon2));
    out = allocOutputs(plan);
    closed = plan.items.map((it) => it.closed);
    target = icon2;
    rest = false;
  };
  const setNow = (icon2) => {
    stop();
    target = icon2;
    settle();
  };
  const motionOff = () => {
    if (reducedMotion === "always") return true;
    if (reducedMotion !== "user") return false;
    if (typeof matchMedia === "undefined") return false;
    return matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  };
  const seek = (icon2, tt2) => {
    if (dead) return;
    const reuse = !rest && plan !== null && icon2 === target;
    stop();
    spring.v = 0;
    if (!reuse) retarget(icon2);
    render(tt2);
  };
  return {
    morphTo(icon2, sp) {
      if (dead) return;
      if (icon2 === target && (rest || flying)) return;
      if (motionOff()) {
        setNow(icon2);
        return;
      }
      const { k: k2, c } = resolveSpring(sp);
      spring.config(k2, c);
      retarget(icon2);
      spring.start();
      if (!flying) {
        flying = true;
        addTicker(tick);
      }
    },
    set(icon2) {
      if (dead) return;
      setNow(icon2);
    },
    seek,
    get progress() {
      return rest ? 1 : t;
    },
    set progress(v) {
      if (!dead) seek(target, v);
    },
    get reducedMotion() {
      return reducedMotion;
    },
    set reducedMotion(v) {
      reducedMotion = v;
    },
    destroy() {
      stop();
      dead = true;
      plan = null;
      out = null;
      closed = null;
    }
  };
}

// node_modules/torph/dist/index.mjs
var _t = { locale: "en", duration: 400, ease: "cubic-bezier(0.19, 1, 0.22, 1)", disabled: false, respectReducedMotion: true };
function Dt(e2, t, n) {
  if (n < 1) {
    let u = t * Math.sqrt(1 - n * n);
    return 1 - Math.exp(-n * t * e2) * (Math.cos(u * e2) + n * t / u * Math.sin(u * e2));
  }
  let i = Math.sqrt(n * n - 1), r = -t * (n + i), s = -t * (n - i), o = -r / (s - r);
  return 1 - (1 - o) * Math.exp(r * e2) - o * Math.exp(s * e2);
}
function Ie(e2, t, n) {
  let s = 0;
  for (let o = 0; o < 10; o += 1e-3) if (Math.abs(Dt(o, e2, t) - 1) > n) s = 0;
  else if (s += 1e-3, s > 0.1) return Math.ceil((o - s + 1e-3) * 1e3);
  return Math.ceil(10 * 1e3);
}
function Ft(e2, t) {
  if (typeof e2 == "object") {
    let n = Le(e2);
    return { ease: n.easing, duration: n.duration };
  }
  return { ease: e2, duration: t };
}
var $t = /* @__PURE__ */ new Map();
function Le(e2) {
  let { stiffness: t = 100, damping: n = 10, mass: i = 1, precision: r = 1e-3 } = e2 ?? {}, s = `${t}:${n}:${i}:${r}`, o = $t.get(s);
  if (o) return o;
  let a = Math.sqrt(t / i), u = n / (2 * Math.sqrt(t * i)), c = Ie(a, u, r), f = Math.min(100, Math.max(32, Math.round(c / 15))), l = [];
  for (let d = 0; d < f; d++) {
    let h = d / (f - 1) * (c / 1e3), M = d === f - 1 ? 1 : Dt(h, a, u);
    l.push(Math.round(M * 1e4) / 1e4 + "");
  }
  for (; l.length > 2 && l[l.length - 2] === "1"; ) l.splice(l.length - 2, 1);
  let m = { easing: `linear(${l.join(", ")})`, duration: c };
  return $t.set(s, m), m;
}
function G(e2, t) {
  let n = e2.length, i = t.length, r = Array.from({ length: n + 1 }, () => Array(i + 1).fill(0));
  for (let c = n - 1; c >= 0; c--) for (let f = i - 1; f >= 0; f--) r[c][f] = e2[c] === t[f] ? r[c + 1][f + 1] + 1 : Math.max(r[c + 1][f], r[c][f + 1]);
  let s = [], o = [], a = 0, u = 0;
  for (; a < n && u < i; ) e2[a] === t[u] ? (s.push(a), o.push(u), a++, u++) : r[a + 1][u] >= r[a][u + 1] ? a++ : u++;
  return [s, o];
}
var Ne = "\0n";
var ke = 0;
function ht() {
  return `${Ne}${ke++}`;
}
function k(e2) {
  return e2 >= "0" && e2 <= "9";
}
function q(e2) {
  for (let t of e2) if (k(t)) return true;
  return false;
}
function gt(e2) {
  let t = "";
  for (let n of e2) !k(n) && !bt.includes(n) && (t += n);
  return t;
}
var bt = ".,'\xA0\u202F\u2009\u2007";
var He = "+-\u2212(#";
var Oe = `%.,!?:;)"'\u201D\u2019`;
var _e = /\p{Sc}/u;
function Pt(e2, t) {
  return t.includes(e2) || _e.test(e2);
}
function J(e2) {
  let t = 0, n = e2.length;
  for (; t < n && Pt(e2[t], He); ) t++;
  for (; n > t && Pt(e2[n - 1], Oe); ) n--;
  if (t >= n || !k(e2[t]) || !k(e2[n - 1])) return false;
  for (let i = t; i < n; i++) {
    let r = e2[i];
    if (!k(r) && !bt.includes(r)) return false;
  }
  return true;
}
function at(e2) {
  return k(e2) ? "digit" : "symbol";
}
var Ct = /* @__PURE__ */ new Map();
function xt(e2) {
  let t = String(e2), n = Ct.get(t);
  if (n) return n;
  let i = ".";
  try {
    i = new Intl.NumberFormat(e2).formatToParts(1.1).find((r) => r.type === "decimal")?.value ?? ".";
  } catch {
  }
  return Ct.set(t, i), i;
}
function U(e2, t, n, i = ".") {
  let r = e2.split("");
  if (!t || t.length === 0) return $e(r);
  let s = t.map((c) => c.string === "\xA0" ? " " : c.string), o = n != null ? De(s, r, n, i) : Fe(s, r, i), a = /* @__PURE__ */ new Set();
  for (let [, c] of o) a.add(t[c].id);
  let u = [];
  for (let c = 0; c < r.length; c++) {
    let f = r[c], l = at(f), m = f === " " ? "\xA0" : f;
    if (o.has(c)) {
      let d = o.get(c);
      u.push({ id: t[d].id, string: m, kind: l });
    } else {
      let d = ht();
      for (; a.has(d); ) d = ht();
      a.add(d), u.push({ id: d, string: m, kind: l });
    }
  }
  return u;
}
function $e(e2) {
  return e2.map((t) => ({ id: ht(), string: t === " " ? "\xA0" : t, kind: at(t) }));
}
function De(e2, t, n, i) {
  let r = /* @__PURE__ */ new Map(), s = Xt(e2, i), o = Xt(t, i), a = (m, d) => r.set(o[m], s[d]), u = 0;
  for (; u < o.length && o[u] < n; ) u++;
  let c = o.length - s.length;
  if (c > 0) {
    let m = u - c;
    for (let d = 0; d < m && d < s.length; d++) a(d, d);
    for (let d = u; d < o.length; d++) {
      let h = d - c;
      h >= 0 && h < s.length && a(d, h);
    }
  } else if (c < 0) {
    for (let m = 0; m < u && m < o.length; m++) a(m, m);
    for (let m = u; m < o.length; m++) {
      let d = m - c;
      d >= 0 && d < s.length && a(m, d);
    }
  } else for (let m = 0; m < o.length; m++) t[o[m]] === e2[s[m]] && a(m, m);
  let f = Bt(e2, i), l = Bt(t, i);
  for (let m = 1; m <= f.length && m <= l.length; m++) {
    let d = f[f.length - m], h = l[l.length - m];
    e2[d] === t[h] && r.set(h, d);
  }
  return r;
}
function Kt(e2, t) {
  return e2 !== t && bt.includes(e2);
}
function Xt(e2, t) {
  let n = [];
  for (let i = 0; i < e2.length; i++) Kt(e2[i], t) || n.push(i);
  return n;
}
function Bt(e2, t) {
  let n = [];
  for (let i = 0; i < e2.length; i++) Kt(e2[i], t) && n.push(i);
  return n;
}
function Fe(e2, t, n) {
  let i = /* @__PURE__ */ new Map(), r = 0;
  for (; r < e2.length && r < t.length && e2[r] === t[r] && !k(e2[r]); ) i.set(r, r), r++;
  let s = e2.length, o = t.length;
  for (; s > r && o > r && e2[s - 1] === t[o - 1] && !k(e2[s - 1]); ) i.set(o - 1, s - 1), s--, o--;
  let a = Ut(e2, r, s, n), u = Ut(t, r, o, n), c = Gt(e2, r, a), f = Gt(t, r, u);
  if (c > 0 && f > 0 && Math.abs(c - f) >= Pe) return i;
  if (!d(r, a, r, u, true)) for (let h = 1; a - h >= r && u - h >= r; h++) m(a - h, u - h);
  if (a < s && u < o) {
    i.set(u, a);
    for (let h = 1; a + h < s && u + h < o; h++) m(a + h, u + h);
    d(a + 1, s, u + 1, o, false);
  }
  function m(h, M) {
    let x = e2[h];
    k(x) || x === t[M] && i.set(M, h);
  }
  function d(h, M, x, T, L) {
    let E = Wt(e2, h, M), N = Wt(t, x, T);
    if (E.length === N.length || !L) {
      let A = Math.min(E.length, N.length);
      for (let _ = 0; _ < A; _++) {
        let B = E[_], rt = N[_];
        e2[B] === t[rt] && i.set(rt, B);
      }
      return false;
    }
    let g = E.map((A) => e2[A]).reverse(), v = N.map((A) => t[A]).reverse(), [R, O] = G(g, v);
    for (let A = 0; A < R.length; A++) {
      let _ = E[E.length - 1 - R[A]], B = N[N.length - 1 - O[A]];
      i.set(B, _);
    }
    return R.length > 0;
  }
  return i;
}
function Wt(e2, t, n) {
  let i = [];
  for (let r = t; r < n; r++) k(e2[r]) && i.push(r);
  return i;
}
var Pe = 3;
function Gt(e2, t, n) {
  let i = 0;
  for (let r = t; r < n; r++) k(e2[r]) && i++;
  return i;
}
function Ut(e2, t, n, i) {
  for (let r = n - 1; r >= t; r--) if (e2[r] === i) return r;
  return n;
}
function yt() {
  let e2 = /* @__PURE__ */ new Set();
  return { reserve(t) {
    e2.add(t);
  }, has(t) {
    return e2.has(t);
  }, take(t) {
    if (!e2.has(t)) return e2.add(t), t;
    let n = 1;
    for (; e2.has(`${t}~${n}`); ) n++;
    let i = `${t}~${n}`;
    return e2.add(i), i;
  } };
}
function zt(e2) {
  let t = [], n = [], i = () => {
    n.length !== 0 && (t.push({ word: n.map((r) => r.string).join(""), segments: n }), n = []);
  };
  for (let r of e2) r.string === "\xA0" || r.string === `
` ? i() : n.push(r);
  return i(), t;
}
function Yt(e2) {
  let t = [], n = [], i = () => {
    if (n.length === 0) return;
    let r = n.map((s) => s.string).join("");
    J(r) ? t.push(...U(r)) : t.push(...n), n = [];
  };
  for (let r of e2) r.string === "\xA0" || r.string === `
` ? (i(), t.push(r)) : n.push(r);
  return i(), t;
}
function K(e2, t, n = true) {
  let i = e2.includes(`
`), r = e2.includes(" ") || i, s = yt();
  if (i) {
    let a = e2.split(`
`), u = [], c = 0;
    return a.forEach((f, l) => {
      l > 0 && (u.push({ id: s.take(`newline-${c}`), string: `
` }), c += 1), f.length > 0 && u.push(...jt(f, t, true, c, s)), c += f.length;
    }), n ? Yt(u) : u;
  }
  let o = jt(e2, t, r, 0, s);
  return n ? Yt(o) : o;
}
function jt(e2, t, n, i, r) {
  if (/\p{Script=Han}/u.test(e2)) n = false;
  if (typeof Intl.Segmenter < "u") {
    let s = new Intl.Segmenter(t, { granularity: n ? "word" : "grapheme" });
    return Ce(s.segment(e2)[Symbol.iterator](), i, r);
  }
  return Xe(e2, n, i, r);
}
function Ce(e2, t, n) {
  let i = [];
  for (let r of Array.from(e2)) {
    let s = t + r.index;
    r.segment === " " ? i.push({ id: n.take(`space-${s}`), string: "\xA0" }) : i.push({ id: qt(r.segment, s, n), string: r.segment });
  }
  return i;
}
function qt(e2, t, n) {
  return n.has(e2) ? n.take(`${e2}-${t}`) : n.take(e2);
}
function Xe(e2, t, n, i) {
  let r = t ? e2.split(" ") : e2.split(""), s = [], o = n;
  return r.forEach((a, u) => {
    t && u > 0 && (s.push({ id: i.take(`space-${o}`), string: "\xA0" }), o += 1), s.push({ id: qt(a, o, i), string: a }), o += a.length;
  }), s;
}
var Y = "torph-root";
var Q = "torph-item";
var w = "torph-id";
var V = "torph-kind";
var F = "torph-slot";
var H = "torph-exiting";
var P = "torph-sr";
var Z = "torph-debug";
var tt = "empty";
var Be = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], "ease-in": [0.42, 0, 1, 1], "ease-out": [0, 0, 0.58, 1], "ease-in-out": [0.42, 0, 0.58, 1] };
var Jt = (e2, t, n) => {
  let i = 1 - n;
  return 3 * i * i * n * e2 + 3 * i * n * n * t + n * n * n;
};
function Qt(e2, t, n, i) {
  return (r) => {
    if (r <= 0) return 0;
    if (r >= 1) return 1;
    let s = 0, o = 1;
    for (let a = 0; a < 24; a += 1) {
      let u = (s + o) / 2;
      Jt(e2, n, u) < r ? s = u : o = u;
    }
    return Jt(t, i, (s + o) / 2);
  };
}
function We(e2) {
  let t = [...e2];
  (t[0] === null || t[0] === void 0) && (t[0] = 0), t[t.length - 1] === null && (t[t.length - 1] = 1);
  for (let n = 1; n < t.length; n += 1) {
    if (t[n] !== null) continue;
    let i = n;
    for (; t[i] === null; ) i += 1;
    let r = t[n - 1], s = (t[i] - r) / (i - n + 1);
    for (let o = n; o < i; o += 1) t[o] = r + s * (o - n + 1);
  }
  return t.map((n, i, r) => i === 0 ? n : Math.max(n, r[i - 1]));
}
function Ge(e2) {
  let t = [], n = [];
  for (let r of e2.split(",")) {
    let s = r.trim().split(/\s+/).filter(Boolean), o = Number(s[0]);
    if (!Number.isFinite(o)) return null;
    let a = s.slice(1);
    if (a.length > 2) return null;
    if (a.length === 0) {
      t.push(o), n.push(null);
      continue;
    }
    for (let u of a) {
      if (!u.endsWith("%")) return null;
      let c = Number(u.slice(0, -1));
      if (!Number.isFinite(c)) return null;
      t.push(o), n.push(c / 100);
    }
  }
  if (t.length < 2) return null;
  let i = We(n);
  return (r) => {
    if (r <= i[0]) return t[0];
    let s = i.length - 1;
    if (r >= i[s]) return t[s];
    let o = 0;
    for (; o < s && i[o + 1] < r; ) o += 1;
    let a = i[o + 1] - i[o];
    return a === 0 ? t[o + 1] : t[o] + (t[o + 1] - t[o]) * (r - i[o]) / a;
  };
}
function Vt(e2) {
  let t = e2.trim().toLowerCase(), n = Be[t];
  if (n) return Qt(...n);
  let i = /^cubic-bezier\(([^)]*)\)$/.exec(t);
  if (i) {
    let s = i[1].split(",").map((o) => Number(o.trim()));
    return s.length !== 4 || s.some((o) => !Number.isFinite(o)) ? null : Qt(s[0], s[1], s[2], s[3]);
  }
  let r = /^linear\(([^)]*)\)$/.exec(t);
  return r ? Ge(r[1]) : null;
}
var St = 1e-4;
function Mt(e2, t) {
  let n = Math.min(Math.max(t, 0), 1 - St);
  return (e2(n + St) - e2(n)) / St;
}
function lt(e2, t) {
  return e2 * t;
}
function X(e2) {
  let t = getComputedStyle(e2).transform;
  if (!t || t === "none") return { tx: 0, ty: 0 };
  let n = t.match(/matrix\(([^)]+)\)/);
  if (!n) return { tx: 0, ty: 0 };
  let i = n[1].split(",").map(Number);
  return { tx: i[4] || 0, ty: i[5] || 0 };
}
function et(e2) {
  let t = getComputedStyle(e2), n = parseFloat(t.width), i = parseFloat(t.height);
  if (Number.isNaN(n) || Number.isNaN(i)) {
    let r = e2.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }
  return { width: n, height: i };
}
function j(e2) {
  let { tx: t, ty: n } = X(e2), i = parseFloat(getComputedStyle(e2).opacity);
  return e2.getAnimations().forEach((r) => r.cancel()), { tx: t, ty: n, opacity: i };
}
var Ue = 8;
var Ke = 0.1;
var Ye = 0.5;
var je = 0.5;
var ee = () => performance.now();
function ze(e2, t) {
  let n = Math.max(0, Math.min(Ue, t) - Mt(e2, 0));
  if (!(n > 0)) return { curve: e2, k: 0 };
  let i = Math.max(3, Math.ceil(n / (Math.E * Ke)) - 1);
  return { curve: (r) => r >= 1 ? 1 : e2(r) + n * r * Math.pow(1 - r, i), k: n };
}
function qe(e2, t) {
  let n = Math.min(120, Math.max(32, Math.round(t / 8))), i = [];
  for (let r = 0; r < n; r += 1) {
    let s = r / (n - 1), o = r === n - 1 ? 1 : e2(s);
    i.push(`${Math.round(o * 1e4) / 1e4}`);
  }
  return `linear(${i.join(", ")})`;
}
function Zt(e2, t, n, i, r, s, o, a) {
  let u = (m, d, h, M, x) => {
    let T = e2.animate([{ [t]: `${m}px` }, { [t]: `${d}px` }], { duration: s, easing: h, fill: "both" });
    return x !== void 0 && (T.currentTime = x), { anim: T, from: m, to: d, easing: h, curve: M, startedAt: ee() - (x ?? 0) };
  };
  if (r && r.elapsed !== null && Math.abs(r.to - i) < je) return u(r.from, r.to, r.easing, r.curve, r.elapsed);
  let c = i - n, f = o, l = a;
  if (a && Math.abs(c) > Ye) {
    let m = ze(a, (r?.velocity ?? 0) * s / c);
    m.k > 0 && (l = m.curve, f = qe(m.curve, s));
  }
  return u(n, i, f, l);
}
function te(e2, t) {
  let n = e2.anim.currentTime === null, i = ee() - e2.startedAt, s = n || !Number.isFinite(i) || i >= t || i < 0 ? null : i;
  return { from: e2.from, to: e2.to, easing: e2.easing, curve: e2.curve, elapsed: s, velocity: s === null || !e2.curve ? 0 : (e2.to - e2.from) * Mt(e2.curve, s / t) / t };
}
var D = /* @__PURE__ */ new WeakMap();
function Je(e2) {
  return D.get(e2)?.snapshot();
}
function ut(e2) {
  e2.style.width = "", e2.style.height = "", e2.style.transitionProperty = "";
}
function ne(e2) {
  let t = D.get(e2);
  t && (D.delete(e2), t.stop(), t.onCancel?.());
}
function re(e2) {
  let t = D.get(e2);
  t && (D.delete(e2), t.stop()), ut(e2);
}
function ie(e2, t, n, i, r, s, o) {
  let a = Je(e2);
  if (ne(e2), t === 0 || n === 0) {
    ut(e2), o?.();
    return;
  }
  e2.style.transitionProperty = "none", e2.style.width = "", e2.style.height = "", e2.offsetWidth;
  let { width: u, height: c } = et(e2), f = Vt(r), l = Zt(e2, "width", t, u, a?.width, i, r, f), m = Zt(e2, "height", n, c, a?.height, i, r, f), d = () => {
    l.anim.cancel(), m.anim.cancel();
  };
  l.anim.onfinish = () => {
    D.delete(e2), d(), ut(e2), s?.();
  }, D.set(e2, { stop: d, onCancel: o, snapshot: () => ({ width: te(l, i), height: te(m, i) }) });
}
function se(e2, t, n, i, r, s) {
  ne(e2), e2.style.transitionProperty = "none", e2.style.width = `${t}px`, e2.style.height = `${n}px`;
  let o = setTimeout(() => {
    D.delete(e2), ut(e2), r?.();
  }, i), a = (u) => ({ from: u, to: u, easing: "linear", curve: null, elapsed: null, velocity: 0 });
  D.set(e2, { stop: () => clearTimeout(o), onCancel: s, snapshot: () => ({ width: a(t), height: a(n) }) });
}
function ct(e2) {
  let t = Array.from(e2.children), n = {}, i = e2.getBoundingClientRect();
  return t.forEach((r, s) => {
    if (r.hasAttribute(H) || r.hasAttribute(P) || r.tagName === "BR") return;
    let o = r.getAttribute(w) || `child-${s}`, a = r.getBoundingClientRect(), { tx: u, ty: c } = X(r);
    n[o] = { x: a.left - i.left - u, y: a.top - i.top - c };
  }), n;
}
function Tt(e2, t, n) {
  let i = e2[n], r = t[n];
  return !i || !r ? { dx: 0, dy: 0 } : { dx: i.x - r.x, dy: i.y - r.y };
}
function Et(e2, t, n, i = "backward-first") {
  let [r, s] = i === "backward-first" ? ["backward", "forward"] : ["forward", "backward"], o = (a) => {
    if (a === "backward") {
      for (let u = e2 - 1; u >= 0; u--) if (n.has(t[u])) return t[u];
    } else for (let u = e2 + 1; u < t.length; u++) if (n.has(t[u])) return t[u];
    return null;
  };
  return o(r) ?? o(s);
}
function oe(e2, t, n, i) {
  let r = new Set(n.filter((o, a) => i.has(o) && !t.has(e2[a]))), s = /* @__PURE__ */ new Map();
  for (let o = 0; o < e2.length; o++) {
    let a = e2[o];
    t.has(a) && s.set(a, Et(o, n, r, "forward-first"));
  }
  return s;
}
function ae(e2, t) {
  let { dx: n, dy: i, duration: r, ease: s, scale: o } = t;
  e2.animate({ transform: o ? `translate(${n}px, ${i}px) scale(0.95)` : `translate(${n}px, ${i}px)`, offset: 1 }, { duration: r, easing: s, fill: "both" });
  let a = e2.animate({ opacity: 0, offset: 1 }, { duration: lt(r, 0.25), easing: "linear", fill: "both" });
  a.onfinish = () => e2.remove();
}
function ue(e2, t) {
  let { deltaX: n, deltaY: i, isNew: r, duration: s, ease: o } = t, a = j(e2), u = n + a.tx, c = i + a.ty, f = r && a.opacity >= 1 ? 0 : a.opacity;
  e2.animate([{ transform: `translate(${u}px, ${c}px) scale(${r ? 0.95 : 1})` }, { transform: "none" }], { duration: s, easing: o, fill: "both" }), f < 1 && e2.animate([{ opacity: f }, { opacity: 1 }], { duration: lt(s, r ? 0.5 : 0.25), delay: r ? lt(s, 0.25) : 0, easing: "linear", fill: "both" });
}
function Qe(e2, t) {
  let n = 0, i = 0;
  for (let r = e2; r && r !== t; r = r.offsetParent) n += r.offsetLeft, i += r.offsetTop;
  return { x: n, y: i };
}
function At(e2, t) {
  let n = document.createElement(e2);
  return n.setAttribute(Q, ""), n.setAttribute(w, t), n.setAttribute("aria-hidden", "true"), n;
}
function le(e2, t) {
  let n = /* @__PURE__ */ new Map();
  for (let i of t) {
    if (i.tagName === "BR") continue;
    let { x: r, y: s } = Qe(i, e2), { tx: o, ty: a } = X(i), { width: u, height: c } = et(i), f = parseFloat(getComputedStyle(i).opacity);
    i.getAnimations().forEach((l) => l.cancel()), n.set(i, { left: r + o, top: s + a, width: u, height: c, opacity: f });
  }
  for (let i = t.length - 1; i >= 0; i--) t[i].tagName === "BR" && (t[i].remove(), t.splice(i, 1));
  t.forEach((i) => {
    let r = n.get(i);
    i.setAttribute(H, ""), i.style.position = "absolute", i.style.pointerEvents = "none", i.style.left = `${r.left}px`, i.style.top = `${r.top}px`, i.style.width = `${r.width}px`, i.style.height = `${r.height}px`, i.style.opacity = String(r.opacity);
  });
}
function ce(e2, t) {
  if (t.size === 0) return;
  let n = Array.from(e2.children), i = /* @__PURE__ */ new Set();
  for (let r of n) {
    if (r.hasAttribute(H)) continue;
    let s = r.getAttribute(w);
    if (!s || i.has(s)) continue;
    let o = t.get(s);
    if (o) {
      i.add(s);
      for (let a of o) {
        let u = At("span", a.id);
        wt(u, a), r.before(u);
      }
      r.remove();
    }
  }
}
function wt(e2, t) {
  if (!t.kind) {
    e2.removeAttribute(V), e2.removeAttribute(F), e2.textContent = t.string;
    return;
  }
  e2.setAttribute(V, t.kind), e2.setAttribute(F, "");
  let n = e2.firstElementChild;
  n || (e2.textContent = "", n = document.createElement("span"), e2.appendChild(n)), n.textContent = t.string;
}
function vt(e2) {
  return e2.hasAttribute(F) ? e2.firstElementChild ?? e2 : e2;
}
function me(e2, t, n, i) {
  let r = /* @__PURE__ */ new Map();
  t.forEach((s) => {
    let o = s.getAttribute(w);
    n.has(o) && !s.hasAttribute(H) && (r.set(o, s), s.remove());
  }), Array.from(e2.childNodes).forEach((s) => {
    s.nodeType === Node.TEXT_NODE && s.remove();
  }), i.forEach((s) => {
    let o = r.get(s.id);
    if (o && r.delete(s.id), s.string === `
`) {
      o && o.tagName === "BR" ? e2.appendChild(o) : e2.appendChild(At("br", s.id));
      return;
    }
    if (o && o.tagName !== "BR") o.style.transformOrigin = "", wt(o, s), e2.appendChild(o);
    else {
      let a = At("span", s.id);
      wt(a, s), e2.appendChild(a);
    }
  });
}
var Ve = 0.45;
var Ze = 0.25;
function pe(e2, t) {
  let { dx: n, dy: i, slideDistance: r, duration: s, ease: o } = t, a = vt(e2);
  e2.animate({ transform: `translate(${n}px, ${i}px)`, offset: 1 }, { duration: s, easing: o, fill: "both" }), a.animate({ transform: `translate(0px, ${r}px)`, offset: 1 }, { duration: s, easing: o, fill: "both" });
  let u = a.animate({ opacity: 0, offset: 1 }, { duration: s * Ve, easing: "linear", fill: "both" });
  u.onfinish = () => e2.remove();
}
function fe(e2, t) {
  let { deltaX: n, deltaY: i, slideDistance: r, kind: s, duration: o, ease: a } = t;
  Rt(e2, { deltaX: n, deltaY: i, duration: o, ease: a });
  let u = vt(e2), c = j(u), f = s === "digit" ? -r : r;
  u.animate({ transform: `translate(0px, ${c.ty + f}px)`, offset: 0 }, { duration: o, easing: a, fill: "both" });
  let l = c.opacity >= 1 ? 0 : c.opacity;
  l < 1 && u.animate([{ opacity: l }, { opacity: 1 }], { duration: o * Ze, easing: "linear", fill: "both" });
}
function Rt(e2, t) {
  let { deltaX: n, deltaY: i, duration: r, ease: s } = t, { tx: o, ty: a } = X(e2);
  e2.getAnimations().forEach((f) => f.cancel());
  let u = n + o, c = i + a;
  u === 0 && c === 0 || e2.animate({ transform: `translate(${u}px, ${c}px)`, offset: 0 }, { duration: r, easing: s, fill: "both" });
}
var tn = 6;
var de = 0.8;
var en = 0.45;
var nn = 0.35;
function he(e2) {
  let t = e2.map((u) => u.getBoundingClientRect()), n = Math.min(...t.map((u) => u.left)), i = Math.max(...t.map((u) => u.right)), r = Math.min(...t.map((u) => u.top)), s = Math.max(...t.map((u) => u.bottom)), o = (n + i) / 2, a = (r + s) / 2;
  return t.map((u) => `${o - u.left}px ${a - u.top}px`);
}
function ge(e2, t) {
  let { duration: n, ease: i } = t, r = he(e2);
  e2.forEach((s, o) => {
    s.getAnimations().forEach((u) => u.cancel()), s.style.transformOrigin = r[o], s.animate({ transform: `scale(${de})`, offset: 1 }, { duration: n, easing: i, fill: "both" });
    let a = s.animate({ opacity: 0, offset: 1 }, { duration: n * en, easing: "linear", fill: "both" });
    a.onfinish = () => s.remove();
  });
}
function be(e2, t) {
  let { duration: n, ease: i } = t, r = he(e2);
  e2.forEach((s, o) => {
    let a = j(s);
    s.style.transformOrigin = r[o], s.animate({ transform: `scale(${de})`, offset: 0 }, { duration: n, easing: i, fill: "both" });
    let u = a.opacity >= 1 ? 0 : a.opacity;
    s.animate([{ opacity: u }, { opacity: 1 }], { duration: n * nn, easing: "linear", fill: "both" });
  });
}
function It(e2, t) {
  let n = [], i = [], r = () => {
    i.length >= tn && n.push(i), i = [];
  };
  for (let s of e2) t.has(s) ? i.push(s) : r();
  return r(), n;
}
var rn = "\0#";
function xe(e2, t) {
  if (e2.segments.length !== 1 || e2.word.length <= 1) return e2.segments;
  let n = e2.segments[0], i = e2.word.split("").map((r, s) => ({ id: `${n.id}:${s}`, string: r }));
  return t.set(n.id, i), i;
}
function sn(e2) {
  return e2.map((t) => ({ ...t, kind: t.kind ?? at(t.string) }));
}
function on(e2, t) {
  if (e2.length === 0 || t.length === 0) return 0;
  let [n] = G(e2.split(""), t.split(""));
  return n.length / Math.max(e2.length, t.length);
}
function ye(e2, t) {
  let n = [], i = 0;
  for (let r = 0; r < e2; r++) n.push(i), t.has(r) && i++;
  return n;
}
var an = 0.4;
function un(e2, t) {
  return (q(e2) || q(t)) && gt(e2) === gt(t) ? 1 : on(e2, t);
}
var ln = 2500;
var cn = 1e6;
function Lt(e2, t, n, i = {}) {
  if (i.numbers === false && /\p{Script=Han}/u.test(t)) {
    const segments = K(t, n, false);
    const [from, to] = G(e2.map((s2) => s2.string), segments.map((s2) => s2.string));
    const matches = new Map(to.map((index, k2) => [index, e2[from[k2]]]));
    const ids = yt();
    for (const segment of e2) ids.reserve(segment.id);
    return { segments: segments.map((segment, index) => ({ ...segment, id: matches.get(index)?.id ?? ids.take(segment.id) })), splits: /* @__PURE__ */ new Map() };
  }
  let r = t.includes(" "), s = t.includes(`
`), o = zt(e2), a = i.numbers !== false, u = (p) => a && J(p), c = (p) => u(p) ? rn : p, f = a && (q(t) || o.some((p) => q(p.word)));
  if (o.length <= 1 && !r && !s && !f) return { segments: K(t, n, a), splits: /* @__PURE__ */ new Map() };
  let l = [], m = [], d = t.split(/( |\n)/), h = [];
  for (let p of d) p === " " || p === `
` ? h.push(p) : p.length > 0 && (m.push(h), l.push(p), h = []);
  let M = h, x = o.map((p) => p.word);
  if (x.length * l.length > cn) return { segments: K(t, n, a), splits: /* @__PURE__ */ new Map() };
  let [T, L] = G(x.map(c), l.map(c)), E = new Set(T), N = new Set(L), g = /* @__PURE__ */ new Map();
  for (let p = 0; p < L.length; p++) g.set(L[p], T[p]);
  let v = x.map((p, b) => b).filter((p) => !E.has(p)), R = l.map((p, b) => b).filter((p) => !N.has(p)), O = /* @__PURE__ */ new Set();
  for (let p of R) for (let b of v) if (!O.has(b) && c(l[p]) === c(x[b])) {
    g.set(p, b), O.add(b);
    break;
  }
  O.size > 0 && (v = v.filter((p) => !O.has(p)), R = R.filter((p) => !g.has(p)));
  let A = /* @__PURE__ */ new Map(), _ = /* @__PURE__ */ new Set(), B = ye(x.length, E), rt = ye(l.length, N);
  if (v.length * R.length <= ln) for (let p of R) {
    let b = -1, S = an;
    for (let y of v) {
      if (_.has(y) || B[y] !== rt[p]) continue;
      let it = un(x[y], l[p]);
      it > S && (S = it, b = y);
    }
    b >= 0 && (A.set(p, b), _.add(b));
  }
  let pt = l.map((p, b) => {
    let S = g.get(b), y = S ?? A.get(b);
    return y === void 0 ? { mode: "fresh" } : u(p) ? { mode: "number", oi: y } : S !== void 0 ? { mode: "reuse", oi: y } : { mode: "morph", oi: y };
  }), kt = pt.filter((p) => p.mode === "number").length === 1 ? i.cursorIndex : void 0, Ae = xt(n), W = yt();
  for (let p of pt) {
    if (p.mode === "fresh") continue;
    let b = o[p.oi];
    if (p.mode !== "reuse" && b.segments.length === 1) {
      let S = b.segments[0];
      for (let y = 0; y < b.word.length; y++) W.reserve(`${S.id}:${y}`);
    } else for (let S of b.segments) W.reserve(S.id);
  }
  let $ = [], ft = /* @__PURE__ */ new Map(), z = 0;
  function Ht(p) {
    for (let b of p) b === `
` ? $.push({ id: W.take(`newline-${z}`), string: `
` }) : $.push({ id: W.take(`space-${z}`), string: "\xA0" }), z++;
  }
  for (let p = 0; p < l.length; p++) {
    Ht(m[p] ?? (p > 0 ? [" "] : []));
    let b = pt[p], S = l[p];
    if (b.mode === "reuse") for (let y of o[b.oi].segments) $.push(y);
    else if (b.mode === "number") {
      let y = o[b.oi];
      $.push(...U(S, sn(xe(y, ft)), kt === void 0 ? void 0 : kt - z, Ae));
    } else if (b.mode === "morph") {
      let y = o[b.oi], it = y.word, we = xe(y, ft), ve = it.split(""), st = S.split(""), [Re, Ot] = G(ve, st), dt = /* @__PURE__ */ new Map();
      for (let I = 0; I < Ot.length; I++) {
        let ot = we[Re[I]];
        ot && dt.set(Ot[I], ot);
      }
      for (let I = 0; I < st.length; I++) if (dt.has(I)) {
        let ot = dt.get(I);
        $.push({ id: ot.id, string: st[I] });
      } else $.push({ id: W.take(`${S}~${I}`), string: st[I] });
    } else u(S) ? $.push(...U(S)) : $.push({ id: W.take(S), string: S });
    z += S.length;
  }
  return Ht(M), { segments: $, splits: ft };
}
var mn = `
[${Y}] {
  display: inline-block;
  position: relative;
  vertical-align: top;
  will-change: width, height;
  white-space: nowrap;
  text-align: inherit;
}

[${Q}]:not(br) {
  display: inline-block;
  position: relative;
  will-change: opacity, transform;
  transform: none;
  opacity: 1;
}

/*
 * The value once as plain text \u2014 every other child is an aria-hidden fragment.
 * Out of flow, because the engine measures every child of the root. Clipped
 * rather than display: none, which would take it out of the a11y tree as well.
 * user-select: none, or a copied selection pastes the value twice.
 */
[${P}] {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: pre;
  -webkit-user-select: none;
  user-select: none;
}

/*
 * A digit slides a whole line box to arrive, so it needs its own box to hide
 * behind. Not the root: that spans every line, so clipping there leaves a digit
 * on a middle line sliding over its neighbour in view. The transform sits on the
 * child, so the slide never touches the slot's rect and the FLIP pass stays
 * oblivious. clip-path, not overflow \u2014 an inline-block whose overflow is
 * anything but visible has its baseline synthesized to the bottom margin edge
 * (CSS 2.1 \xA710.8.1), and engines disagree on whether overflow: clip counts.
 * The inline axis stays open so glyph overhang is not shaved.
 */
[${F}] {
  clip-path: inset(0 -100vw);
}

[${F}] > span {
  display: inline-block;
  will-change: opacity, transform;
}

/*
 * Softens the clip above into a gradient, positionally rather than on a timer, so
 * it stays in step with the slide at any duration. The band (--torph-fade, 0 for a
 * hard edge) must eat into the box: the clip trims at the border box, so a ramp
 * reaching past it sits in territory already removed and is never seen. no-clip
 * plus repeat-x is what carries the profile across glyph overhang.
 */
@supports (mask-clip: no-clip) or (-webkit-mask-clip: no-clip) {
  [${F}] {
    --torph-mask: linear-gradient(
      to bottom,
      transparent,
      #000 var(--torph-fade, 0.15em),
      #000 calc(100% - var(--torph-fade, 0.15em)),
      transparent
    );
    -webkit-mask-image: var(--torph-mask);
    mask-image: var(--torph-mask);
    -webkit-mask-repeat: repeat-x;
    mask-repeat: repeat-x;
    -webkit-mask-clip: no-clip;
    mask-clip: no-clip;
  }
}

[${Y}][${Z}] {
  outline: 2px solid magenta;
  [${Q}] {
    outline: 2px solid cyan;
    outline-offset: -4px;
  }
}`;
var C = null;
var Nt = 0;
function Se() {
  Nt++, !C && (C = document.createElement("style"), C.dataset.torph = "true", C.textContent = mn, document.head.appendChild(C));
}
function Me() {
  Nt--, !(Nt > 0 || !C) && (C.remove(), C = null);
}
function Te() {
  if (typeof window > "u") return { prefersReducedMotion: false, destroy: () => {
  } };
  let e2 = window.matchMedia("(prefers-reduced-motion: reduce)"), t = { prefersReducedMotion: e2.matches, destroy: i };
  function n(r) {
    t.prefersReducedMotion = r.matches;
  }
  function i() {
    e2.removeEventListener("change", n);
  }
  return e2.addEventListener("change", n), t;
}
var mt = class e {
  instance = null;
  lastText = "";
  lastCursorIndex;
  configKey = "";
  attach(t, n) {
    this.instance?.destroy(), this.instance = new nt({ element: t, ...n }), this.configKey = e.serializeConfig(n), this.lastText !== "" && this.instance.update(this.lastText, this.lastCursorIndex);
  }
  update(t, n) {
    this.lastText = t, this.lastCursorIndex = n, this.instance?.update(t, n);
  }
  needsRecreate(t) {
    return e.serializeConfig(t) !== this.configKey;
  }
  destroy() {
    this.instance?.destroy(), this.instance = null;
  }
  static serializeConfig(t) {
    return JSON.stringify({ ease: t.ease, duration: t.duration, locale: t.locale, scale: t.scale, numbers: t.numbers, decimals: t.decimals, debug: t.debug, disabled: t.disabled, respectReducedMotion: t.respectReducedMotion });
  }
};
var Ee = { ..._t, debug: false, scale: true, numbers: true };
var nt = class {
  element;
  options = {};
  data;
  currentMeasures = {};
  prevMeasures = {};
  previousSegments = [];
  isInitialRender = true;
  reducedMotion = null;
  srNode = null;
  hasSetup = false;
  constructor(t) {
    let n = Object.fromEntries(Object.entries(t).filter(([, a]) => a !== void 0)), { ease: i, ...r } = { ...Ee, ...n }, { ease: s, duration: o } = Ft(i, r.duration);
    this.options = { ...r, ease: s, duration: o }, this.element = t.element, this.options.respectReducedMotion && (this.reducedMotion = Te()), this.data = "", this.isDisabled() || this.setup();
  }
  setup() {
    this.hasSetup || (this.hasSetup = true, this.element.setAttribute(Y, ""), this.options.debug && this.element.setAttribute(Z, ""), Se());
  }
  destroy() {
    this.reducedMotion?.destroy(), re(this.element), this.element.getAnimations().forEach((t) => t.cancel()), this.srNode?.remove(), this.srNode = null, this.element.removeAttribute(Y), this.element.removeAttribute(Z), this.hasSetup && (this.hasSetup = false, Me());
  }
  isDisabled() {
    return !!(this.options.disabled || this.reducedMotion?.prefersReducedMotion);
  }
  update(t, n) {
    let i = typeof t == "number" ? t.toLocaleString(this.options.locale, { minimumFractionDigits: this.options.decimals, maximumFractionDigits: this.options.decimals }) : t;
    if (i !== this.data) {
      if (this.data = i, this.isDisabled()) {
        typeof i == "string" && (this.srNode = null, this.element.textContent = i, this.previousSegments = [], this.isInitialRender = true);
        return;
      }
      if (this.setup(), this.data instanceof HTMLElement) throw new Error("HTMLElement not yet supported");
      this.options.onAnimationStart && !this.isInitialRender && this.options.onAnimationStart(), this.createTextGroup(this.data, this.element, n);
    }
  }
  createTextGroup(t, n, i) {
    let { width: r, height: s } = et(n), o = this.options.numbers !== false;
    this.syncAccessibleText(t);
    let a, u;
    if (this.previousSegments.length > 0) {
      let g = Lt(this.previousSegments, t, this.options.locale, { numbers: o, cursorIndex: i });
      a = g.segments, u = g.splits;
    } else a = K(t, this.options.locale, o), u = /* @__PURE__ */ new Map();
    let c = a.length === 0;
    c && (a = [{ id: tt, string: "\u200B" }]), ce(n, u), this.prevMeasures = ct(this.element);
    let f = Array.from(n.children).filter((g) => !g.hasAttribute(P)), l = new Set(a.map((g) => g.id)), m = f.filter((g) => !l.has(g.getAttribute(w)) && !g.hasAttribute(H)), d = new Set(m), h = f.map((g) => g.getAttribute(w)), M = oe(f, d, h, l);
    le(n, m), me(n, f, l, a), this.currentMeasures = ct(this.element);
    let x = a.reduce((g, v) => v.string === `
` ? g + 1 : g, 1), T = (n.offsetHeight || 20 * x) / x;
    n.style.width = `${r}px`, n.offsetWidth;
    let L = ct(this.element);
    n.style.width = "", this.updateStyles(a, L, T);
    let E = this.isInitialRender || !this.options.scale ? [] : It(f, new Set(m)), N = new Set(E.flat());
    for (let g of E) ge(g, { duration: this.options.duration, ease: this.options.ease });
    if (m.forEach((g) => {
      if (this.isInitialRender || g.getAttribute(w) === tt) {
        g.remove();
        return;
      }
      if (N.has(g)) return;
      let v = M.get(g), { dx: R, dy: O } = v ? Tt(this.currentMeasures, this.prevMeasures, v) : { dx: 0, dy: 0 };
      g.hasAttribute(V) ? pe(g, { dx: R, dy: O, slideDistance: T, duration: this.options.duration, ease: this.options.ease }) : ae(g, { dx: R, dy: O, duration: this.options.duration, ease: this.options.ease, scale: this.options.scale });
    }), this.previousSegments = a, this.isInitialRender) {
      this.isInitialRender = false, n.style.width = "", n.style.height = "";
      return;
    }
    c ? se(n, r, s, this.options.duration, this.options.onAnimationComplete, this.options.onAnimationCancel) : ie(n, r, s, this.options.duration, this.options.ease, this.options.onAnimationComplete, this.options.onAnimationCancel);
  }
  updateStyles(t, n, i) {
    if (this.isInitialRender) return;
    let r = Array.from(this.element.children).filter((l) => !l.hasAttribute(P)), s = t.map((l) => l.id), o = new Map(t.map((l) => [l.id, l.kind])), a = r.filter((l) => !l.hasAttribute(H) && l.tagName !== "BR" && l.getAttribute(w) !== tt), u = new Set(a.filter((l) => !this.prevMeasures[l.getAttribute(w)])), c = /* @__PURE__ */ new Set();
    for (let l of this.options.scale ? It(a, u) : []) l.forEach((m) => c.add(m)), be(l, { duration: this.options.duration, ease: this.options.ease });
    let f = new Set(s.filter((l) => this.prevMeasures[l]));
    r.forEach((l, m) => {
      if (l.hasAttribute(H) || l.tagName === "BR" || c.has(l)) return;
      let d = l.getAttribute(w) || `child-${m}`;
      if (d === tt) return;
      let h = !this.prevMeasures[d], M = h ? Et(t.findIndex((E) => E.id === d), s, f) : d, { dx: x, dy: T } = M ? Tt(this.prevMeasures, n, M) : { dx: 0, dy: 0 }, L = o.get(d);
      L && h ? fe(l, { deltaX: x, deltaY: T, slideDistance: i, kind: L, duration: this.options.duration, ease: this.options.ease }) : L ? Rt(l, { deltaX: x, deltaY: T, duration: this.options.duration, ease: this.options.ease }) : ue(l, { deltaX: x, deltaY: T, isNew: h, duration: this.options.duration, ease: this.options.ease });
    });
  }
  syncAccessibleText(t) {
    if (!this.srNode || this.srNode.parentNode !== this.element) {
      let n = document.createElement("span");
      n.setAttribute(P, ""), this.element.prepend(n), this.srNode = n;
    }
    this.srNode.textContent = t;
  }
};
export {
  Ee as DEFAULT_TEXT_MORPH_OPTIONS,
  mt as MorphController,
  SPRING_PRESETS,
  nt as TextMorph,
  canonicalD,
  createMorph,
  Lt as diffSegments,
  U as segmentNumber,
  K as segmentText
};
