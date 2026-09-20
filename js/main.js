// 应用入口：连接仿真核心、渲染器、策略管理、离线指令队列与 UI。
import { Environment } from './sim/environment.js';
import { Simulation, LIMITS } from './sim/simulation.js';
import { ScenarioManager } from './sim/scenarios.js';
import { CommandQueue, describe } from './sim/commandQueue.js';
import { evaluateLive, predict } from './sim/hazards.js';
import { Renderer } from './ui/renderer.js';

const $ = (id) => document.getElementById(id);

const env = new Environment();
const manager = new ScenarioManager(env);
manager.create('基线策略');
const queue = new CommandQueue();
const renderer = new Renderer($('planView'), $('profileView'), env);

let horizonSec = 600;
const predictions = new Map(); // 策略id -> { at, realAt, result }
const cmdLog = [];

// ---------- 指令下发（在线执行 / 离线排队） ----------
function dispatch(command) {
  const active = manager.active();
  const apply = (cmd) => {
    const sim = manager.active().sim;
    if (cmd.type === 'speed') sim.setSpeed(cmd.value);
    else if (cmd.type === 'payout') sim.setPayoutRatio(cmd.value);
    else if (cmd.type === 'turn') sim.setTurn(cmd.value);
    else if (cmd.type === 'nudge') {
      if (cmd.value === 0) sim.setAutopilot(true);
      else sim.nudgeHeading(cmd.value);
    } else if (cmd.type === 'autopilot') sim.setAutopilot(cmd.value);
  };
  const { queued } = queue.submit(command, apply, active.sim.time);
  logCommand(command, queued ? 'pending' : 'applied');
  syncControls(active);
}

function logCommand(command, status) {
  cmdLog.unshift({
    label: describe(command),
    status,
    time: manager.active().sim.time,
  });
  if (cmdLog.length > 40) cmdLog.pop();
}

// ---------- UI 绑定 ----------
$('speedSlider').addEventListener('input', (e) => {
  dispatch({ type: 'speed', value: parseFloat(e.target.value) });
});
$('payoutSlider').addEventListener('input', (e) => {
  dispatch({ type: 'payout', value: parseFloat(e.target.value) });
});
$('turnSlider').addEventListener('input', (e) => {
  dispatch({ type: 'turn', value: parseFloat(e.target.value) });
});
$('autopilotChk').addEventListener('change', (e) => {
  dispatch({ type: 'autopilot', value: e.target.checked });
  $('manualTurn').classList.toggle('hidden', e.target.checked);
  $('autoNudge').classList.toggle('hidden', !e.target.checked);
});
document.querySelectorAll('[data-nudge]').forEach((btn) => {
  btn.addEventListener('click', () =>
    dispatch({ type: 'nudge', value: parseFloat(btn.dataset.nudge) }));
});
document.querySelectorAll('[data-turn]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const v = parseFloat(btn.dataset.turn);
    $('turnSlider').value = v;
    dispatch({ type: 'turn', value: v });
  });
});
document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.preset === 'risk') {
      $('speedSlider').value = 2.5;
      $('payoutSlider').value = 0.88;
    } else {
      $('speedSlider').value = 0.6;
      $('payoutSlider').value = 1.03;
    }
    dispatch({ type: 'speed', value: parseFloat($('speedSlider').value) });
    dispatch({ type: 'payout', value: parseFloat($('payoutSlider').value) });
  });
});
$('horizonSlider').addEventListener('input', (e) => {
  horizonSec = parseInt(e.target.value, 10);
  $('horizonVal').textContent = `${horizonSec}s`;
  predictions.clear();
});
$('btnFork').addEventListener('click', () => {
  manager.active().paused = true;
  const forked = manager.fork();
  forked.paused = false;
  manager.setActive(forked.id);
});
$('btnRemove').addEventListener('click', () => {
  const active = manager.active();
  if (manager.items.length > 1) {
    predictions.delete(active.id);
    manager.remove(active.id);
  }
});
$('btnPause').addEventListener('click', () => {
  const active = manager.active();
  active.paused = !active.paused;
});
$('btnDisconnect').addEventListener('click', () => {
  if (queue.connected) {
    queue.disconnect(manager.active().sim.time);
  } else {
    queue.reconnect();
    openReconnectModal();
  }
  updateConnUI();
});
$('btnConfirmAll').addEventListener('click', () => {
  const applied = queue.confirmAll(applyQueued);
  applied.forEach(() => cmdLog.unshift({
    label: '断线指令批量确认', status: 'applied', time: manager.active().sim.time,
  }));
  closeReconnectModal();
  updateConnUI();
});
$('btnDiscardAll').addEventListener('click', () => {
  queue.discardAll();
  cmdLog.unshift({ label: '断线指令全部放弃', status: 'discarded', time: manager.active().sim.time });
  closeReconnectModal();
  updateConnUI();
});

