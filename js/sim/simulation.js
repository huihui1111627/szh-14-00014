// 作业仿真核心：船体运动 + TDP 落缆动力学 + 张力求解 + 已铺轨迹记录。
import { Environment } from './environment.js';
import { solveCable, cableShape, CABLE } from './cable.js';
import { clamp, normAngle, dist } from './util.js';

export const LIMITS = {
  tension: 45000,   // 最大允许张力 N
  bendRadius: 40,   // 最小允许弯曲半径 m
  corridor: 100,    // 走廊半宽 m（默认与环境一致）
};

export class Simulation {
  constructor(env = new Environment()) {
    this.env = env;
    this.reset();
  }

  reset() {
    this.time = 0;
    const start = this.env.route[1];
    this.ship = { x: start.x, y: start.y, heading: 0, speed: 0.8 };
    this.speedCmd = 0.8;
    this.turnCmd = 0;          // 期望转向速率 rad/s
    this.autopilot = true;     // 默认沿规划走廊自动航行
    this.manualBias = 0;       // 人工航向偏置（叠加在自动驾驶上）
    this.payoutRatio = 1.0;    // 放缆比例：放缆速度 / 船速
    this.paidOut = 0;
    this.laidLength = 0;
    // TDP 初始位于船尾后方（沿 -heading）
    const initDepth = this.env.depth(start.x, start.y);
    const rel = this._relFlow(start, 0);
    const init = solveCable({
      depth: initDepth,
      span: 600,
      relU: rel.along + this.ship.speed,
      payout: this.ship.speed * this.payoutRatio,
    });
    this.span = 600;
    this.tdp = {
      x: start.x - Math.sin(0) * init.span,
      y: start.y - Math.cos(0) * init.span,
      depth: initDepth,
      bendRadius: Infinity,
    };
    this.tension = init.topTension;
    this.bottomH = init.bottomH;
    this.slack = init.slack;
    this.laid = [{ x: this.tdp.x, y: this.tdp.y, depth: initDepth, bend: Infinity }];
    this.shipTrack = [{ x: this.ship.x, y: this.ship.y }];
    this.events = [];
    this.lastHazards = [];
    return this;
  }

  // 当前跨度轴（TDP -> 船尾）在平面内的方位
  axisHeading() {
    return Math.atan2(this.ship.x - this.tdp.x, this.ship.y - this.tdp.y);
  }

