import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { seedTemplates } from './domain.js';
import { periodStart, dayKey } from './time.js';

export class MongoStore {
  constructor(config) {
    this.config = config;
    this.client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 10 });
    this.db = this.client.db(config.dbName);
    this.owner = randomUUID();
    this.settingsId = `settings:${config.clanGuildId}`;
    this.leaseId = `worker:${config.clanGuildId}`;
  }
  async connect() {
    await this.client.connect();
    await this.db.collection('days').createIndex({ clanId: 1, day: 1, userId: 1 });
    await this.db.collection('templates').createIndex({ clanId: 1, id: 1 }, { unique: true });
    await this.db.collection('settings').updateOne({ _id: this.settingsId }, {
      $setOnInsert: { attendance: this.config.attendance, seeded: false }
    }, { upsert: true });
    const settings = await this.settings();
    if (!settings.seeded) {
      for (const task of seedTemplates(this.config)) {
        await this.db.collection('templates').updateOne({ clanId: this.config.clanGuildId, id: task.id }, {
          $setOnInsert: { ...task, clanId: this.config.clanGuildId }
        }, { upsert: true });
      }
      await this.db.collection('settings').updateOne({ _id: this.settingsId }, { $set: { seeded: true } });
    }
  }
  async acquireLease(now = Date.now()) {
    try {
      const record = await this.db.collection('leases').findOneAndUpdate({
        _id: this.leaseId, $or: [{ owner: this.owner }, { expiresAt: { $lte: now } }]
      }, { $set: { owner: this.owner, expiresAt: now + 45000 } }, { upsert: true, returnDocument: 'after' });
      return record?.owner === this.owner;
    } catch (error) { if (error.code === 11000) return false; throw error; }
  }
  async releaseLease() {
    await this.db.collection('leases').deleteOne({ _id: this.leaseId, owner: this.owner });
  }
  async settings() { return this.db.collection('settings').findOne({ _id: this.settingsId }); }
  async getPanel() { return this.db.collection('panels').findOne({ _id: `panel:${this.config.clanGuildId}` }); }
  async savePanel(panel) {
    const _id = `panel:${this.config.clanGuildId}`;
    await this.db.collection('panels').replaceOne({ _id }, { ...panel, _id }, { upsert: true });
  }
  async setAttendance(fields) {
    const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`attendance.${k}`, v]));
    return this.db.collection('settings').findOneAndUpdate({ _id: this.settingsId }, {
      $set: set, $inc: { 'attendance.version': 1 }
    }, { returnDocument: 'after' });
  }
  async templates() {
    return this.db.collection('templates').find({ clanId: this.config.clanGuildId }).sort({ id: 1 }).toArray();
  }
  async addTemplate(task) {
    await this.db.collection('templates').insertOne({ ...task, clanId: this.config.clanGuildId });
  }
  async updateTemplate(id, fields) {
    return this.db.collection('templates').findOneAndUpdate({ clanId: this.config.clanGuildId, id }, {
      $set: fields
    }, { returnDocument: 'after' });
  }
  async ensureDay(initial) {
    try { await this.db.collection('days').insertOne(initial); }
    catch (error) { if (error.code !== 11000) throw error; }
    return this.db.collection('days').findOne({ _id: initial._id });
  }
  async getDay(id) { return this.db.collection('days').findOne({ _id: id }); }
  // Points and task progress commit in ONE atomic document replacement. No split credit writes.
  async mutateDay(id, mutation) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const original = await this.getDay(id);
      if (!original) throw new Error('سجل اليوم غير موجود.');
      const next = structuredClone(original);
      if (!mutation(next)) return original;
      next.revision = original.revision + 1;
      const saved = await this.db.collection('days').replaceOne({ _id: id, revision: original.revision }, next);
      if (saved.matchedCount === 1) return next;
    }
    throw new Error('ضغط متزامن على سجل العضو؛ حاول مجددًا.');
  }
  async totals(userId, period, at) {
    const rows = await this.ranking(period, 'total', at, { userId, limit: 1 });
    return rows[0] || { tasks: 0, attendance: 0, total: 0, milliseconds: 0 };
  }
  async ranking(period, category, at, { userId, limit = 10, skip = 0 } = {}) {
    const match = { clanId: this.config.clanGuildId,
      day: { $gte: periodStart(period, at, this.config.weekStart), $lte: dayKey(at) } };
    if (userId) match.userId = userId;
    const score = ['tasks', 'attendance'].includes(category) ? category : 'total';
    return this.db.collection('days').aggregate([
      { $match: match },
      { $group: { _id: '$userId', tasks: { $sum: '$points.tasks' }, attendance: { $sum: '$points.attendance' }, milliseconds: { $sum: '$attendance.milliseconds' } } },
      { $addFields: { total: { $add: ['$tasks', '$attendance'] } } },
      ...(!userId ? [{ $match: { [score]: { $gt: 0 } } }] : []),
      { $sort: { [score]: -1, _id: 1 } }, { $skip: skip }, { $limit: limit }
    ]).toArray();
  }
  async close() { await this.client.close(); }
}
