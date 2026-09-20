// 双视图 Canvas 渲染：上方俯视平面图，下方沿船首向剖面图。
import { dist } from '../sim/util.js';
import { LIMITS } from '../sim/simulation.js';

export class Renderer {
  constructor(planCanvas, profileCanvas, env) {
    this.plan = planCanvas.getContext('2d');
    this.prof = profileCanvas.getContext('2d');
    this.env = env;
    this.scale = 0.42; // 俯视：米 -> 像素
    this.centerOffset = { x: 0.25, y: 0.18 }; // 船在画面中的相对位置（偏右下，留出前瞻）
    this.prediction = null;
    this.cssW = 0;
    this.cssH = 0;
  }

  draw(manager, active) {
    this.drawPlan(manager, active);
    this.drawProfile(active);
  }

  _worldToScreen(ctx, w, h, p, ship, heading) {
    const dx = p.x - ship.x;
    const dy = p.y - ship.y;
    // 世界 x=东，y=北；屏幕上方为航向
    const c = Math.cos(-heading);
    const s = Math.sin(-heading);
    const rx = c * dx - s * dy;
    const ry = s * dx + c * dy;
    return {
      x: w * (0.5 - this.centerOffset.x) + rx * this.scale,
      y: h * (0.5 + this.centerOffset.y) - ry * this.scale,
    };
  }

