'use strict';
/**
 * Rolling "last ~30 seconds" buffer.
 * A browser recorder only makes a playable file if it is read from its start, so we keep TWO recorders
 * running, started half a run apart. When you press the clip key we take the one that has been running longest:
 * that is always between STAGGER and RUN seconds of video (about the last 22 to 45 seconds), and it is a complete, playable file.
 */
(function (root) {
  function ClipBuffer(opts) {
    this.makeRecorder = opts.makeRecorder;      // () => { start(), stop(), requestData(), chunks: [], startedAt }
    this.now = opts.now || Date.now;
    this.runMs = opts.runMs || 45000;
    this.staggerMs = opts.staggerMs || Math.floor(this.runMs / 2);
    this.minMs = opts.minMs || 8000;
    this.slots = [];
    this.startedAt = 0;
  }
  ClipBuffer.prototype._open = function () {
    const r = this.makeRecorder();
    r.startedAt = this.now(); r.start();
    this.slots.push(r); return r;
  };
  ClipBuffer.prototype.start = function () { this.startedAt = this.now(); this.slots = []; this._open(); };
  ClipBuffer.prototype.tick = function () {
    const t = this.now();
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (t - s.startedAt >= this.runMs) { try { s.stop(); } catch (_) {} this.slots.splice(i, 1, null); }
    }
    this.slots = this.slots.filter(Boolean);
    while (this.slots.length < 2 && (this.slots.length === 0 || t - this.startedAt >= this.staggerMs)) this._open();
  };
  /** The longest-running recorder that has at least minMs of video, or null. */
  ClipBuffer.prototype.pick = function () {
    const t = this.now(); let best = null;
    for (const s of this.slots) if (t - s.startedAt >= this.minMs && (!best || s.startedAt < best.startedAt)) best = s;
    return best;
  };
  ClipBuffer.prototype.stop = function () { for (const s of this.slots) { try { s.stop(); } catch (_) {} } this.slots = []; };
  if (typeof module !== 'undefined' && module.exports) module.exports = ClipBuffer; else root.ClipBuffer = ClipBuffer;
})(typeof window !== 'undefined' ? window : globalThis);