  // 指向下一个航路点的航向与横向偏差
  _guidance() {
    let best = { d: Infinity, wp: this.env.route[2], seg: 1,
      q: this.env.route[1], a: this.env.route[1], b: this.env.route[2] };
    for (let i = 0; i < this.env.route.length - 1; i++) {
      const a = this.env.route[i];
      const b = this.env.route[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const l2 = abx * abx + aby * aby;
      let t = l2 ? ((this.ship.x - a.x) * abx + (this.ship.y - a.y) * aby) / l2 : 0;
      t = clamp(t, 0, 1);
      const q = { x: a.x + abx * t, y: a.y + aby * t };
      const d = dist(this.ship, q);
      if (d < best.d) best = { d, wp: b, seg: i, q, a, b };
    }
    const targetHead = Math.atan2(best.wp.x - this.ship.x, best.wp.y - this.ship.y);
    // 有符号横向偏差（船在走廊右侧为正）
    const seg = { x: best.b.x - best.a.x, y: best.b.y - best.a.y };
    const sl = Math.hypot(seg.x, seg.y) || 1;
    const nx = seg.y / sl;
    const ny = -seg.x / sl;
    const lateral = (this.ship.x - best.q.x) * nx + (this.ship.y - best.q.y) * ny;
    return { targetHead, lateral };
  }

  _autopilotRate() {
    const { targetHead, lateral } = this._guidance();
    const headingError = normAngle(targetHead + this.manualBias - this.ship.heading);
    // 航向比例 + 横向纠偏
    const rate = 0.6 * headingError - 0.0015 * lateral;
    return clamp(rate, -0.06, 0.06);
  }

  _relFlow(p, time) {
    const head = Math.atan2(this.ship.x - p.x, this.ship.y - p.y);
    const cur = this.env.current(p.x, p.y, time);
    const along = cur.vx * Math.sin(head) + cur.vy * Math.cos(head);
    const lateral = cur.vx * Math.cos(head) - cur.vy * Math.sin(head);
    return { along, lateral, head, vector: cur };
  }

  // 控制输入（UI / 离线指令队列调用）
  setSpeed(v) {
    this.speedCmd = clamp(v, 0, 3.0);
  }
  setTurn(rate) {
    this.autopilot = false;
    this.turnCmd = clamp(rate, -0.08, 0.08); // rad/s，约 ±4.6°/s
  }
  nudgeHeading(delta) {
    this.autopilot = true;
    this.manualBias = clamp(this.manualBias + delta, -0.5, 0.5);
  }
  setAutopilot(on) {
    this.autopilot = on;
    if (on) this.manualBias = 0;
  }
  setPayoutRatio(r) {
    this.payoutRatio = clamp(r, 0.9, 1.12);
  }

  step(dt) {
    // 1) 船体：航速一阶趋近指令，转向积分
    const kV = dt / 6;
    this.ship.speed += (this.speedCmd - this.ship.speed) * Math.min(1, kV);
    if (this.autopilot) this.turnCmd = this._autopilotRate();
    this.ship.heading = normAngle(this.ship.heading + this.turnCmd * dt);
    this.ship.x += Math.sin(this.ship.heading) * this.ship.speed * dt;
    this.ship.y += Math.cos(this.ship.heading) * this.ship.speed * dt;

    const moved = dist(this.ship, this.shipTrack[this.shipTrack.length - 1]);
    if (moved > 10) this.shipTrack.push({ x: this.ship.x, y: this.ship.y });
    if (this.shipTrack.length > 12000) this.shipTrack.shift();

    // 2) 放缆与 TDP 推进
    const payoutSpeed = this.ship.speed * this.payoutRatio;
    this.paidOut += payoutSpeed * dt;

    const axisHead = this.axisHeading();
    const fwd = { x: Math.sin(axisHead), y: Math.cos(axisHead) };
    const shipVel = {
      x: Math.sin(this.ship.heading) * this.ship.speed,
      y: Math.cos(this.ship.heading) * this.ship.speed,
    };
    // 船尾沿跨度轴的推进分量
    const vAlong = shipVel.x * fwd.x + shipVel.y * fwd.y;
    const arcLaid = Math.max(0, payoutSpeed * dt);
    const horizontalAdvance = arcLaid * this.span / Math.hypot(this.span, this.tdp.depth);
    // 跨度变化率(m/s)：船尾沿轴推进 - TDP 水平推进速度
    const tdpRate = horizontalAdvance / dt;
    this.span += (vAlong - tdpRate) * dt;
    this.span = clamp(this.span, 60, 4000);

    // TDP 沿跨度轴向船移动；随后投影到真实海床
    const newTdp = {
      x: this.tdp.x + fwd.x * horizontalAdvance,
      y: this.tdp.y + fwd.y * horizontalAdvance,
    };
    const depth = this.env.depth(newTdp.x, newTdp.y);
    const bed = this.env.bedGeometry(newTdp, axisHead);
    const prevTdp = { ...this.tdp };
    this.tdp = { x: newTdp.x, y: newTdp.y, depth, bendRadius: bed.radius };

    // 3) 准静态缆线解
    const rel = this._relFlow(this.tdp, this.time);
    const relU = Math.max(0.02, this.ship.speed - rel.along);
    const sol = solveCable({
      depth,
      span: this.span,
      relU,
      payout: payoutSpeed,
    });
    this.tension = sol.topTension;
    this.bottomH = sol.bottomH;
    this.slack = sol.slack;
    this.laidLength += arcLaid;

    // 4) 记录海床轨迹并检测交叉
    if (dist(prevTdp, this.tdp) > 0.1) {
      const cross = this.env.crossing(prevTdp, this.tdp);
      this.laid.push({ x: this.tdp.x, y: this.tdp.y, depth, bend: bed.radius });
      if (this.laid.length > 12000) this.laid.shift();
      if (cross) {
        this.events.push({
          time: this.time,
          type: 'crossing',
          message: `与既有管线 ${cross.pipeline} 交叉`,
          point: cross.point,
        });
      }
    }

    // 5) 即时风险
    this.lastHazards = this._localHazards(bed, axisHead, rel);
    this.time += dt;
    return this;
  }

  _localHazards(bed, axisHead, rel) {
    const hazards = [];
    if (this.tension > LIMITS.tension) {
      hazards.push({
        kind: 'tension',
        level: this.tension > LIMITS.tension * 1.15 ? 'critical' : 'warn',
        message: `张力超限 ${(this.tension / 1000).toFixed(1)} kN`,
        position: { ...this.ship },
        time: this.time,
      });
    }
    if (bed.radius < LIMITS.bendRadius) {
      hazards.push({
        kind: 'bend',
        level: bed.radius < LIMITS.bendRadius * 0.7 ? 'critical' : 'warn',
        message: `弯曲半径 ${bed.radius.toFixed(0)} m 过小`,
        position: { ...this.tdp },
        time: this.time,
      });
    }
    // 走廊：以规划航线为基准的横向偏差（TDP 天然滞后船尾，但不应左右偏出走廊）
    const ct = this._corridorOffset(this.tdp);
    if (ct.offset > LIMITS.corridor) {
      hazards.push({
        kind: 'corridor',
        level: ct.offset > LIMITS.corridor * 1.5 ? 'critical' : 'warn',
        message: `落地点偏离走廊 ${ct.offset.toFixed(0)} m`,
        position: { ...this.tdp },
        time: this.time,
      });
    }
    return hazards;
  }

  _corridorOffset(p) {
    let best = { offset: Infinity, point: this.env.route[0] };
    for (let i = 0; i < this.env.route.length - 1; i++) {
      const a = this.env.route[i];
      const b = this.env.route[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const l2 = abx * abx + aby * aby;
      let t = l2 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0;
      t = clamp(t, 0, 1);
      const q = { x: a.x + abx * t, y: a.y + aby * t };
      const d = dist(p, q);
      if (d < best.offset) best = { offset: d, point: q };
    }
    return best;
  }

  // 悬空缆形状（世界坐标），供渲染与剖面使用
  suspendedShape() {
    const rel = this._relFlow(this.tdp, this.time);
    const head = this.axisHeading();
    const shape = cableShape({
      depth: this.tdp.depth,
      span: this.span,
      relU: Math.max(0.02, this.ship.speed - rel.along),
      payout: this.ship.speed * this.payoutRatio,
      lateralRel: rel.lateral,
      n: 24,
    });
    const fwd = { x: Math.sin(head), y: Math.cos(head) };
    const side = { x: fwd.y, y: -fwd.x };
    const world = shape.points.map((p) => ({
      x: this.tdp.x + fwd.x * p.x + side.x * p.lateral,
      y: this.tdp.y + fwd.y * p.x + side.y * p.lateral,
      z: p.z,
    }));
    return { world, sol: shape.sol, lateral: rel.lateral };
  }

  snapshot() {
    return {
      time: this.time,
      ship: { ...this.ship },
      speedCmd: this.speedCmd,
      turnCmd: this.turnCmd,
      autopilot: this.autopilot,
      manualBias: this.manualBias,
      payoutRatio: this.payoutRatio,
      paidOut: this.paidOut,
      laidLength: this.laidLength,
      span: this.span,
      tdp: { ...this.tdp },
      tension: this.tension,
      bottomH: this.bottomH,
      slack: this.slack,
      laid: this.laid.map((p) => ({ ...p })),
      shipTrack: this.shipTrack.map((p) => ({ ...p })),
      events: this.events.map((e) => ({ ...e })),
    };
  }

  static restore(env, snap) {
    const sim = new Simulation(env);
    Object.assign(sim, {
      time: snap.time,
      ship: { ...snap.ship },
      speedCmd: snap.speedCmd,
      turnCmd: snap.turnCmd,
      autopilot: snap.autopilot ?? true,
      manualBias: snap.manualBias ?? 0,
      payoutRatio: snap.payoutRatio,
      paidOut: snap.paidOut,
      laidLength: snap.laidLength,
      span: snap.span,
      tdp: { ...snap.tdp },
      tension: snap.tension,
      bottomH: snap.bottomH,
      slack: snap.slack,
      laid: snap.laid.map((p) => ({ ...p })),
      shipTrack: (snap.shipTrack || [{ x: snap.ship.x, y: snap.ship.y }]).map((p) => ({ ...p })),
      events: snap.events.map((e) => ({ ...e })),
      lastHazards: [],
    });
    return sim;
  }
}