  drawPlan(manager, active) {
    const ctx = this.plan;
    const cv = ctx.canvas;
    const w = this.cssW || cv.width;
    const h = this.cssH || cv.height;
    const sim = active.sim;
    const head = sim.ship.heading;
    const to = (p) => this._worldToScreen(ctx, w, h, p, sim.ship, head);

    ctx.fillStyle = '#06182b';
    ctx.fillRect(0, 0, w, h);

    // 水深底纹：离屏低分辨率渲染后平滑放大，避免网格缝隙
    const tileM = 60;
    const cols = Math.ceil(w / (tileM * this.scale)) + 2;
    const rows = Math.ceil(h / (tileM * this.scale)) + 2;
    if (!this._depthCanvas) this._depthCanvas = document.createElement('canvas');
    const dc = this._depthCanvas;
    if (dc.width !== cols || dc.height !== rows) { dc.width = cols; dc.height = rows; }
    const dctx = dc.getContext('2d');
    const img = dctx.createImageData(cols, rows);
    const c0 = Math.cos(head), s0 = Math.sin(head);
    const cxShip = w * (0.5 - this.centerOffset.x);
    const cyShip = h * (0.5 + this.centerOffset.y);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const rx = (i - cols / 2 + 0.5) * tileM;
        const ry = (j - rows / 2 + 0.5) * tileM;
        const wx = sim.ship.x + c0 * rx + s0 * ry;
        const wy = sim.ship.y - s0 * rx + c0 * ry;
        const t = Math.min(1, this.env.depth(wx, wy) / 400);
        const k = (j * cols + i) * 4;
        img.data[k] = Math.round(6 + 10 * t);
        img.data[k + 1] = Math.round(24 + 34 * t);
        img.data[k + 2] = Math.round(43 + 60 * t);
        img.data[k + 3] = 255;
      }
    }
    dctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(dc, 0, 0, cols, rows, 0, 0, w, h);

    // 海流矢量场
    const arrowStep = 260;
    const rangeM = Math.max(w, h) / 2 / this.scale + arrowStep;
    const ca = Math.cos(head), sa = Math.sin(head);
    ctx.strokeStyle = 'rgba(103,232,249,0.55)';
    ctx.fillStyle = 'rgba(103,232,249,0.7)';
    ctx.lineWidth = 1;
    for (let gx = -rangeM; gx <= rangeM; gx += arrowStep) {
      for (let gy = -rangeM; gy <= rangeM; gy += arrowStep) {
        const wx = sim.ship.x + ca * gx + sa * gy;
        const wy = sim.ship.y - sa * gx + ca * gy;
        const cur = this.env.current(wx, wy, sim.time);
        const sp = to({ x: wx, y: wy });
        const scaleA = 260;
        // 世界(东 x,北 y) 旋到屏幕坐标
        const ex = sp.x + (ca * cur.vx - sa * cur.vy) * scaleA;
        const ey = sp.y - (sa * cur.vx + ca * cur.vy) * scaleA;
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        const ang = Math.atan2(ey - sp.y, ex - sp.x);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - 5 * Math.cos(ang - 0.4), ey - 5 * Math.sin(ang - 0.4));
        ctx.lineTo(ex - 5 * Math.cos(ang + 0.4), ey - 5 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
      }
    }

    // 走廊
    const cor = this.env.corridor();
    const drawPoly = (pts, stroke, fill, width = 2) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const sp = to(p);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    ctx.beginPath();
    cor.left.forEach((p, i) => {
      const sp = to(p);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    for (let i = cor.right.length - 1; i >= 0; i--) {
      const sp = to(cor.right[i]);
      ctx.lineTo(sp.x, sp.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(56,189,248,0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(56,189,248,0.7)';
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    // 规划中线
    drawPoly(this.env.route, 'rgba(125,211,252,0.5)', null, 1.5);

    // 既有管线
    for (const pipe of this.env.pipelines) {
      const a = to(pipe.a);
      const b = to(pipe.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 3;
      ctx.setLineDash([14, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fdba74';
      ctx.font = '12px sans-serif';
      ctx.fillText(pipe.id, a.x, a.y - 4);
    }

    // 其他策略的船位与落缆轨迹
    for (const item of manager.items) {
      if (item.id === active.id) continue;
      this._drawLaid(ctx, to, item.sim.laid, item.color, 0.5);
      const sp = to(item.sim.ship);
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 已铺缆线（海床）
    this._drawLaid(ctx, to, sim.laid, '#34d399', 1);

    // 前瞻预测轨迹
    if (this.prediction) {
      ctx.beginPath();
      this.prediction.samples.forEach((smp, i) => {
        const sp = to(smp.tdp);
        if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
      });
      ctx.strokeStyle = 'rgba(250,204,21,0.65)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      // 预测风险点
      for (const hz of this.prediction.hazards) {
        const sp = to(hz.position);
        ctx.fillStyle = hz.level === 'critical' ? '#ef4444' : '#f59e0b';
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 已发生的交叉点
    for (const ev of sim.events) {
      const sp = to(ev.point);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
      ctx.moveTo(sp.x - 11, sp.y);
      ctx.lineTo(sp.x + 11, sp.y);
      ctx.moveTo(sp.x, sp.y - 11);
      ctx.lineTo(sp.x, sp.y + 11);
      ctx.stroke();
    }
    // 海床上弯曲半径过小的已铺点
    for (let i = 0; i < sim.laid.length; i += 2) {
      const p0 = sim.laid[i];
      if (p0.bend < LIMITS.bendRadius) {
        const sp = to(p0);
        ctx.fillStyle = 'rgba(239,68,68,0.8)';
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 悬空段（俯视投影，含侧流弯曲）
    const shape = sim.suspendedShape();
    ctx.beginPath();
    shape.world.forEach((p, i) => {
      const sp = to(p);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    ctx.strokeStyle = '#a7f3d0';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 船
    const sc = to(sim.ship);
    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate(0);
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(7, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7, 9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 指北/比例尺
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px sans-serif';
    ctx.fillText(`比例 1:${Math.round(1 / this.scale)}`, 12, h - 12);
    this._drawCompass(ctx, w - 34, 34, head);
  }

  _drawLaid(ctx, to, laid, color, alpha) {
    if (laid.length < 2) return;
    ctx.beginPath();
    laid.forEach((p, i) => {
      const sp = to(p);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _drawCompass(ctx, x, y, heading) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#94a3b8';
    ctx.fillStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.rotate(-heading);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(4, 4);
    ctx.lineTo(0, 0);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -20);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  // 剖面图：以当前船首向为剖面轴，采样海床，叠加悬空缆与 TDP。
  drawProfile(active) {
    const ctx = this.prof;
    const cv = ctx.canvas;
    const w = this.cssW || cv.width;
    const h = (this.cssH || cv.height) * 0.46;
    const sim = active.sim;
    const head = sim.ship.heading;
    const fwd = { x: Math.sin(head), y: Math.cos(head) };
    const padL = 46;
    const padR = 16;
    const padT = 18;
    const padB = 26;

    // 采样窗口：TDP 前 600m 到船尾后 200m
    const xBack = 1100;
    const xFwd = 900;
    const maxDepth = 420;
    const sx = (sVal) => padL + ((sVal + xBack) / (xBack + xFwd)) * (w - padL - padR);
    const sy = (d) => padT + (d / maxDepth) * (h - padT - padB);

    ctx.fillStyle = '#04111f';
    ctx.fillRect(0, 0, w, h);

    // 沿轴采样海床
    const bedPts = [];
    for (let s = -xBack; s <= xFwd; s += 24) {
      const wx = sim.ship.x + fwd.x * s;
      const wy = sim.ship.y + fwd.y * s;
      bedPts.push({ s, depth: this.env.depth(wx, wy), x: wx, y: wy });
    }

    // 水体渐变 + 海床填充
    ctx.beginPath();
    ctx.moveTo(sx(bedPts[0].s), sy(bedPts[0].depth));
    bedPts.forEach((p) => ctx.lineTo(sx(p.s), sy(p.depth)));
    ctx.lineTo(sx(xFwd), h - padB + 40);
    ctx.lineTo(sx(-xBack), h - padB + 40);
    ctx.closePath();
    ctx.fillStyle = '#16253a';
    ctx.fill();
    ctx.strokeStyle = '#3b5572';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    bedPts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(sx(p.s), sy(p.depth)); else ctx.lineTo(sx(p.s), sy(p.depth));
    });
    ctx.stroke();

    // 高曲率床段标红
    for (let i = 1; i < bedPts.length - 1; i++) {
      const g = this.env.bedGeometry({ x: bedPts[i].x, y: bedPts[i].y }, head);
      if (g.radius < LIMITS.bendRadius) {
        const p = bedPts[i];
        ctx.fillStyle = 'rgba(239,68,68,0.5)';
        ctx.beginPath();
        ctx.arc(sx(p.s), sy(p.depth), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 网格与坐标
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.fillStyle = '#7d94ad';
    ctx.font = '10px sans-serif';
    for (let d = 100; d <= 400; d += 100) {
      ctx.beginPath();
      ctx.moveTo(padL, sy(d));
      ctx.lineTo(w - padR, sy(d));
      ctx.stroke();
      ctx.fillText(`${d}m`, 6, sy(d) + 3);
    }
    for (let s = -xBack; s <= xFwd; s += 200) {
      ctx.fillText(`${s >= 0 ? '+' : ''}${s}m`, sx(s) - 12, h - 8);
    }

    // 悬空缆：投影到轴-深度平面（船尾为 s=0，TDP 在 s=-span）
    const shape = sim.suspendedShape();
    const sternToTdp = this._tdpAxisOffset(sim, fwd); // 负值
    ctx.beginPath();
    shape.world.forEach((p, i) => {
      const rx = (p.x - sim.tdp.x) * fwd.x + (p.y - sim.tdp.y) * fwd.y;
      const sAxis = sternToTdp + rx;
      const depth = -p.z;
      if (i === 0) ctx.moveTo(sx(sAxis), sy(depth));
      else ctx.lineTo(sx(sAxis), sy(depth));
    });
    ctx.strokeStyle = sim.slack ? '#fbbf24' : '#34d399';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // TDP 标记
    ctx.fillStyle = '#f472b6';
    ctx.beginPath();
    ctx.arc(sx(sternToTdp), sy(sim.tdp.depth), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f9a8d4';
    ctx.fillText('TDP', sx(sternToTdp) + 8, sy(sim.tdp.depth) - 6);

    // 船尾（水面处）
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(0));
    ctx.lineTo(sx(0) - 10, sy(0) + 11);
    ctx.lineTo(sx(0) + 10, sy(0) + 11);
    ctx.closePath();
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();

    // 读数
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '12px sans-serif';
    ctx.fillText(
      `张力 ${(sim.tension / 1000).toFixed(2)} kN　跨度 ${sim.span.toFixed(0)} m　` +
      `悬空 ${shape.sol.length.toFixed(0)} m${sim.slack ? '　⚠ 松弛' : ''}`,
      padL, 14
    );
  }

  _tdpAxisOffset(sim, fwd) {
    return (sim.tdp.x - sim.ship.x) * fwd.x + (sim.tdp.y - sim.ship.y) * fwd.y;
  }
}
