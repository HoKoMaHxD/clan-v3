import { createServer } from 'node:http';
import { setTimeout as taskDelay } from 'node:timers/promises';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { readConfig } from './config.js';
import { loginReady } from './auth.js';
import { MongoStore } from './store.js';
import { QuestService } from './service.js';
import { VoiceTracker } from './voice.js';
import { buildCommands, createHandler, checkSourceChannel } from './commands.js';
import { PanelManager, createSetupMessageHandler } from './panel.js';

let config;
try { config = readConfig(); }
catch (error) { console.error(error.message); process.exit(1); }
for (const warning of config.authWarnings) console.warn(`[auth:config] ${warning}`);

function logError(scope, error) {
  let message = String(error?.message || 'Unknown error');
  for (const secret of [config.botToken, config.userToken, config.mongoUri].filter(Boolean)) message = message.split(secret).join('[REDACTED]');
  message = message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_DB_URI]');
  console.error(`[${scope}] ${String(error?.name || 'Error')}: ${message.slice(0, 500)}`);
}

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
if (config.mode === 'official') intents.push(GatewayIntentBits.GuildVoiceStates);
const bot = new Client({ intents });
let source = bot;
if (config.mode === 'selfbot') {
  const { default: Selfbot } = await import('discord.js-selfbot-v13');
  // No token extraction, captcha solving, sending, joining, invitations or voice connection.
  // This client is ONLY used as an event source for already-accessible Arena channels.
  source = new Selfbot.Client({
    makeCache: Selfbot.Options.cacheWithLimits({ MessageManager: 0 }),
    captchaRetryLimit: 0
  });
  console.warn('تحذير: تشغيل حساب عادي آليًا يخالف شروط Discord وقد يؤدي إلى إغلاق الحساب. مكتبة القارئ مؤرشفة وغير مضمونة التوافق.');
}

const store = new MongoStore(config);
const service = new QuestService(store, config);
const members = new Set();
let membershipReady = false;
let leaseHeld = false;
let stopping = false;
let settings;
let trackedChannels = new Set();
let lastMessageAt = null;
let lastVoiceAt = null;
let voiceTimer;
let leaseTimer;
let panelTimer;
let http;
let reconnecting = false;
const inflight = new Set();

const status = () => ({
  bot: bot.isReady(), observer: source.isReady(),
  tracking: !stopping && leaseHeld && membershipReady && bot.isReady() && source.isReady()
    && !!source.guilds.cache.get(config.arenaGuildId) && source.guilds.cache.get(config.arenaGuildId).available !== false,
  memberCount: members.size, lastMessageAt, lastVoiceAt
});

const tracker = new VoiceTracker({ service, guildId: config.arenaGuildId, onError: error => logError('voice', error) });
const panel = new PanelManager({ bot, store, guildId: config.clanGuildId,
  canRun: () => leaseHeld && !stopping && bot.isReady(), onError: error => logError('panel', error) });
const setupMessage = createSetupMessageHandler({ config, panel, onError: error => logError('setup', error) });

function run(scope, promise) {
  const tracked = Promise.resolve(promise).catch(error => logError(scope, error)).finally(() => inflight.delete(tracked));
  inflight.add(tracked);
  return tracked;
}

function qualify(member) {
  return !member.user.bot && (!config.memberRole || member.roles.cache.has(config.memberRole));
}

function voiceSnapshot() {
  const guild = source.guilds.cache.get(config.arenaGuildId);
  if (!guild) return [];
  return [...guild.voiceStates.cache.values()]
    .filter(state => state.channelId && trackedChannels.has(state.channelId)
      && guild.channels.cache.get(state.channelId)?.permissionsFor(source.user)?.has(1024n))
    .map(state => ({
      userId: state.id, channelId: state.channelId,
      bot: state.member?.user?.bot ?? source.users.cache.get(state.id)?.bot ?? true,
      muted: !!(state.selfMute || state.serverMute), deafened: !!(state.selfDeaf || state.serverDeaf),
      suppressed: !!state.suppress, afk: state.channelId === guild.afkChannelId
    }));
}

function transitionVoice(at = Date.now()) {
  if (!status().tracking || !settings) { tracker.drop(); return Promise.resolve(); }
  return tracker.transition(voiceSnapshot(), settings.attendance, new Set(members), at);
}

