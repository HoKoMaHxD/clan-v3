import { eligibleVoice } from './domain.js';

export class VoiceTracker {
  constructor({ service, guildId, onError = () => {} }) {
    this.service = service;
    this.guildId = guildId;
    this.onError = onError;
    this.snapshot = [];
    this.rule = null;
    this.last = null;
    this.epoch = 0;
    this.tail = Promise.resolve();
  }
  enqueue(action) {
    const epoch = this.epoch;
    const operation = this.tail.then(() => epoch === this.epoch ? action() : undefined);
    this.tail = operation.catch(error => {
      this.drop();
      this.onError(error);
    });
    return operation;
  }
  transition(snapshot, rule, memberIds, at) {
    const eligible = eligibleVoice(snapshot, rule, memberIds);
    const epoch = this.epoch;
    return this.enqueue(async () => {
      await this.flush(at);
      if (epoch !== this.epoch) return;
      this.snapshot = eligible;
      this.rule = structuredClone(rule);
      this.last = at;
    });
  }
  tick(at) { return this.enqueue(() => this.flush(at)); }
  async flush(at) {
    const from = this.last;
    this.last = at;
    // A stalled loop/disconnection must not turn into guessed attendance.
    if (from === null || at <= from || at - from > 60000 || !this.rule) return;
    const epoch = this.epoch;
    for (const member of this.snapshot) {
      if (epoch !== this.epoch) return;
      await this.service.voice({
        guildId: this.guildId, userId: member.userId, channelId: member.channelId,
        from, to: at, eligible: true
      }, this.rule);
    }
  }
  drop() { this.epoch++; this.snapshot = []; this.last = null; this.rule = null; }
  async drain() { await this.tail; }
}
