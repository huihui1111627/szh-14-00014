// 策略对比：可在任意节点暂停、分叉出并行策略，共享相同（冻结的）海况快照继续推演。
import { Simulation } from './simulation.js';

let nextId = 1;

export class ScenarioManager {
  constructor(env) {
    this.env = env;
    this.items = [];
    this.activeId = null;
  }

  create(name = '基线策略', sim = new Simulation(this.env)) {
    const item = {
      id: nextId++,
      name,
      sim,
      paused: false,
      createdAt: sim.time,
      color: ['#38bdf8', '#fbbf24', '#f472b6'][(this.items.length) % 3],
    };
    this.items.push(item);
    if (this.activeId === null) this.activeId = item.id;
    return item;
  }

  active() {
    return this.items.find((i) => i.id === this.activeId) || null;
  }

  setActive(id) {
    if (this.items.some((i) => i.id === id)) this.activeId = id;
  }

  // 从当前策略分叉（暂停点快照），新策略采用相同海况
  fork(name) {
    const src = this.active();
    const sim = Simulation.restore(this.env, src.sim.snapshot());
    const item = this.create(name || `策略 ${nextId}`, sim);
    item.paused = src.paused;
    return item;
  }

  remove(id) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx >= 0) {
      this.items.splice(idx, 1);
      if (this.activeId === id) {
        this.activeId = this.items[0] ? this.items[0].id : null;
      }
    }
  }

  // 统一推进所有未暂停策略，保证时间轴一致
  advance(dt) {
    for (const item of this.items) {
      if (!item.paused) item.sim.step(dt);
    }
  }

  stats() {
    return this.items.map((i) => ({
      id: i.id,
      name: i.name,
      paused: i.paused,
      color: i.color,
      time: i.sim.time,
      speed: i.sim.ship.speed,
      payout: i.sim.payoutRatio,
      tension: i.sim.tension,
      span: i.sim.span,
      laid: i.sim.laidLength,
      slack: i.sim.slack,
    }));
  }
}
