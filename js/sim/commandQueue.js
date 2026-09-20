// 断线期间的指令队列：断线时指令只排队不执行；重连后必须逐条确认或放弃。
export class CommandQueue {
  constructor() {
    this.connected = true;
    this.queued = [];
    this.seq = 1;
    this.since = null; // 断线发生时刻（仿真秒）
  }

  disconnect(time) {
    this.connected = false;
    this.since = time;
  }

  reconnect() {
    this.connected = true;
  }

  // 提交指令：在线立即 apply，离线入队等待确认
  submit(command, applyFn, time) {
    const record = {
      seq: this.seq++,
      command,
      time,
      label: describe(command),
      status: 'pending',
    };
    if (this.connected) {
      applyFn(command);
      record.status = 'applied';
      return { queued: false, record };
    }
    this.queued.push(record);
    return { queued: true, record };
  }

  confirm(index, applyFn) {
    const rec = this.queued[index];
    if (!rec) return null;
    applyFn(rec.command);
    rec.status = 'confirmed';
    this.queued.splice(index, 1);
    return rec;
  }

  confirmAll(applyFn) {
    const all = [...this.queued];
    this.queued.length = 0;
    all.forEach((r) => {
      applyFn(r.command);
      r.status = 'confirmed';
    });
    return all;
  }

  discardAll() {
    const all = [...this.queued];
    this.queued.length = 0;
    all.forEach((r) => (r.status = 'discarded'));
    return all;
  }

  discard(index) {
    const [rec] = this.queued.splice(index, 1);
    if (rec) rec.status = 'discarded';
    return rec || null;
  }

  pendingCount() {
    return this.queued.length;
  }
}

export function describe(command) {
  switch (command.type) {
    case 'speed':
      return `航速 → ${command.value.toFixed(2)} m/s`;
    case 'payout':
      return `放缆比例 → ${(command.value * 100).toFixed(0)}%`;
    case 'turn':
      return `转向速率 → ${(command.value * 180 / Math.PI).toFixed(1)} °/s`;
    case 'autopilot':
      return command.value ? '恢复自动航行' : '切换手动航行';
    case 'nudge':
      return `航向偏置 ${(command.value * 180 / Math.PI).toFixed(1)}°`;
    default:
      return command.type;
  }
}