async function refreshSettings() {
  // Flush under the previous rules before applying the new rules to future samples.
  if (status().tracking) await tracker.tick(Date.now());
  settings = await store.settings();
  const templates = await store.templates();
  // Include disabled templates: they can still exist in today's immutable assignments.
  trackedChannels = new Set([settings.attendance.channelId, config.voiceChannelId,
    ...templates.filter(t => t.type === 'voice').map(t => t.channelId)]);
  await transitionVoice();
}

async function loadMembers() {
  membershipReady = false;
  tracker.drop();
  const guild = bot.guilds.cache.get(config.clanGuildId);
  if (!guild) throw new Error('البوت الرسمي غير موجود في سيرفر الكلان المحدد.');
  if (config.memberRole && !guild.roles.cache.has(config.memberRole)) throw new Error('رتبة CLAN_MEMBER_ROLE_ID غير موجودة في سيرفر الكلان.');
  const loaded = await guild.members.fetch({ time: 60000 });
  members.clear();
  for (const member of loaded.values()) if (qualify(member)) members.add(member.id);
  membershipReady = true;
}

const handler = createHandler({
  config, service, store, isMember: id => membershipReady && members.has(id),
  validateChannel: (id, type) => checkSourceChannel(source, config.arenaGuildId, id, type),
  refreshSettings, status, panel, onError: error => logError('command', error)
});

bot.on(Events.InteractionCreate, interaction => {
  if (!leaseHeld || stopping) return;
  run('interaction', handler(interaction));
});
bot.on(Events.MessageCreate, message => {
  if (leaseHeld && !stopping) run('setup', setupMessage(message));
});
for (const event of [Events.GuildMemberAdd, Events.GuildMemberUpdate, Events.GuildMemberRemove]) {
  bot.on(event, (old, updated) => {
    const member = updated || old;
    if (member.guild.id !== config.clanGuildId) return;
    if (event !== Events.GuildMemberRemove && qualify(member)) members.add(member.id);
    else members.delete(member.id);
    run('member-voice', transitionVoice());
  });
}
bot.on(Events.GuildRoleDelete, role => {
  if (role.guild.id === config.clanGuildId && role.id === config.memberRole) {
    members.clear(); membershipReady = false; tracker.drop();
    console.error('توقف الرصد: حذفت رتبة أعضاء الكلان المحددة.');
  }
});

source.on('messageCreate', message => {
  if (!status().tracking || message.guildId !== config.arenaGuildId || message.author?.bot
    || message.webhookId || !members.has(message.author?.id)) return;
  run('message', service.message({
    guildId: message.guildId, channelId: message.channelId, userId: message.author.id,
    id: message.id, at: message.createdTimestamp, content: message.content,
    bot: false, eligible: true
  }).then(state => {
    if (state?.lastMessage?.id === message.id) lastMessageAt = message.createdTimestamp;
  }));
});
source.on('voiceStateUpdate', (old, next) => {
  if (next.guild.id !== config.arenaGuildId) return;
  run('voice-transition', transitionVoice());
});
source.on('channelUpdate', (old, next) => {
  if (next.guild?.id === config.arenaGuildId) run('channel-voice', transitionVoice());
});
source.on('channelDelete', channel => {
  if (channel.guild?.id === config.arenaGuildId) run('channel-voice', transitionVoice());
});

for (const client of new Set([bot, source])) {
  client.on('error', error => logError(client === bot ? 'bot' : 'observer', error));
  client.on('shardError', error => { tracker.drop(); logError(client === bot ? 'gateway:bot' : 'gateway:observer', error); });
  for (const event of ['shardDisconnect', 'shardReconnecting']) client.on(event, () => {
    tracker.drop();
    if (client === bot) membershipReady = false;
  });
  for (const event of ['shardResume', 'shardReady']) client.on(event, () => {
    if (!leaseHeld || !settings || reconnecting || !bot.isReady() || !source.isReady()) return;
    reconnecting = true;
    run('reconnect', (async () => {
      try { await loadMembers(); await transitionVoice(); }
      finally { reconnecting = false; }
    })());
  });
  client.on('invalidated', () => { void shutdown(1, false); });
}