function applyQueued(cmd) {
  const sim = manager.active().sim;
  if (cmd.type === 'speed') {
    sim.setSpeed(cmd.value);
    $('speedSlider').value = cmd.value;
  } else if (cmd.type === 'payout') {
    sim.setPayoutRatio(cmd.value);
    $('payoutSlider').value = cmd.value;
  } else if (cmd.type === 'turn') {
    sim.setTurn(cmd.value);
    $('turnSlider').value = cmd.value;
  }
}

function openReconnectModal() {
  const list = $('pendingList');
  list.innerHTML = '';
  queue.queued.forEach((rec, idx) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span>${rec.label}<br><small class="meta">记录于 T+${fmtClock(rec.time)}</small></span>
       <span class="rowbtns">
         <button class="btn small ok" data-act="ok">确认</button>
         <button class="btn small warn ghost" data-act="no">放弃</button>
       </span>`;
    li.querySelector('[data-act=ok]').addEventListener('click', () => {
      queue.confirm(idx, applyQueued);
      openReconnectModal();
    });
    li.querySelector('[data-act=no]').addEventListener('click', () => {
      queue.discard(idx);
      openReconnectModal();
    });
    list.appendChild(li);
  });
  if (queue.pendingCount() === 0) {
    list.innerHTML = '<li>断线期间没有挂起的指令。</li>';
  }
  $('reconnectModal').classList.remove('hidden');
}
function closeReconnectModal() {
  $('reconnectModal').classList.add('hidden');
}
function updateConnUI() {
  const el = $('connState');
  el.textContent = queue.connected ? '● 已连接' : '● 链路中断（指令挂起）';
  el.className = `conn ${queue.connected ? 'online' : 'offline'}`;
  $('btnDisconnect').textContent = queue.connected ? '模拟断线' : '模拟重连';
}

// ---------- 视图与面板刷新 ----------
function syncControls(active) {
  const sim = active.sim;
  $('speedVal').textContent = `${sim.speedCmd.toFixed(2)} m/s`;
  $('payoutVal').textContent = `${(sim.payoutRatio * 100).toFixed(0)}%`;
  $('autopilotChk').checked = sim.autopilot;
  $('manualTurn').classList.toggle('hidden', sim.autopilot);
  $('autoNudge').classList.toggle('hidden', !sim.autopilot);
  $('turnSlider').value = sim.turnCmd;
}

function fmtClock(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderTelemetry(sim) {
  const cur = env.current(sim.tdp.x, sim.tdp.y, sim.time);
  const curSpd = Math.hypot(cur.vx, cur.vy);
  const headDeg = ((sim.ship.heading * 180 / Math.PI) % 360 + 360) % 360;
  const ct = corridorOffset(sim);
  const tCls = sim.tension > LIMITS.tension ? 'bad'
    : sim.tension > LIMITS.tension * 0.8 ? 'warnv' : '';
  $('telemetry').innerHTML = `
    <span class="k">船位(东,北)</span><span class="v">${sim.ship.x.toFixed(0)}, ${sim.ship.y.toFixed(0)}</span>
    <span class="k">航向 / 航速</span><span class="v">${headDeg.toFixed(0)}° / ${sim.ship.speed.toFixed(2)} m/s</span>
    <span class="k">缆顶张力</span><span class="v ${tCls}">${(sim.tension / 1000).toFixed(2)} kN</span>
    <span class="k">水平跨度</span><span class="v">${sim.span.toFixed(0)} m</span>
    <span class="k">TDP 水深</span><span class="v">${sim.tdp.depth.toFixed(1)} m</span>
    <span class="k">海床曲率半径</span><span class="v ${sim.tdp.bendRadius < LIMITS.bendRadius ? 'bad' : ''}">${
      isFinite(sim.tdp.bendRadius) ? sim.tdp.bendRadius.toFixed(0) + ' m' : '—'}</span>
    <span class="k">海流(TDP)</span><span class="v">${(curSpd * 100).toFixed(1)} cm/s</span>
    <span class="k">走廊偏差</span><span class="v ${ct > LIMITS.corridor ? 'bad' : ''}">${ct.toFixed(0)} m</span>
    <span class="k">放缆 / 已铺</span><span class="v">${sim.paidOut.toFixed(0)} / ${sim.laidLength.toFixed(0)} m</span>
    <span class="k">缆线状态</span><span class="v ${sim.slack ? 'warnv' : ''}">${sim.slack ? '松弛' : '张紧'}</span>`;
}

function corridorOffset(sim) {
  return sim._corridorOffset(sim.tdp).offset;
}

function renderHazards(sim, prediction) {
  const live = evaluateLive(sim);
  const ul = $('hazardList');
  ul.innerHTML = '';
  const rows = [];
  for (const h of live) {
    rows.push({
      cls: h.level,
      title: h.message,
      sub: `当前发生 · (${h.position.x.toFixed(0)}, ${h.position.y.toFixed(0)})`,
    });
  }
  // 已经发生的管线交叉（历史事件，最近 3 条）
  for (const ev of sim.events.slice(-3)) {
    rows.push({
      cls: 'critical',
      title: `已发生：${ev.message}`,
      sub: `T+${fmtClock(ev.time)} · (${ev.point.x.toFixed(0)}, ${ev.point.y.toFixed(0)})`,
    });
  }
  for (const h of prediction ? prediction.hazards : []) {
    const etaMin = Math.floor(h.eta / 60);
    const etaSec = Math.round(h.eta % 60);
    rows.push({
      cls: h.level,
      title: `预计：${h.message}`,
      sub: `约 ${etaMin}分${etaSec}秒后 · (${h.position.x.toFixed(0)}, ${h.position.y.toFixed(0)})`,
    });
  }
  if (rows.length === 0) {
    ul.innerHTML = '<li class="hazard-empty">前瞻时段内未发现超限、急弯、越界或交叉风险。</li>';
    return;
  }
  for (const r of rows.slice(0, 10)) {
    const li = document.createElement('li');
    li.className = r.cls;
    li.innerHTML = `<div>${r.title}</div><div class="pos">${r.sub}</div>`;
    ul.appendChild(li);
  }
}

function renderScenarios() {
  const ul = $('scenarioList');
  ul.innerHTML = '';
  for (const st of manager.stats()) {
    const li = document.createElement('li');
    li.className = st.id === manager.activeId ? 'active' : '';
    li.innerHTML = `<span><span style="color:${st.color}">●</span> ${st.name}
      <span class="tag ${st.paused ? 'paused' : 'live'}">${st.paused ? '已暂停' : '运行'}</span></span>
      <span style="color:#7d94ad">${(st.tension / 1000).toFixed(1)}kN</span>`;
    li.addEventListener('click', () => manager.setActive(st.id));
    ul.appendChild(li);
  }
}

function renderCmdLog() {
  const ul = $('cmdLog');
  ul.innerHTML = '';
  for (const r of cmdLog.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = r.status;
    li.innerHTML = `${r.label} <div class="meta">T+${fmtClock(r.time)} · ${
      r.status === 'applied' ? '已执行' : r.status === 'pending' ? '挂起' : '已放弃'}</div>`;
    ul.appendChild(li);
  }
}

// ---------- 画布尺寸 ----------
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const cv of [$('planView'), $('profileView')]) {
    const wrap = cv.parentElement.getBoundingClientRect();
    cv.width = Math.max(1, wrap.width * dpr);
    cv.height = Math.max(1, wrap.height * dpr);
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const pw = $('planView').parentElement.getBoundingClientRect();
  renderer.cssW = pw.width;
  renderer.cssH = pw.height;
}
window.addEventListener('resize', resizeCanvases);

// 俯视缩放
$('planView').addEventListener('wheel', (e) => {
  e.preventDefault();
  renderer.scale *= e.deltaY < 0 ? 1.12 : 0.89;
  renderer.scale = Math.min(3, Math.max(0.12, renderer.scale));
}, { passive: false });

// ---------- 主循环 ----------
let last = performance.now();
let uiAccum = 0;
let realDt = 0;
const FIXED = 0.25;

function frame(now) {
  realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const mult = parseInt($('speedMult').value, 10);
  const active = manager.active();

  // 固定步长推进；高倍速时用大步长追赶（物理步长随倍率放宽以保证实时性）
  if (active && !active.paused) {
    const budget = Math.min(30, realDt * mult);
    if (budget <= FIXED) {
      manager.advance(budget);
    } else {
      const sub = mult <= 4 ? FIXED : Math.min(5, budget / 12);
      let remain = budget;
      let n = 0;
      while (remain > 0 && n < 40) {
        const dt = Math.min(sub, remain);
        manager.advance(dt);
        remain -= dt;
        n++;
      }
    }
  }

  // 前瞻预测节流（约每 2 个仿真秒重算；暂停或切换策略时立即重算一次）
  let cache = predictions.get(active.id);
  const nowMs = performance.now();
  const staleReal = !cache || nowMs - cache.realAt > 1200;
  const staleSim = !cache || Math.abs(active.sim.time - cache.at) > Math.max(20, horizonSec * 0.08);
  if (staleReal || staleSim || (active.paused && cache.at !== active.sim.time)) {
    cache = { at: active.sim.time, realAt: nowMs, result: predict(active.sim, horizonSec, 10) };
    predictions.set(active.id, cache);
  }
  renderer.prediction = cache.result;

  renderer.draw(manager, active);
  $('simClock').textContent = `T+${fmtClock(active.sim.time)}`;
  $('btnPause').textContent = active.paused ? '▶ 继续' : '⏸ 暂停';

  uiAccum += realDt;
  if (uiAccum > 0.2) {
    renderTelemetry(active.sim);
    renderHazards(active.sim, cache.result);
    renderScenarios();
    renderCmdLog();
    syncControls(active);
    uiAccum = 0;
  }
  requestAnimationFrame(frame);
}

resizeCanvases();
syncControls(manager.active());
updateConnUI();
requestAnimationFrame(frame);
