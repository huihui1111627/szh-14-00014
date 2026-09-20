import {
  BEND_LIMIT,
  CORRIDOR_HALF_WIDTH,
  DT,
  DEFAULTS,
  TENSION_LIMIT,
  createInitialState,
  forecast,
  formatClock,
  profileSamples,
  stepSimulation,
} from "./simulation.js";

const $ = (selector) => document.querySelector(selector);

const controls = {
  speed: DEFAULTS.speed,
  turnRate: DEFAULTS.turnRate,
  payoutRatio: DEFAULTS.payoutRatio,
  timeScale: DEFAULTS.timeScale,
};

const ui = {
  plan: $("#planCanvas"),
  profile: $("#profileCanvas"),
  speed: $("#speedInput"),
  turn: $("#turnInput"),
  payout: $("#payoutInput"),
  rate: $("#rateInput"),
  playPause: $("#playPauseBtn"),
  step: $("#stepBtn"),
  reset: $("#resetBtn"),
  reforecast: $("#reforecastBtn"),
  snapshot: $("#snapshotBtn"),
  restore: $("#restoreBtn"),
  connection: $("#connectionToggle"),
  linkBadge: $("#linkBadge"),
  statusGrid: $("#statusGrid"),
  alertBody: $("#alertBody"),
  strategyList: $("#strategyList"),
  commandQueue: $("#commandQueue"),
  queueHint: $("#queueHint"),
  dialog: $("#commandDialog"),
  dialogQueue: $("#dialogQueue"),
  labels: {
    speed: $("#speedLabel"),
    turn: $("#turnLabel"),
    payout: $("#payoutLabel"),
    rate: $("#rateLabel"),
  },
};

let state = createInitialState();
let future = forecast(state, controls);
let running = true;
let online = true;
let pendingCommands = [];
let strategies = [];
let baselineNode = null;
let lastFrame = performance.now();
let accumulator = 0;
let forecastDirty = true;
let lastForecastAt = 0;

const commandLabels = {
  speed: (value) => `航速调整为 ${Number(value).toFixed(2)} m/s`,
  turnRate: (value) => `转向速率调整为 ${Number(value).toFixed(1)}°/min`,
  payoutRatio: (value) => `放缆比例调整为 ${Number(value).toFixed(2)}×`,
  playPause: (value) => value ? "继续作业" : "暂停作业",
  step: () => "执行单个仿真节点",
  reset: () => "重置作业",
  restore: (value) => `恢复策略节点 ${value.label}`,
};

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function pathFrom(points) {
  const path = new Path2D();
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x, points[i].y);
  return path;
}

function offsetPath(points, offset) {
  return points.map((point) => ({ x: point.x + offset, y: point.y }));
}

function drawPolyline(ctx, points, stroke, width = 2, dash = []) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();
}

function queueCommand(type, value) {
  const command = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    value,
    simTime: state.time,
    createdAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    status: "pending",
  };
  pendingCommands.push(command);
  renderCommands();
}

function applyCommand(command) {
  switch (command.type) {
    case "speed":
      controls.speed = command.value;
      ui.speed.value = command.value;
      break;
    case "turnRate":
      controls.turnRate = command.value;
      ui.turn.value = command.value;
      break;
    case "payoutRatio":
      controls.payoutRatio = command.value;
      ui.payout.value = command.value;
      break;
    case "playPause":
      running = Boolean(command.value);
      break;
    case "step":
      state = stepSimulation(state, DT, controls);
      break;
    case "reset":
      state = createInitialState();
      strategies = [];
      baselineNode = null;
      running = true;
      break;
    case "restore": {
      const snapshot = strategies.find((item) => item.id === command.value.id);
      if (snapshot) {
        state = structuredClone(snapshot.state);
        Object.assign(controls, snapshot.controls);
        syncInputs();
      }
      break;
    }
    default:
      break;
  }
  command.status = "done";
  forecastDirty = true;
}

