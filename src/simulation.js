export const DT = 0.25;
export const FORECAST_SECONDS = 300;
export const TENSION_LIMIT = 60000;
export const BEND_LIMIT = 8;
export const CORRIDOR_HALF_WIDTH = 70;

export const DEFAULTS = Object.freeze({
  speed: 1.55,
  turnRate: 0,
  payoutRatio: 1,
  timeScale: 8,
});

const CABLE_WEIGHT = 120;
const CABLE_DRAG = 170;

export const EXISTING_PIPELINE = Object.freeze([
  { x: -240, y: 20 },
  { x: 720, y: 404 },
]);

const SEAMOUNTS = [
  { x: 170, y: 410, amp: 26, sx: 120, sy: 80 },
  { x: 330, y: 760, amp: -19, sx: 150, sy: 110 },
  { x: -110, y: 620, amp: 13, sx: 95, sy: 145 },
  { x: 520, y: 1100, amp: 20, sx: 115, sy: 90 },
];

export function depthAt(x, y) {
  const trench = 12 * Math.sin(y / 310) + 7 * Math.cos((x - y) / 430);
  const relief = SEAMOUNTS.reduce((sum, hill) => {
    const dx = (x - hill.x) / hill.sx;
    const dy = (y - hill.y) / hill.sy;
    return sum + hill.amp * Math.exp(-0.5 * (dx * dx + dy * dy));
  }, 0);
  return Math.max(70, 150 - 0.018 * y + trench + relief);
}

export function terrainGradient(x, y) {
  const e = 4;
  return {
    dx: (depthAt(x + e, y) - depthAt(x - e, y)) / (2 * e),
    dy: (depthAt(x, y + e) - depthAt(x, y - e)) / (2 * e),
  };
}

export function terrainCurvature(x, y, heading) {
  const e = 6;
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  const d2 =
    (depthAt(x + e * fx, y + e * fy) -
      2 * depthAt(x, y) +
      depthAt(x - e * fx, y - e * fy)) /
    (e * e);
  return d2;
}

export function currentAt(x, y, t) {
  const phase = Math.sin(t / 210) + 0.45 * Math.sin(t / 73 + x / 900);
  return {
    u: 0.16 + 0.045 * phase + 0.018 * Math.sin(y / 500),
    v: 0.075 + 0.035 * Math.cos(t / 150 + y / 650),
  };
}

function asinh(value) {
  return Math.log(value + Math.sqrt(value * value + 1));
}

export function catenaryGeometry(distance, depth, bedSlope, currentSpeed = 0.18) {
  const d = Math.max(distance, 0.1);
  const beta = Math.max(-0.42, Math.min(0.42, bedSlope));
  const drop = depth - beta * d;

  if (!Number.isFinite(drop) || drop <= 0.02) {
    const length = Math.max(d, depth) * 1.02;
    return {
      distance: d,
      depth,
      bedSlope: beta,
      length,
      topTension: CABLE_WEIGHT * d,
      radius: 2000,
      slack: false,
    };
  }

  let low = 0.8;
  let high = 2400;
  for (let i = 0; i < 70; i += 1) {
    const a = (low + high) / 2;
    const uT = Math.sqrt(Math.max(0.0001, (drop / a) * (drop / a) + 2 * drop / a));
    const xAtT = a * (asinh(uT - beta) + asinh(beta));
    if (xAtT > d) high = a;
    else low = a;
  }

  const a = (low + high) / 2;
  const uT = Math.sqrt(Math.max(0.0001, (drop / a) * (drop / a) + 2 * drop / a));
  const length = a * (uT + beta);
  const horizontalTension = CABLE_WEIGHT * a;
  const flowTension = CABLE_DRAG * currentSpeed * length;
  const payoutDragTension = 8200 * Math.max(0, currentSpeed - 0.12);
  const topTension = horizontalTension + flowTension + payoutDragTension + 3000;
  const radius = Math.max(0.5, a / (1 + Math.abs(beta) * 3));

  return {
    distance: d,
    depth,
    bedSlope: beta,
    length,
    topTension,
    radius,
    slack: false,
  };
}

function solveNextLag(state, dt, payoutSpeed) {
  const excess = (payoutSpeed - state.speed) * dt;
  const slopeCompliance = 1 / (1 + Math.abs(state.bedSlope) * 2.2);
  const nextLag = Math.max(5, Math.min(800, state.lag + excess * slopeCompliance));
  return {
    lag: nextLag,
  };
}

function unit(heading) {
  return { x: Math.cos(heading), y: Math.sin(heading) };
}

function aftUnit(heading) {
  return { x: -Math.cos(heading), y: -Math.sin(heading) };
}

export function touchdownFromState(state, time = state.time, nominal = false) {
  const aft = aftUnit(state.heading);
  const point = {
    x: state.vessel.x + aft.x * state.lag,
    y: state.vessel.y + aft.y * state.lag,
  };

  if (nominal) return point;

  const lagTime = Math.min(240, Math.max(20, state.lag / Math.max(state.speed, 0.2)));
  const current = currentAt(point.x, point.y, time - lagTime);
  point.x += current.u * lagTime * 0.05;
  point.y += current.v * lagTime * 0.05;
  return point;
}