async function shutdown(code = 0, flush = true) {
  if (stopping) return;
  // Stop accepting events but allow the bounded final observed interval to commit.
  stopping = true;
  clearInterval(voiceTimer); clearInterval(leaseTimer); clearInterval(panelTimer);
  const deadline = setTimeout(() => process.exit(code || 1), 12000);
  deadline.unref();
  try {
    if (flush && leaseHeld && bot.isReady() && source.isReady() && membershipReady) await tracker.tick(Date.now());
    else tracker.drop();
    await tracker.drain();
    await panel.drain();
    for (const client of new Set([bot, source])) await client.destroy();
    await Promise.allSettled([...inflight]);
    if (leaseHeld) await store.releaseLease();
    await store.close();
    http?.close();
  } catch (error) { logError('shutdown', error); }
  clearTimeout(deadline);
  process.exit(code);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('unhandledRejection', error => { logError('unhandled', error); void shutdown(1, false); });
process.on('uncaughtException', error => { logError('uncaught', error); void shutdown(1, false); });

try {
  await store.connect();
  leaseHeld = await store.acquireLease();
  // A Render worker rolling deployment may briefly overlap with the previous process.
  for (let attempt = 0; !leaseHeld && attempt < 24 && !stopping; attempt++) {
    if (attempt === 0) console.log('بانتظار إغلاق النسخة السابقة وتحرير قفل التشغيل...');
    await taskDelay(5000);
    leaseHeld = await store.acquireLease();
  }
  if (!leaseHeld) throw new Error('هناك نسخة أخرى تعمل لنفس الكلان. أوقفها وانتظر 45 ثانية ثم أعد النشر.');
  let leaseBusy = false;
  leaseTimer = setInterval(() => {
    if (leaseBusy || stopping) return;
    leaseBusy = true;
    run('lease', (async () => {
      try {
        if (!await store.acquireLease()) throw new Error('فقدت النسخة قفل التشغيل.');
      } catch (error) {
        leaseHeld = false; tracker.drop(); logError('lease', error);
        // Do not await shutdown inside inflight, which shutdown itself drains.
        void shutdown(1, false);
      } finally { leaseBusy = false; }
    })());
  }, 10000);
  settings = await store.settings();
  await loginReady(bot, config.botToken, Events.ClientReady, 'bot');
  if (source !== bot) await loginReady(source, config.userToken, 'ready', 'observer');
  if (!source.guilds.cache.has(config.arenaGuildId)) throw new Error('حساب القارئ غير موجود في سيرفر أرينا المحدد. لا يمكن متابعة سيرفر لا يملك الحساب وصولًا إليه.');
  await loadMembers();
  await refreshSettings();
  for (const [id, type] of [[config.generalChannelId, 'messages'], [settings.attendance.channelId, 'voice']]) {
    try { await checkSourceChannel(source, config.arenaGuildId, id, type); }
    catch (error) { logError('channel-configuration', error); }
  }
  // Only replaces this new application's clan-guild commands, never global/other-guild commands.
  await bot.application.commands.set(buildCommands(), config.clanGuildId);
  // Persistent custom IDs are handled above; no expiring collectors are used.
  // Recover a due or missing saved panel once, rather than replaying every missed interval.
  await run('panel-restore', panel.tick({ checkMessage: true }));
  panelTimer = setInterval(() => {
    run('panel-refresh', panel.tick({ checkMessage: true }));
  }, 30000);
  let voiceBusy = false;
  voiceTimer = setInterval(() => {
    if (voiceBusy || stopping) return;
    voiceBusy = true;
    run('voice-tick', (async () => {
      try {
        if (!membershipReady && bot.isReady() && source.isReady()) await loadMembers();
        if (!status().tracking) { tracker.drop(); return; }
        // Refresh membership/permission-derived eligibility without assuming gateway completeness.
        await transitionVoice();
        lastVoiceAt = Date.now();
      } finally { voiceBusy = false; }
    })());
  }, 15000);
  if (config.port) {
    http = createServer((request, response) => {
      const healthy = status().tracking;
      response.writeHead(request.url === '/health' || request.url === '/' ? (healthy ? 200 : 503) : 404,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: healthy }));
    });
    http.listen(config.port, '0.0.0.0');
  }
  console.log(`جاهز: ${members.size} عضو مؤهل. الأوامر مسجلة في سيرفر الكلان. راجع /حالة_البوت ثم اختبر /مهامي.`);
} catch (error) { logError(error.scope || 'startup', error); await shutdown(1, false); }
