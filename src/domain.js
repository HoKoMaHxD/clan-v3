import { createHash } from 'node:crypto';
import { isId } from './config.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const normalizeMessage = text => String(text || '').normalize('NFKC')
  .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

export function validateTemplate(task) {
  if (!task.title || typeof task.title !== 'string' || task.title.length > 100) throw new Error('اسم المهمة مطلوب (حتى 100 حرف).');
  if (!['messages', 'voice'].includes(task.type)) throw new Error('نوع المهمة غير مدعوم.');
  if (!isId(task.channelId)) throw new Error('ID الروم غير صحيح.');
  for (const [name, value, max] of [['target', task.target, 100000], ['reward', task.reward, 100000], ['repeat', task.repeat, 20]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`قيمة ${name} يجب أن تكون بين 1 و${max}.`);
  }
  if (task.type === 'voice' && task.target > 1440) throw new Error('الحد الأعلى للمهمة الصوتية 1440 دقيقة.');
  if (task.forUser && !isId(task.forUser)) throw new Error('عضو المهمة غير صالح.');
  return task;
}

export function seedTemplates(config) {
  const messageTasks = [25, 50, 100, 150, 200].map(n => ({
    id: `msg-${n}`, title: `أرسل ${n} رسالة في الشات العام`, type: 'messages',
    channelId: config.generalChannelId, target: n, reward: n
  }));
  const voiceTasks = [10, 20, 30].map(n => ({
    id: `voice-${n}`, title: `تواجد ${n} دقيقة في روم الكلان`, type: 'voice',
    channelId: config.voiceChannelId, target: n, reward: n * 2
  }));
  return [...messageTasks, ...voiceTasks].map(t => ({ ...t, repeat: 1, enabled: true, forUser: null }));
}

export function createDay(clanId, userId, day, templates, at) {
  // Targeted templates get priority, then a stable daily per-member shuffle.
  const rank = t => hash(`${clanId}:${userId}:${day}:${t.id}`);
  const tasks = templates.filter(t => t.enabled && (!t.forUser || t.forUser === userId))
    .sort((a, b) => Number(!!b.forUser) - Number(!!a.forUser) || rank(a).localeCompare(rank(b)))
    .slice(0, 5).map(t => ({
      id: t.id, title: t.title, type: t.type, channelId: t.channelId,
      target: t.target, reward: t.reward, repeat: t.repeat, enabled: t.enabled,
      forUser: t.forUser || null, progress: 0, completed: 0
    }));
  return {
    _id: `${clanId}:${day}:${userId}`, clanId, userId, day, revision: 0, createdAt: at,
    tasks, points: { tasks: 0, attendance: 0 }, completionLog: [],
    lastMessage: null, recentHashes: [], voiceUntil: 0,
    attendance: { milliseconds: 0, ruleVersion: null, carryMs: 0 }
  };
}

export function advanceTasks(state, type, channelId, amount, at) {
  for (const task of state.tasks) {
    if (task.type !== type || task.channelId !== channelId) continue;
    const targetUnits = task.target * (type === 'voice' ? 60000 : 1);
    task.progress = Math.min(targetUnits * task.repeat, task.progress + amount);
    const earnedCycles = Math.min(task.repeat, Math.floor(task.progress / targetUnits));
    for (let cycle = task.completed + 1; cycle <= earnedCycles; cycle++) {
      state.points.tasks += task.reward;
      state.completionLog.push({ taskId: task.id, cycle, points: task.reward, at });
    }
    task.completed = earnedCycles;
  }
}

export function applyMessage(state, event, config) {
  if (!state.tasks.some(t => t.type === 'messages' && t.channelId === event.channelId && t.completed < t.repeat)) return false;
  const text = normalizeMessage(event.content);
  if (text.length < config.minMessageLength || !/[\p{L}\p{N}]/u.test(text)) return false;
  const last = state.lastMessage;
  if (last && (event.at - last.at < config.cooldownMs || BigInt(event.id) <= BigInt(last.id))) return false;
  const digest = hash(text);
  const recent = state.recentHashes.filter(item => event.at - item.at < 600000);
  if (recent.some(item => item.hash === digest)) return false;
  state.lastMessage = { id: event.id, at: event.at };
  state.recentHashes = [...recent, { hash: digest, at: event.at }].slice(-100);
  advanceTasks(state, 'messages', event.channelId, 1, event.at);
  return true;
}

export function applyVoice(state, event, rule) {
  const from = Math.max(event.from, state.voiceUntil || 0);
  if (event.to <= from) return false;
  const amount = event.to - from;
  state.voiceUntil = event.to;
  advanceTasks(state, 'voice', event.channelId, amount, event.to);
  if (event.channelId === rule.channelId && rule.enabled) {
    const attendance = state.attendance;
    attendance.milliseconds += amount;
    if (attendance.ruleVersion !== rule.version) {
      attendance.ruleVersion = rule.version;
      attendance.carryMs = 0;
    }
    attendance.carryMs += amount;
    const cycles = Math.floor(attendance.carryMs / rule.intervalMs);
    attendance.carryMs %= rule.intervalMs;
    state.points.attendance += Math.max(0, Math.min(cycles * rule.points, rule.dailyCap - state.points.attendance));
  }
  return true;
}

export function eligibleVoice(snapshot, rule, memberIds) {
  const humanCount = new Map();
  for (const entry of snapshot) {
    if (entry.channelId && !entry.bot) humanCount.set(entry.channelId, (humanCount.get(entry.channelId) || 0) + 1);
  }
  return snapshot.filter(entry => entry.channelId && !entry.bot && memberIds.has(entry.userId)
    && !entry.afk && !entry.suppressed
    && (!rule.ignoreMuted || !entry.muted)
    && (!rule.ignoreDeafened || !entry.deafened)
    && humanCount.get(entry.channelId) >= rule.minPeople);
}
