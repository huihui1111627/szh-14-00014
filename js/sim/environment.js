// 确定性海洋环境：规划走廊、海床地形（深度场）、海流场、既有管线
import { makeRng, dist, segmentIntersect, sub, unit } from './util.js';

// 坐标约定：x 向东(m)，y 向北(m)，z 向上为正；深度 depth = -z（海面为 0）。

const WAYPOINTS = [
  { x: -400, y: -4200 },
  { x: -400, y: -2400 },
  { x: 200, y: -1200 },
  { x: -150, y: -100 },
  { x: 300, y: 1050 },
  { x: 100, y: 2300 },
  { x: 650, y: 3500 },
];

const PIPELINES = [
  { id: 'P-A', a: { x: -950, y: 200 }, b: { x: 1150, y: 700 }, diameter: 0.35 },
  { id: 'P-B', a: { x: -1100, y: 1800 }, b: { x: 1000, y: 2250 }, diameter: 0.28 },
];

export class Environment {
  constructor(opts = {}) {
    this.route = WAYPOINTS;
    this.corridorHalfWidth = opts.corridorHalfWidth ?? 100;
    this.pipelines = PIPELINES;
    this.rng = makeRng(20260921);
    // 宽尺度平缓起伏（确定性叠加正弦波）
    this.swells = [];
    for (let i = 0; i < 5; i++) {
      this.swells.push({
        ax: -1500 + this.rng() * 3000,
        ay: -3000 + this.rng() * 7000,
        amp: 6 + this.rng() * 8,
        sx: 500 + this.rng() * 900,
        sy: 500 + this.rng() * 1200,
      });
    }
    // 海流：基底流 + 两个随时间缓慢旋转的涡
    this.currentBase = { vx: 0.06, vy: -0.10 };
  }

  // 海床深度（m，正值）：大陆坡基线 + 锥形海山 + 海沟 + 平缓起伏
  depth(x, y) {
    let d = 300 - 0.012 * (y + 2400) * 0.5; // 沿 y 缓慢抬升的陆坡
    d = Math.max(180, d);
    // 锥形海山（峰顶 80m 深，横向 150m 即可让开）
    const rmx = (x - 350) / 130;
    const rmy = (y - 1150) / 170;
    d -= 220 * Math.exp(-(rmx * rmx + rmy * rmy));
    // 海沟
    const rty = (y + 200) / 260;
    d += 55 * Math.exp(-(((x + 100) / 900) ** 2 + rty * rty));
    // 平缓起伏
    for (const s of this.swells) {
      d += s.amp * Math.exp(-(((x - s.ax) / s.sx) ** 2 + ((y - s.ay) / s.sy) ** 2));
    }
    return Math.max(40, Math.min(420, d));
  }

  // 深度梯度与沿水平方向的曲率半径（1/|d²z/ds²|，越大越平）
  bedGeometry(p, heading) {
    const e = 4;
    const d0 = this.depth(p.x, p.y);
    const fx = (this.depth(p.x + e, p.y) - this.depth(p.x - e, p.y)) / (2 * e);
    const fy = (this.depth(p.x, p.y + e) - this.depth(p.x, p.y - e)) / (2 * e);
    const t = { x: Math.cos(heading), y: Math.sin(heading) };
    const slope = fx * t.x + fy * t.y; // 深度沿前进方向的变化率
    const dxx = (this.depth(p.x + e, p.y) - 2 * d0 + this.depth(p.x - e, p.y)) / (e * e);
    const dyy = (this.depth(p.x, p.y + e) - 2 * d0 + this.depth(p.x, p.y - e)) / (e * e);
    const dxy =
      (this.depth(p.x + e, p.y + e) -
        this.depth(p.x + e, p.y - e) -
        this.depth(p.x - e, p.y + e) +
        this.depth(p.x - e, p.y - e)) /
      (4 * e * e);
    const second = dxx * t.x * t.x + 2 * dxy * t.x * t.y + dyy * t.y * t.y;
    const radius = Math.abs(second) > 1e-6 ? 1 / Math.abs(second) : Infinity;
    return { depth: d0, slope, radius };
  }

  // 海流速度矢量（m/s），随时间缓慢变化
  current(x, y, time) {
    const ph = time * 0.00008;
    const e1x = -0.05 * Math.exp(-(((x + 400) / 1400) ** 2 + ((y - 600) / 1600) ** 2)) *
      Math.cos(ph + y * 0.0012);
    const e1y = 0.09 * Math.exp(-(((x + 400) / 1400) ** 2 + ((y - 600) / 1600) ** 2)) *
      Math.sin(ph + x * 0.001);
    const e2x = 0.04 * Math.exp(-(((x - 500) / 1200) ** 2 + ((y - 2400) / 1400) ** 2)) *
      Math.cos(ph * 0.7 + 1.7 + x * 0.0015);
    const e2y = 0.05 * Math.exp(-(((x - 500) / 1200) ** 2 + ((y - 2400) / 1400) ** 2)) *
      Math.sin(ph * 0.7 + 1.7);
    return { vx: this.currentBase.vx + e1x + e2x, vy: this.currentBase.vy + e1y + e2y };
  }

  // 走廊多边形（左右边界），用于渲染与越界判定
  corridor() {
    const left = [];
    const right = [];
    for (let i = 0; i < this.route.length; i++) {
      const prev = this.route[Math.max(0, i - 1)];
      const next = this.route[Math.min(this.route.length - 1, i + 1)];
      const dir = unit(sub(next, prev));
      const n = { x: -dir.y, y: dir.x };
      const w = this.route[i];
      left.push({ x: w.x + n.x * this.corridorHalfWidth, y: w.y + n.y * this.corridorHalfWidth });
      right.push({ x: w.x - n.x * this.corridorHalfWidth, y: w.y - n.y * this.corridorHalfWidth });
    }
    return { left, right };
  }

  // 检测一段海床轨迹是否与既有管线交叉
  crossing(a, b) {
    for (const pipe of this.pipelines) {
      const hit = segmentIntersect(a, b, pipe.a, pipe.b);
      if (hit) {
        return {
          pipeline: pipe.id,
          point: hit.point,
          clearance: pipe.diameter / 2 + 0.1,
        };
      }
    }
    return null;
  }

  // 沿走廊采样深度剖面（用于剖面图背景）
  routeProfile(step = 60) {
    const out = [];
    for (let i = 0; i < this.route.length - 1; i++) {
      const a = this.route[i];
      const b = this.route[i + 1];
      const segLen = dist(a, b);
      const n = Math.max(1, Math.round(segLen / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        out.push({ ...p, depth: this.depth(p.x, p.y), s: out.length * step });
      }
    }
    const last = this.route[this.route.length - 1];
    out.push({ ...last, depth: this.depth(last.x, last.y), s: out.length * step });
    return out;
  }
}
