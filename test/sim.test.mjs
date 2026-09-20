import assert from 'node:assert/strict';
import { Environment } from '../js/sim/environment.js';
import { Simulation, LIMITS } from '../js/sim/simulation.js';
import { solveCable } from '../js/sim/cable.js';
import { predict, evaluateLive } from '../js/sim/hazards.js';
import { ScenarioManager } from '../js/sim/scenarios.js';
import { CommandQueue } from '../js/sim/commandQueue.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// 1. 无流悬链：与解析解 a=H/w 对比（relU 趋零时接近）
test('无拖曳悬链张力与解析解一致', () => {
  const depth = 300;
  const span = 2000;
  const r = solveCable({ depth, span, relU: 0.001, payout: 0, ds: 1 });
  // 解析悬链（自最低点）：d = a(cosh(span/a) - 1)，Ttop = w(a + d)
  let lo = 100, hi = 200000;
  for (let i = 0; i < 80; i++) {
    const a = (lo + hi) / 2;
    if (a * (Math.cosh(span / a) - 1) > depth) lo = a; else hi = a;
  }
  const a = (lo + hi) / 2;
  const expectedT = 22 * (a + depth);
  assert.ok(Math.abs(r.topTension - expectedT) / expectedT < 0.05,
    `T=${r.topTension} expected≈${expectedT}`);
  assert.ok(!r.slack);
});

// 2. 跨度越小张力越低；低于最小跨度判松弛
test('张力随跨度增大，过小判松弛', () => {
  const t1 = solveCable({ depth: 300, span: 500, relU: 1, payout: 1, ds: 2 }).topTension;
  const t2 = solveCable({ depth: 300, span: 900, relU: 1, payout: 1, ds: 2 }).topTension;
  assert.ok(t2 > t1);
  const slack = solveCable({ depth: 300, span: 10, relU: 1, payout: 1, ds: 2 });
  assert.ok(slack.slack);
});

// 3. 仿真步进稳定，量纲自洽
test('仿真连续步进稳定且放缆/已铺长度自洽', () => {
  const sim = new Simulation();
  for (let i = 0; i < 3600; i++) sim.step(0.5);
  assert.ok(isFinite(sim.tension) && sim.tension > 0);
  assert.ok(sim.span > 50 && sim.span < 4000);
  assert.ok(Math.abs(sim.paidOut - sim.laidLength) / sim.paidOut < 0.02);
  assert.ok(sim.laid.length > 10);
  assert.ok(sim.shipTrack.length > 10);
});

// 4. 自动驾驶沿走廊：船位基本贴合规划线
test('自动驾驶沿规划走廊航行', () => {
  const env = new Environment();
  const sim = new Simulation(env);
  for (let i = 0; i < 1800; i++) sim.step(1);
  const ct = env.route;
  let minD = Infinity;
  for (let i = 0; i < ct.length - 1; i++) {
    const a = ct[i], b = ct[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    let t = ((sim.ship.x - a.x) * abx + (sim.ship.y - a.y) * aby) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(sim.ship.x - (a.x + abx * t), sim.ship.y - (a.y + aby * t));
    minD = Math.min(minD, d);
  }
  assert.ok(minD < 60, `offline by ${minD}m`);
});

// 5. 急进策略必然在预测窗内触发张力或弯曲风险
test('前瞻预测能发现张力/弯曲风险', () => {
  const sim = new Simulation();
  sim.setSpeed(2.6);
  sim.setPayoutRatio(0.87);
  // 推到海山前
  sim.ship.x = 350; sim.ship.y = 300;
  sim.tdp.x = 350; sim.tdp.y = -300;
  sim.span = 700;
  sim.setAutopilot(false); sim.setTurn(0);
  for (let i = 0; i < 10; i++) sim.step(1);
  const p = predict(sim, 900, 5);
  const kinds = p.hazards.filter((h) => h.kind !== 'corridor').map((h) => h.kind);
  assert.ok(kinds.includes('tension') && kinds.includes('bend'),
    `got ${JSON.stringify(kinds)}`);
  for (const h of p.hazards) assert.ok(h.eta >= 0);
});

// 6. 管线交叉检测
test('穿越既有管线会产生交叉事件', () => {
  const env = new Environment();
  const sim = new Simulation(env);
  sim.setSpeed(2.5);
  for (let i = 0; i < 4000 && sim.events.length === 0; i++) sim.step(1);
  assert.ok(sim.events.some((e) => e.type === 'crossing'));
});

// 7. 策略分叉：暂停点一致、后续独立演化
test('策略分叉共享海况并独立演化', () => {
  const env = new Environment();
  const mgr = new ScenarioManager(env);
  mgr.create('A');
  for (let i = 0; i < 600; i++) mgr.advance(1);
  mgr.active().paused = true;
  const f = mgr.fork('B');
  assert.equal(f.sim.time, mgr.items[0].sim.time);
  f.sim.setSpeed(2.0);
  for (let i = 0; i < 60; i++) f.sim.step(1);
  assert.ok(Math.abs(f.sim.ship.speed - 2.0) < 0.3);
  assert.ok(Math.abs(f.sim.ship.speed - mgr.items[0].sim.ship.speed) > 0.5);
});

// 8. 离线指令队列：断线挂起，重连确认或放弃
test('断线指令必须显式确认或放弃', () => {
  const q = new CommandQueue();
  const state = { speed: 0.8 };
  const apply = (c) => { if (c.type === 'speed') state.speed = c.value; };
  q.submit({ type: 'speed', value: 2.0 }, apply, 0);
  assert.equal(state.speed, 2.0);
  q.disconnect(10);
  q.submit({ type: 'speed', value: 1.2 }, apply, 12);
  assert.equal(state.speed, 2.0);
  assert.equal(q.pendingCount(), 1);
  q.confirm(0, apply);
  assert.equal(state.speed, 1.2);
  q.disconnect(20);
  q.submit({ type: 'speed', value: 0.5 }, apply, 22);
  q.discardAll();
  assert.equal(state.speed, 1.2);
  assert.equal(q.pendingCount(), 0);
});

// 9. 快照/恢复一致性
test('快照恢复后状态一致', () => {
  const env = new Environment();
  const sim = new Simulation(env);
  for (let i = 0; i < 500; i++) sim.step(1);
  const restored = Simulation.restore(env, sim.snapshot());
  for (let i = 0; i < 100; i++) {
    sim.step(1);
    restored.step(1);
  }
  assert.ok(Math.abs(sim.ship.x - restored.ship.x) < 1e-6);
  assert.ok(Math.abs(sim.tension - restored.tension) < 1e-6);
});

console.log(`\n${passed} 项测试全部通过`);
