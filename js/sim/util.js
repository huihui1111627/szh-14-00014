// 通用数学与几何工具（二维平面，SI 单位：米、秒、弧度、牛顿）

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function normAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// 可复现的伪随机数（线性同余），用于确定性的地形起伏
export function makeRng(seed = 1234567) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const unit = (a) => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};

// 点到线段（a->b）的最近点与沿线段参数 t（0..1 夹住）
export function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  let t = l2 > 0 ? dot(sub(p, a), ab) / l2 : 0;
  t = clamp(t, 0, 1);
  return { point: add(a, mul(ab, t)), t };
}

// 点到折线的有符号横向偏差（左侧为正）、最近点与段号
export function crossTrack(p, polyline) {
  let best = { offset: Infinity, point: polyline[0], seg: 0, signed: 0 };
  for (let i = 0; i < polyline.length - 1; i++) {
    const { point, t } = closestOnSegment(p, polyline[i], polyline[i + 1]);
    const d = dist(p, point);
    if (d < best.offset) {
      const seg = unit(sub(polyline[i + 1], polyline[i]));
      const normal = { x: -seg.y, y: seg.x };
      best = {
        offset: d,
        point,
        seg: i,
        signed: dot(sub(p, point), normal),
        t,
      };
    }
  }
  return best;
}

// 两线段相交检测，返回参数 (t on ab, u on cd) 与交点
export function segmentIntersect(a, b, c, d) {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-12) return null;
  const ca = sub(c, a);
  const t = (ca.x * s.y - ca.y * s.x) / denom;
  const u = (ca.x * r.y - ca.y * r.x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: add(a, mul(r, t)) };
}
