import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoStore } from '../src/store.js';
import { QuestService } from '../src/service.js';
import { createDay, applyMessage } from '../src/domain.js';
import { dayStart } from '../src/time.js';

test('real local MongoDB: atomic credits, duplicate events, leases, restart and rankings', async t => {
  // Deliberately no MONGODB_URI read: tests cannot touch the user's real database.
  const mongod = await MongoMemoryServer.create();
  const now = dayStart('2026-09-06') + 3600000;
  const config = {
    mongoUri: mongod.getUri(), dbName: `clan_quests_test_${randomUUID().replaceAll('-', '')}`,
    clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
    generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
    cooldownMs: 10000, minMessageLength: 3, weekStart: 0,
    attendance: { enabled: true, channelId: '100000000000000004', intervalMs: 60000, points: 10, dailyCap: 500, version: 1 }
  };
  const store = new MongoStore(config);
  const competitor = new MongoStore(config);
  try {
    await store.connect();
    await competitor.client.connect();
    await t.test('singleton lease excludes concurrent workers and releases cleanly', async () => {
      assert.equal(await store.acquireLease(now), true);
      assert.equal(await competitor.acquireLease(now), false);
      assert.equal(await store.acquireLease(now + 1000), true);
      await store.releaseLease();
      assert.equal(await competitor.acquireLease(now + 2000), true);
      await competitor.releaseLease();
    });
    await t.test('bootstrap never overwrites database settings or duplicates seeds', async () => {
      assert.equal((await store.templates()).length, 8);
      await store.setAttendance({ points: 77 });
      await store.connect();
      assert.equal((await store.settings()).attendance.points, 77);
      assert.equal((await store.templates()).length, 8);
    });
    const user = '100000000000000005';
    const initial = createDay(config.clanGuildId, user, '2026-09-06', [{
      id: 'test', title: 'test', type: 'messages', channelId: config.generalChannelId,
      target: 1, repeat: 1, reward: 100, enabled: true
    }], now);
    await t.test('concurrent first-use creates one daily snapshot', async () => {
      await Promise.all(Array.from({ length: 10 }, () => store.ensureDay(structuredClone(initial))));
      assert.equal(await store.db.collection('days').countDocuments({ _id: initial._id }), 1);
    });
    await t.test('concurrent duplicate completions credit a reward exactly once', async () => {
      const event = { id: '200000000000000001', channelId: config.generalChannelId, at: now, content: 'اختبار المهمة' };
      await Promise.all(Array.from({ length: 20 }, () => store.mutateDay(initial._id, draft => applyMessage(draft, event, config))));
      const saved = await store.getDay(initial._id);
      assert.equal(saved.points.tasks, 100);
      assert.equal(saved.completionLog.length, 1);
      assert.equal(saved.tasks[0].completed, 1);
    });
    await t.test('concurrent independent document changes survive revision retries', async () => {
      await Promise.all(Array.from({ length: 10 }, () => store.mutateDay(initial._id, draft => {
        draft.points.attendance++; return true;
      })));
      const saved = await store.getDay(initial._id);
      assert.equal(saved.points.attendance, 10);
      assert.equal(saved.points.tasks, 100);
    });
    await t.test('reopening storage preserves progress and points', async () => {
      const reopened = new QuestService(competitor, config, () => now);
      assert.equal((await reopened.day(user)).points.tasks, 100);
    });
    await t.test('leaderboards separate calendar periods and point categories', async () => {
      const previous = createDay(config.clanGuildId, user, '2026-09-05', [], now - 86400000);
      previous.points = { tasks: 50, attendance: 5 };
      await store.ensureDay(previous);
      const lastMonth = createDay(config.clanGuildId, user, '2026-08-31', [], now - 6 * 86400000);
      lastMonth.points = { tasks: 500, attendance: 0 };
      await store.ensureDay(lastMonth);
      const another = createDay(config.clanGuildId, '100000000000000099', '2026-09-06', [], now);
      another.points = { tasks: 1, attendance: 30 };
      await store.ensureDay(another);
      assert.equal((await store.totals(user, 'daily', now)).total, 110);
      assert.equal((await store.totals(user, 'weekly', now)).total, 110);
      assert.equal((await store.totals(user, 'monthly', now)).total, 165);
      assert.equal((await store.totals(user, 'all', now)).total, 665);
      assert.equal((await store.ranking('daily', 'tasks', now))[0]._id, user);
      assert.equal((await store.ranking('daily', 'attendance', now))[0]._id, another.userId);
      assert.equal((await store.ranking('daily', 'total', now, { skip: 1 }))[0]._id, another.userId);
    });
  } finally {
    await store.close(); await competitor.close(); await mongod.stop();
  }
});
