// 缆线力学：准静态“顺流平面”边值积分。
// 自变量弧长 s（自海床接触点 TDP 向船尾），状态为张力分量 (H, V)。
// t̂=(cosθ,sinθ) 指向船尾；法向 n̂=(-sinθ,cosθ)。
// 外载荷：重力(0,-w)、法向阻力（随法向相对速度）、切向阻力（放缆速度参与）。
// 水平跨度 X 由船舶/TDP 动态决定，对 TDP 水平张力 H0 反解。

export const CABLE = {
  w: 22.0,          // 海水中单位长度重量 N/m
  rho: 1025,       // 海水密度 kg/m^3
  diameter: 0.055, // 缆径 m
  cdNormal: 1.2,   // 法向阻力系数
  cdTangent: 0.02, // 切向阻力系数
  minH: 200,       // TDP 处水平张力下限 N
};

const cdN = 0.5 * CABLE.rho * CABLE.cdNormal * CABLE.diameter;
const cdT = 0.5 * CABLE.rho * CABLE.cdTangent * CABLE.diameter;

function integrate(H0, depth, relU, payout, ds) {
  let H = H0;
  let V = 0;
  let x = 0;
  let z = -depth;
  let s = 0;
  let topTension = H0;
  let guard = 0;
  while (z < 0 && guard < 80000) {
    const deriv = (Hh, Vh) => {
      const T = Math.hypot(Hh, Vh) || 1;
      const c = Hh / T;
      const sT = Vh / T;
      const uNorm = relU * sT; // 相对流的法向分量
      const fN = cdN * uNorm * Math.abs(uNorm);
      const uTan = (payout - relU) * c; // 相对流的切向分量（含放缆）
      const fT = cdT * uTan * Math.abs(uTan);
      return { dH: fN * sT - fT * c, dV: CABLE.w - fN * c - fT * sT, ux: c, uz: sT };
    };
    const k1 = deriv(H, V);
    const k2 = deriv(H + k1.dH * ds * 0.5, V + k1.dV * ds * 0.5);
    H += k1.dH * ds;
    V += k1.dV * ds;
    if (H < CABLE.minH) H = CABLE.minH;
    x += 0.5 * (k1.ux + k2.ux) * ds;
    z += 0.5 * (k1.uz + k2.uz) * ds;
    s += ds;
    topTension = Math.hypot(H, V);
    guard++;
  }
  return { span: x, length: s, topTension, topH: H, topV: V };
}

export function solveCable(params) {
  const { depth, span, relU = 1, payout = 1, ds = 4 } = params;
  const minSpan = integrate(CABLE.minH, depth, relU, payout, ds).span;
  if (span <= minSpan) {
    return {
      span,
      minSpan,
      length: Math.hypot(span, depth),
      topTension: CABLE.w * depth + CABLE.minH,
      bottomH: CABLE.minH,
      slack: true,
    };
  }
  let lo = CABLE.minH;
  let hi = Math.max(4000, depth * CABLE.w * 20);
  // 确保上界跨度足够
  for (let i = 0; i < 10 && integrate(hi, depth, relU, payout, ds).span < span; i++) hi *= 2;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (integrate(mid, depth, relU, payout, ds).span >= span) hi = mid;
    else lo = mid;
  }
  const H0 = (lo + hi) / 2;
  const r = integrate(H0, depth, relU, payout, ds);
  return { span, minSpan, length: r.length, topTension: r.topTension, bottomH: H0, slack: false };
}

// 悬空段三维采样：t 从 TDP(0) 到船尾(1)，含侧流横向弯曲
export function cableShape(params) {
  const { depth, span, relU = 1, payout = 1, lateralRel = 0, n = 24 } = params;
  const sol = solveCable({ depth, span, relU, payout });
  const fLat = cdN * lateralRel * Math.abs(lateralRel);
  const delta = (fLat * sol.length * sol.length) / (16 * Math.max(sol.bottomH, CABLE.minH));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({
      t,
      x: span * t,
      z: -depth * (1 - t),
      lateral: delta * (3 * t * t - 2 * t * t * t),
    });
  }
  return { sol, points: pts };
}