function submitControl(type, value) {
  if (online) {
    applyCommand({ type, value, status: "done" });
  } else {
    queueCommand(type, value);
  }
  updateLabels();
}

function syncInputs() {
  ui.speed.value = controls.speed;
  ui.turn.value = controls.turnRate;
  ui.payout.value = controls.payoutRatio;
  ui.rate.value = controls.timeScale;
  updateLabels();
}

function updateLabels() {
  ui.labels.speed.textContent = `${controls.speed.toFixed(2)} m/s`;
  ui.labels.turn.textContent = `${controls.turnRate.toFixed(1)}°/min`;
  ui.labels.payout.textContent = `${controls.payoutRatio.toFixed(2)}×`;
  ui.labels.rate.textContent = `${controls.timeScale}×`;
  ui.playPause.textContent = running ? "暂停" : "继续";
  ui.linkBadge.textContent = online ? "在线" : "断线";
  ui.linkBadge.className = `badge ${online ? "good" : "bad"}`;
  ui.connection.checked = online;
}

function refreshForecast(force = false) {
  const now = performance.now();
  if (!force && future && (!forecastDirty || now - lastForecastAt < 250)) return;
  future = forecast(state, controls);
  forecastDirty = false;
  lastForecastAt = now;
}

function drawArrow(ctx, x, y, u, v, color) {
  const length = Math.hypot(u, v);
  if (length < 0.01) return;
  const scale = 90;
  const endX = x + u * scale;
  const endY = y + v * scale;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  const angle = Math.atan2(v, u);
  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(endX - 7 * Math.cos(angle - 0.45), endY - 7 * Math.sin(angle - 0.45));
  ctx.lineTo(endX - 7 * Math.cos(angle + 0.45), endY - 7 * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPlan() {
  refreshForecast();
  const { ctx, width, height } = resizeCanvas(ui.plan);
  ctx.clearRect(0, 0, width, height);

  const margin = 34;
  const points = [
    ...future.tdpPath.slice(0, 18),
    ...state.laid.slice(-120),
    state.tdp,
    ...future.tdpPath,
  ];
  const minX = Math.min(...points.map((p) => p.x), -CORRIDOR_HALF_WIDTH) - margin;
  const maxX = Math.max(...points.map((p) => p.x), CORRIDOR_HALF_WIDTH) + margin;
  const minY = Math.min(...points.map((p) => p.y), state.vessel.y - 100) - margin;
  const maxY = Math.max(...points.map((p) => p.y), state.vessel.y + 80) + margin;
  const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
  const toScreen = (p) => ({
    x: (p.x - (minX + maxX) / 2) * scale + width / 2,
    y: height - (p.y - (minY + maxY) / 2) * scale - height / 2,
  });

  ctx.fillStyle = "#061522";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(128,180,205,.08)";
  ctx.lineWidth = 1;
  const grid = 100;
  for (let x = Math.floor(minX / grid) * grid; x <= maxX; x += grid) {
    const a = toScreen({ x, y: minY });
    const b = toScreen({ x, y: maxY });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (let y = Math.floor(minY / grid) * grid; y <= maxY; y += grid) {
    const a = toScreen({ x: minX, y });
    const b = toScreen({ x: maxX, y });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  const corridorTop = [
    toScreen({ x: -CORRIDOR_HALF_WIDTH, y: minY }),
    toScreen({ x: -CORRIDOR_HALF_WIDTH, y: maxY }),
  ];
  const corridorBottom = [
    toScreen({ x: CORRIDOR_HALF_WIDTH, y: maxY }),
    toScreen({ x: CORRIDOR_HALF_WIDTH, y: minY }),
  ];
  ctx.save();
  ctx.fillStyle = "rgba(56,213,243,.07)";
  ctx.beginPath();
  ctx.moveTo(corridorTop[0].x, corridorTop[0].y);
  corridorTop.forEach((p) => ctx.lineTo(p.x, p.y));
  corridorBottom.reverse().forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const existingA = toScreen({ x: -240, y: 20 });
  const existingB = toScreen({ x: 720, y: 404 });
  drawPolyline(ctx, [existingA, existingB], "#b18cff", 3, [8, 5]);

  if (state.laid.length > 1) drawPolyline(ctx, state.laid.map(toScreen), "#f7c948", 3);
  const stern = toScreen({
    x: state.vessel.x - 8 * Math.cos(state.heading),
    y: state.vessel.y - 8 * Math.sin(state.heading),
  });
  drawPolyline(ctx, [stern, toScreen(state.tdp)], "#ffd166", 2);
  drawPolyline(ctx, future.vesselPath.map(toScreen), "rgba(77,141,255,.75)", 2, [7, 6]);
  drawPolyline(ctx, future.tdpPath.map(toScreen), "#38d5f3", 2, [8, 5]);

  future.events.forEach((event) => {
    const p = toScreen(event.position);
    ctx.save();
    ctx.strokeStyle = event.severity === "info" ? "#38d5f3" : "#ff5c7a";
    ctx.fillStyle = event.severity === "info" ? "rgba(56,213,243,.16)" : "rgba(255,92,122,.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, event.severity === "info" ? 7 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e8f5fb";
    ctx.font = "11px sans-serif";
    ctx.fillText(`T+${formatClock(event.time)}`, p.x + 11, p.y - 8);
    ctx.restore();
  });

  const vessel = toScreen(state.vessel);
  ctx.save();
  ctx.translate(vessel.x, vessel.y);
  ctx.rotate(Math.PI / 2 - state.heading);
  ctx.fillStyle = "#4d8dff";
  ctx.strokeStyle = "#c9e4ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.lineTo(8, 10);
  ctx.lineTo(0, 6);
  ctx.lineTo(-8, 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const tdp = toScreen(state.tdp);
  ctx.fillStyle = "#43d18c";
  ctx.beginPath();
  ctx.arc(tdp.x, tdp.y, 5, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 5; i += 1) {
    const gy = minY + (maxY - minY) * (0.18 + i * 0.16);
    const gx = minX + (maxX - minX) * (0.12 + (i % 2) * 0.68);
    drawArrow(ctx, toScreen({ x: gx, y: gy }).x, toScreen({ x: gx, y: gy }).y, state.current.u, state.current.v, "rgba(56,213,243,.55)");
  }

  ctx.fillStyle = "#8eb0c2";
  ctx.font = "12px sans-serif";
  ctx.fillText("绿点：当前触底点", 12, height - 28);
  ctx.fillText("紫色虚线：既有管线", 12, height - 10);
}

function drawProfile() {
  const { ctx, width, height } = resizeCanvas(ui.profile);
  ctx.clearRect(0, 0, width, height);
  const samples = profileSamples(state);
  const maxDistance = Math.max(state.lag * 1.08, 100);
  const maxDepth = Math.max(...samples.map((sample) => sample.bedDepth)) * 1.18;
  const left = 52;
  const right = 20;
  const top = 20;
  const bottom = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const sx = (distance) => left + (distance / maxDistance) * plotWidth;
  const sy = (depth) => top + (depth / maxDepth) * plotHeight;

  ctx.fillStyle = "#061522";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(128,180,205,.18)";
  ctx.lineWidth = 1;
  for (let depth = 50; depth <= maxDepth; depth += 50) {
    const y = sy(depth);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.fillStyle = "#8eb0c2";
    ctx.font = "11px sans-serif";
    ctx.fillText(`${depth} m`, 10, y + 4);
  }

  const bedPath = samples.map((sample) => ({ x: sx(sample.distance), y: sy(sample.bedDepth) }));
  ctx.save();
  ctx.fillStyle = "rgba(102,74,49,.38)";
  ctx.beginPath();
  ctx.moveTo(bedPath[0].x, bedPath[0].y);
  bedPath.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(width - right, height - bottom);
  ctx.lineTo(left, height - bottom);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawPolyline(ctx, bedPath, "#8a6b47", 3);

  const cablePath = samples.map((sample) => ({ x: sx(sample.distance), y: sy(sample.cableDepth) }));
  drawPolyline(ctx, cablePath, "#ffd166", 3);

  const sternX = sx(0);
  const tdpX = sx(state.lag);
  const tdpY = sy(state.depth);
  ctx.strokeStyle = "rgba(232,245,251,.7)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sternX, top);
  ctx.lineTo(sternX, sy(8));
  ctx.stroke();
  ctx.fillStyle = "#4d8dff";
  ctx.fillRect(sternX - 16, top - 7, 32, 9);

  ctx.fillStyle = "#43d18c";
  ctx.beginPath();
  ctx.arc(tdpX, tdpY, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = state.topTension >= TENSION_LIMIT ? "#ff5c7a" : "rgba(255,92,122,.55)";
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(sternX, tdpY);
  ctx.lineTo(tdpX, tdpY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#e8f5fb";
  ctx.font = "12px sans-serif";
  ctx.fillText(`悬空段 ${state.suspendedLength.toFixed(0)} m`, sternX + 10, top + 18);
  ctx.fillText(`水平滞后 ${state.lag.toFixed(0)} m`, Math.max(left + 10, tdpX - 130), tdpY - 10);
  ctx.fillStyle = "#8eb0c2";
  ctx.fillText("船尾", sternX - 14, height - 13);
  ctx.fillText("触底点", Math.max(left, tdpX - 28), height - 13);

  const danger = state.topTension >= TENSION_LIMIT || state.bendRadius <= BEND_LIMIT;
  if (danger) {
    ctx.fillStyle = "#ff5c7a";
    ctx.beginPath();
    ctx.arc(tdpX - 12, tdpY - 12, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function metric(name, value, level = "") {
  return `<div class="metric ${level}"><div class="name">${name}</div><div class="value">${value}</div></div>`;
}

function renderStatus() {
  const tensionLevel = state.topTension >= TENSION_LIMIT ? "bad" : state.topTension > TENSION_LIMIT * 0.82 ? "warn" : "good";
  const bendLevel = state.bendRadius <= BEND_LIMIT ? "bad" : state.bendRadius < BEND_LIMIT * 1.45 ? "warn" : "good";
  ui.statusGrid.innerHTML = [
    metric("作业时间", `T+${formatClock(state.time)}`),
    metric("链路状态", online ? "在线" : "等待确认", online ? "good" : "warn"),
    metric("顶部张力", `${(state.topTension / 1000).toFixed(1)} kN`, tensionLevel),
    metric("弯曲半径", `${state.bendRadius.toFixed(1)} m`, bendLevel),
    metric("触底水深", `${state.depth.toFixed(1)} m`),
    metric("海床坡度", `${(state.bedSlope * 100).toFixed(1)}%`),
    metric("放缆速度", `${state.payoutSpeed.toFixed(2)} m/s`),
    metric("悬空段长度", `${state.suspendedLength.toFixed(0)} m`),
  ].join("");
}

const severityLabel = {
  high: "高风险",
  medium: "中风险",
  low: "提示",
  info: "信息",
};

function eventValue(event) {
  if (event.type === "tension") return `${(event.value / 1000).toFixed(1)} kN`;
  if (event.type === "bend") return `${event.value.toFixed(1)} m`;
  if (event.type === "corridor") return `${event.value.toFixed(0)} m`;
  if (event.type === "crossing") return `${event.value.toFixed(1)}°`;
  return "—";
}

function renderAlerts() {
  refreshForecast();
  if (!future.events.length) {
    ui.alertBody.innerHTML = `<tr class="empty-row"><td colspan="6">未来 ${future.horizon} 秒未发现张力、弯曲、走廊或交叉冲突。</td></tr>`;
    return;
  }

  ui.alertBody.innerHTML = future.events.map((event) => `
    <tr>
      <td><span class="severity severity-${event.severity}">${severityLabel[event.severity]}</span></td>
      <td>${event.message}</td>
      <td>T+${formatClock(event.time)}</td>
      <td>${event.position.x.toFixed(1)} / ${event.position.y.toFixed(1)}</td>
      <td>${eventValue(event)}</td>
      <td>${event.advice}</td>
    </tr>
  `).join("");
}

function renderCommands() {
  const pending = pendingCommands.filter((command) => command.status === "pending");
  ui.queueHint.textContent = online
    ? "在线指令立即生效；断线期间生成的指令会等待重连确认。"
    : `链路断线中：已有 ${pending.length} 条指令暂存，重连后必须确认或放弃。`;

  if (!pendingCommands.length) {
    ui.commandQueue.innerHTML = `<li class="command-item done"><strong>无暂存指令</strong><span>当前所有控制指令均已处理。</span></li>`;
    return;
  }

  ui.commandQueue.innerHTML = pendingCommands.slice(-6).map((command) => `
    <li class="command-item ${command.status}">
      <strong>${commandLabels[command.type](command.value)}</strong>
      <span>产生于 T+${formatClock(command.simTime)} · ${command.createdAt} · 待确认</span>
    </li>
  `).join("");
}

function snapshotStrategy() {
  if (!baselineNode) baselineNode = structuredClone(state);
  const id = `strategy-${strategies.length + 1}`;
  strategies.push({
    id,
    label: `S${strategies.length + 1}`,
    state: structuredClone(state),
    controls: { ...controls },
    summary: forecast(state, controls),
  });
  renderStrategies();
}

function renderStrategies() {
  if (!strategies.length) {
    ui.strategyList.innerHTML = `<div class="strategy-item"><strong>尚无策略</strong><span>暂停后保存，可回到同一海况比较。</span></div>`;
    return;
  }

  ui.strategyList.innerHTML = strategies.map((strategy) => {
    const high = strategy.summary.events.filter((event) => event.severity === "high").length;
    return `
      <li class="strategy-item" data-id="${strategy.id}">
        <strong>${strategy.label} · T+${formatClock(strategy.state.time)}</strong>
        <span>航速 ${strategy.controls.speed.toFixed(2)} · 放缆 ${strategy.controls.payoutRatio.toFixed(2)}× · 未来高风险 ${high} 项</span>
      </li>
    `;
  }).join("");
}

function restoreSelectedStrategy() {
  const selected = ui.strategyList.querySelector(".strategy-item.selected")?.dataset.id;
  const target = strategies.find((strategy) => strategy.id === selected) ?? strategies[strategies.length - 1];
  if (!target) return;
  const restore = () => {
    state = structuredClone(target.state);
    Object.assign(controls, target.controls);
    syncInputs();
    forecastDirty = true;
    renderAll();
  };
  if (online) restore();
  else queueCommand("restore", { id: target.id, label: target.label });
}

function showReconnectDialog() {
  const pending = pendingCommands.filter((command) => command.status === "pending");
  ui.dialogQueue.innerHTML = pending.map((command) => `
    <li class="command-item pending">
      <strong>${commandLabels[command.type](command.value)}</strong>
      <span>产生于 T+${formatClock(command.simTime)} · ${command.createdAt}</span>
    </li>
  `).join("");

  if (!pending.length) return;

  const handleClose = () => {
    const decision = ui.dialog.returnValue;
    if (decision === "confirm") pending.forEach(applyCommand);
    else pending.forEach((command) => { command.status = "discarded"; });
    pendingCommands = pendingCommands.filter((command) => command.status === "pending");
    renderCommands();
    renderAll();
    ui.dialog.removeEventListener("close", handleClose);
  };
  ui.dialog.addEventListener("close", handleClose);
  ui.dialog.showModal();
}

function setOnline(next) {
  if (online === next) return;
  online = next;
  updateLabels();
  if (online) showReconnectDialog();
  renderCommands();
  renderStatus();
}

function bindEvents() {
  ui.speed.addEventListener("input", () => {
    if (!online) {
      ui.speed.value = controls.speed;
      updateLabels();
      return;
    }
    controls.speed = Number(ui.speed.value);
    forecastDirty = true;
    updateLabels();
  });
  ui.speed.addEventListener("change", () => {
    const value = Number(ui.speed.value);
    if (online) submitControl("speed", value);
    else {
      queueCommand("speed", value);
      syncInputs();
    }
  });

  ui.turn.addEventListener("input", () => {
    if (!online) {
      ui.turn.value = controls.turnRate;
      updateLabels();
      return;
    }
    controls.turnRate = Number(ui.turn.value);
    forecastDirty = true;
    updateLabels();
  });
  ui.turn.addEventListener("change", () => {
    const value = Number(ui.turn.value);
    if (online) submitControl("turnRate", value);
    else {
      queueCommand("turnRate", value);
      syncInputs();
    }
  });

  ui.payout.addEventListener("input", () => {
    if (!online) {
      ui.payout.value = controls.payoutRatio;
      updateLabels();
      return;
    }
    controls.payoutRatio = Number(ui.payout.value);
    forecastDirty = true;
    updateLabels();
  });
  ui.payout.addEventListener("change", () => {
    const value = Number(ui.payout.value);
    if (online) submitControl("payoutRatio", value);
    else {
      queueCommand("payoutRatio", value);
      syncInputs();
    }
  });

  ui.rate.addEventListener("input", () => {
    controls.timeScale = Number(ui.rate.value);
    updateLabels();
  });

  ui.playPause.addEventListener("click", () => {
    const next = !running;
    if (online) {
      running = next;
      updateLabels();
      if (!next) snapshotStrategy();
    } else {
      queueCommand("playPause", next);
    }
  });

  ui.step.addEventListener("click", () => submitControl("step", null));
  ui.reset.addEventListener("click", () => {
    if (online) {
      state = createInitialState();
      Object.assign(controls, { ...DEFAULTS });
      syncInputs();
      strategies = [];
      baselineNode = null;
      pendingCommands = [];
      running = true;
      forecastDirty = true;
      renderAll();
    } else {
      queueCommand("reset", null);
    }
  });
  ui.reforecast.addEventListener("click", () => {
    forecastDirty = true;
    renderAlerts();
  });
  ui.snapshot.addEventListener("click", snapshotStrategy);
  ui.restore.addEventListener("click", restoreSelectedStrategy);
  ui.strategyList.addEventListener("click", (event) => {
    const item = event.target.closest(".strategy-item[data-id]");
    if (!item) return;
    ui.strategyList.querySelectorAll(".strategy-item").forEach((node) => node.classList.remove("selected"));
    item.classList.add("selected");
  });
  ui.connection.addEventListener("change", () => setOnline(ui.connection.checked));
  ui.dialog.addEventListener("cancel", (event) => event.preventDefault());
}

function renderAll() {
  drawPlan();
  drawProfile();
  renderStatus();
  renderAlerts();
  renderCommands();
  renderStrategies();
  updateLabels();
}

function animate(now) {
  const elapsed = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (running) {
    accumulator += elapsed * controls.timeScale;
    let guard = 0;
    while (accumulator >= DT && guard < 120) {
      state = stepSimulation(state, DT, controls);
      accumulator -= DT;
      guard += 1;
      forecastDirty = true;
    }
    if (guard >= 120) accumulator = 0;
  }

  renderAll();
  requestAnimationFrame(animate);
}

syncInputs();
bindEvents();
renderCommands();
renderStrategies();
requestAnimationFrame((now) => {
  lastFrame = now;
  requestAnimationFrame(animate);
});
