// 风险检测与前瞻预测：张力 / 弯曲 / 走廊 / 既有管线交叉。
// 走廊合规性以“当前 TDP 与船舶历史同里程位置”对比（TDP 天然滞后船尾上千米）。
import { Simulation } from './simulation.js';
import { dist } from './util.js';

export function evaluateLive(sim) {
  return [...(sim.lastHazards || [])];
}

// 以前瞻时长“幽灵推演”当前策略；不改动原仿真。返回未来风险列表与关键轨迹。
export function predict(sim, horizonSec = 600, dt = 5) {
  const ghost = Simulation.restore(sim.env, sim.snapshot());
  ghost.shipTrack = (sim.shipTrack || []).map((p) => ({ ...p }));
  ghost.events.length = 0; // 只统计推演期间的新事件
  const found = [];
  const seen = new Set();
  const samples = [];
  const n = Math.round(horizonSec / dt);
  for (let i = 0; i < n; i++) {
    ghost.step(dt);
    if (i % 4 === 0) {
      samples.push({
        time: ghost.time,
        ship: { ...ghost.ship },
        tdp: { ...ghost.tdp },
        tension: ghost.tension,
      });
    }
    const live = evaluateLive(ghost);
    for (const h of live) {
      const key = `${h.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({
          ...h,
          predicted: true,
          eta: ghost.time - sim.time,
        });
      }
    }
    for (const ev of ghost.events) {
      if (!seen.has('crossing')) {
        seen.add('crossing');
        found.push({
          kind: 'crossing',
          level: 'critical',
          message: ev.message,
          position: { ...ev.point },
          time: ev.time,
          predicted: true,
          eta: ev.time - sim.time,
        });
      }
    }
  }
  return { hazards: found, samples, end: ghost.snapshot() };
}
