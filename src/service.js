import { createDay, applyMessage, applyVoice } from './domain.js';
import { dayKey, splitDays } from './time.js';

export class QuestService {
  constructor(store, config, clock = Date.now) { this.store = store; this.config = config; this.clock = clock; }
  async day(userId, at = this.clock()) {
    const day = dayKey(at);
    const id = `${this.config.clanGuildId}:${day}:${userId}`;
    const existing = await this.store.getDay(id);
    if (existing) return existing;
    return this.store.ensureDay(createDay(this.config.clanGuildId, userId, day, await this.store.templates(), at));
  }
  async message(event) {
    const now = this.clock();
    if (event.guildId !== this.config.arenaGuildId || event.bot || !event.eligible
        || !/^\d{17,20}$/.test(event.id) || !Number.isFinite(event.at)
        || event.at > now + 5000 || now - event.at > 120000) return null;
    const state = await this.day(event.userId, event.at);
    return this.store.mutateDay(state._id, draft => applyMessage(draft, event, this.config));
  }
  async voice(event, rule) {
    if (event.guildId !== this.config.arenaGuildId || !event.eligible || !event.channelId
      || !Number.isFinite(event.from) || !Number.isFinite(event.to)
      || event.to - event.from > 60000 || event.to <= event.from || event.to > this.clock() + 5000) return;
    for (const part of splitDays(event.from, event.to)) {
      const state = await this.day(event.userId, part.from);
      await this.store.mutateDay(state._id, draft => applyVoice(draft, { ...event, ...part }, rule));
    }
  }
}