function crossTrack(position, heading) {
  return -position.x * Math.sin(heading) + position.y * Math.cos(heading);
}

function headingDifference(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function segmentIntersection(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) return null;
  const qpx = c.x - a.x;
  const qpy = c.y - a.y;
  const t = (qpx * sy - qpy * sx) / denominator;
  const u = (qpx * ry - qpy * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return {
    x: a.x + t * rx,
    y: a.y + t * ry,
    t,
    u,
  };
}

function checkCrossing(previous, current, heading, time) {
  const hit = segmentIntersection(
    previous,
    current,
    EXISTING_PIPELINE[0],
    EXISTING_PIPELINE[1],
  );
  if (!hit) return null;
  const pipelineHeading = Math.atan2(
    EXISTING_PIPELINE[1].y - EXISTING_PIPELINE[0].y,
    EXISTING_PIPELINE[1].x - EXISTING_PIPELINE[0].x,
  );
  const angle = Math.abs(headingDifference(heading, pipelineHeading));
  const crossingAngle = Math.min(angle, Math.PI - angle) * 180 / Math.PI;
  return {
    type: "crossing",
    severity: crossingAngle < 20 ? "high" : "info",
    time,
    position: hit,
    value: crossingAngle,
    message: `与既有管线交叉，交角 ${crossingAngle.toFixed(1)}°`,
    advice: crossingAngle < 20 ? "提前调整航向，使交角接近 30°–90°" : "交叉点已定位，保持监控并核实施工许可",
  };
}

function evaluateState(state, time) {
  const events = [];
  const position = state.tdp;
  const offset = crossTrack(position, state.heading);

  if (state.topTension >= TENSION_LIMIT) {
    events.push({
      type: "tension",
      severity: "high",
      time,
      position: { ...position },
      value: state.topTension,
      message: `顶部张力 ${(state.topTension / 1000).toFixed(1)} kN 超过 ${TENSION_LIMIT / 1000} kN`,
      advice: "降低航速或提高放缆比例，避免强行拉直悬空段",
    });
  }

  if (state.bendRadius <= BEND_LIMIT) {
    events.push({
      type: "bend",
      severity: "high",
      time,
      position: { ...position },
      value: state.bendRadius,
      message: `等效弯曲半径 ${state.bendRadius.toFixed(1)} m 小于 ${BEND_LIMIT} m`,
      advice: "降低放缆比例与航速，避开坡折或沟坎",
    });
  }

  if (Math.abs(offset) >= CORRIDOR_HALF_WIDTH) {
    events.push({
      type: "corridor",
      severity: Math.abs(offset) > CORRIDOR_HALF_WIDTH + 18 ? "high" : "medium",
      time,
      position: { ...position },
      value: offset,
      message: `触底点偏离许可走廊 ${offset.toFixed(0)} m`,
      advice: "减小转向速率并反向修正航向",
    });
  }

  return events;
}

export function createInitialState() {
  const heading = Math.PI / 2;
  const vessel = { x: 0, y: -80 };
  const lag = 250;
  const baseState = {
    vessel,
    heading,
    speed: DEFAULTS.speed,
    turnRate: DEFAULTS.turnRate,
    payoutRatio: DEFAULTS.payoutRatio,
    lag,
    time: 0,
    laidLength: 0,
    laid: [],
  };
  const tdp = touchdownFromState(baseState, 0, false);
  const gradient = terrainGradient(tdp.x, tdp.y);
  const forward = unit(heading);
  const bedSlope = gradient.dx * forward.x + gradient.dy * forward.y;
  const depth = depthAt(tdp.x, tdp.y);
  const current = currentAt(tdp.x, tdp.y, 0);
  const currentSpeed = Math.hypot(current.u, current.v);
  const geometry = catenaryGeometry(lag, depth, bedSlope, currentSpeed);
  const planRadius = 9999;
  const terrainK = Math.abs(terrainCurvature(tdp.x, tdp.y, heading));
  const bendRadius = 1 / (1 / geometry.radius + terrainK + 1 / planRadius);

  return {
    ...baseState,
    tdp,
    previousTdp: { ...tdp },
    depth,
    bedSlope,
    current,
    currentSpeed,
    suspendedLength: geometry.length,
    topTension: geometry.topTension,
    catenaryRadius: geometry.radius,
    bendRadius,
    payoutSpeed: DEFAULTS.speed * DEFAULTS.payoutRatio,
    events: [],
  };
}

export function stepSimulation(input, dt = DT, overrides = {}) {
  const state = structuredClone(input);
  const controls = {
    speed: overrides.speed ?? state.speed,
    turnRate: overrides.turnRate ?? state.turnRate,
    payoutRatio: overrides.payoutRatio ?? state.payoutRatio,
  };

  state.speed = controls.speed;
  state.turnRate = controls.turnRate;
  state.payoutRatio = controls.payoutRatio;

  const oldHeading = state.heading;
  const turnRadPerSecond = controls.turnRate * Math.PI / 180 / 60;
  state.heading += turnRadPerSecond * dt;
  const forward = unit(state.heading);
  state.vessel.x += forward.x * controls.speed * dt;
  state.vessel.y += forward.y * controls.speed * dt;

  state.payoutSpeed = controls.speed * controls.payoutRatio;
  const solved = solveNextLag(state, dt, state.payoutSpeed);
  state.lag = solved.lag;

  state.previousTdp = { ...state.tdp };
  state.tdp = touchdownFromState(state, state.time + dt, false);
  const gradient = terrainGradient(state.tdp.x, state.tdp.y);
  state.bedSlope = gradient.dx * forward.x + gradient.dy * forward.y;
  state.depth = depthAt(state.tdp.x, state.tdp.y);
  state.current = currentAt(state.tdp.x, state.tdp.y, state.time + dt);
  state.currentSpeed = Math.hypot(state.current.u, state.current.v);

  const geometry = catenaryGeometry(state.lag, state.depth, state.bedSlope, state.currentSpeed);
  state.suspendedLength = geometry.length;
  state.topTension = geometry.topTension;
  state.catenaryRadius = geometry.radius;

  const terrainK = Math.abs(terrainCurvature(state.tdp.x, state.tdp.y, state.heading));
  const planK = Math.abs(turnRadPerSecond) > 1e-9 ? Math.abs(turnRadPerSecond) / Math.max(controls.speed, 0.05) : 0;
  const payoutDeficit = Math.max(0, 0.86 - controls.payoutRatio);
  const localBendK = 4.7 * payoutDeficit * payoutDeficit;
  state.bendRadius = 1 / (1 / geometry.radius + terrainK + planK + localBendK);

  const laidDistance = Math.hypot(state.tdp.x - state.previousTdp.x, state.tdp.y - state.previousTdp.y);
  state.laidLength += laidDistance;
  const lastLaid = state.laid[state.laid.length - 1];
  if (!lastLaid || Math.hypot(state.tdp.x - lastLaid.x, state.tdp.y - lastLaid.y) >= 5) {
    state.laid.push({ x: state.tdp.x, y: state.tdp.y });
  }

  state.time += dt;
  const crossing = checkCrossing(state.previousTdp, state.tdp, state.heading, state.time);
  state.events = [...evaluateState(state, state.time)];
  if (crossing) state.events.unshift(crossing);

  state.headingDelta = state.heading - oldHeading;
  return state;
}

export function forecast(input, overrides = {}, seconds = FORECAST_SECONDS, step = 1) {
  let current = structuredClone(input);
  const vesselPath = [{ ...current.vessel }];
  const tdpPath = [{ ...current.tdp }];
  const events = [];
  const seen = new Set();

  for (let elapsed = step; elapsed <= seconds; elapsed += step) {
    current = stepSimulation(current, step, overrides);
    vesselPath.push({ ...current.vessel });
    tdpPath.push({ ...current.tdp });

    for (const event of current.events) {
      const key = event.type === "crossing"
        ? `crossing-${event.position.x.toFixed(1)}-${event.position.y.toFixed(1)}`
        : event.type;
      if (!seen.has(key)) {
        seen.add(key);
        events.push({ ...event, position: { ...event.position } });
      }
    }
  }

  return {
    finalState: current,
    vesselPath,
    tdpPath,
    events: events.sort((a, b) => a.time - b.time),
    horizon: seconds,
  };
}

export function profileSamples(state, samples = 72) {
  const aft = aftUnit(state.heading);
  const points = [];

  for (let i = 0; i <= samples; i += 1) {
    const ratio = i / samples;
    const nominal = {
      x: state.vessel.x + aft.x * state.lag * ratio,
      y: state.vessel.y + aft.y * state.lag * ratio,
    };
    const currentOffset = ratio * (state.tdp.x - (state.vessel.x + aft.x * state.lag));
    const currentOffsetY = ratio * (state.tdp.y - (state.vessel.y + aft.y * state.lag));
    const bedDepth = depthAt(nominal.x + currentOffset, nominal.y + currentOffsetY);
    points.push({
      distance: state.lag * ratio,
      bedDepth,
      cableDepth: 0,
      x: nominal.x + currentOffset,
      y: nominal.y + currentOffsetY,
    });
  }

  for (let i = 0; i <= samples; i += 1) {
    const ratio = i / samples;
    const point = points[i];
    if (i === samples) {
      point.cableDepth = point.bedDepth;
    } else {
      const smooth = Math.sin(ratio * Math.PI / 2);
      point.cableDepth = state.depth * Math.pow(ratio, 0.72) +
        (point.bedDepth - state.depth) * smooth * ratio;
      point.cableDepth = Math.max(0, Math.min(point.bedDepth, point.cableDepth));
    }
  }

  return points;
}

export function formatClock(seconds) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${minutes.toString().padStart(2, "0")}:${rest}`;
}
