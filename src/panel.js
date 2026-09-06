import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';

export const PANEL_PREFIX = 'clan-panel:v1:';
export const TOP_PREFIX = 'clan-top:v1:';
export const DEFAULT_PANEL_MINUTES = 60;

export function validateInterval(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1440) throw new Error('مدة تجديد اللوحة يجب أن تكون من 1 إلى 1440 دقيقة.');
  return value;
}

export function parseSetup(text) {
  const normalized = String(text || '').trim().replace(/[٠-٩]/g, x => String(x.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, x => String(x.charCodeAt(0) - 0x6f0));
  const match = /^setup(?:\s+(\S+))?$/i.exec(normalized);
  if (!match) return null;
  return { minutes: match[1] === undefined ? DEFAULT_PANEL_MINUTES : Number(match[1]) };
}

export function parsePanelAction(id) {
  const main = /^clan-panel:v1:(total|attendance|tasks|mine)$/.exec(id || '');
  if (main) return main[1] === 'mine' ? { kind: 'mine', update: false }
    : { kind: 'top', category: main[1], period: 'all', page: 1, update: false };
  const top = /^clan-top:v1:(\d{17,20}):(total|attendance|tasks):(daily|weekly|monthly|all):(\d{1,3})(?::(?:period|previous|next))?$/.exec(id || '');
  if (top && Number(top[4]) >= 1 && Number(top[4]) <= 100) {
    return { kind: 'top', ownerId: top[1], category: top[2], period: top[3], page: Number(top[4]), update: true };
  }
  return null;
}

export function panelPayload(minutes) {
  return {
    allowedMentions: { parse: [] },
    embeds: [new EmbedBuilder().setColor(0x99ddff).setTitle('❄️ لوحة مهام الكلان')
      .setDescription('تابع تقدمك ونافس أعضاء الكلان على النقاط.\n\n'
        + '🏆 **التوب الشامل** — مجموع نقاط المهام والفويس\n'
        + '🎙️ **توب الفويس** — نقاط التواجد في روم الكلان\n'
        + '🎯 **توب المهمات** — نقاط إنجاز المهام\n'
        + '📋 **مهامي** — مهامك اليومية وتقدمك أنت\n\n'
        + 'اضغط الزر المناسب. النتائج تظهر لك وحدك، ويمكنك اختيار فترة الترتيب.')
      .setFooter({ text: `تتجدد هذه الرسالة كل ${minutes} دقيقة • المهام تتجدد منتصف الليل بتوقيت السعودية` })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PANEL_PREFIX}total`).setLabel('التوب الشامل').setEmoji('🏆').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PANEL_PREFIX}attendance`).setLabel('توب الفويس').setEmoji('🎙️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${PANEL_PREFIX}tasks`).setLabel('توب المهمات').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${PANEL_PREFIX}mine`).setLabel('مهامي').setEmoji('📋').setStyle(ButtonStyle.Success)
    )]
  };
}

function isOurPanel(message, botId) {
  return message.author?.id === botId && message.components?.some(row => row.components?.some(button =>
    [ `${PANEL_PREFIX}total`, `${PANEL_PREFIX}attendance`, `${PANEL_PREFIX}tasks`, `${PANEL_PREFIX}mine` ]
      .includes(button.customId ?? button.custom_id)));
}
const missing = error => [10008, 10003].includes(Number(error?.code));

// A single durable panel per clan. All setup/timer operations share one queue.
export class PanelManager {
  constructor({ bot, store, guildId, canRun = () => true, clock = Date.now, onError = () => {} }) {
    Object.assign(this, { bot, store, guildId, canRun, clock, onError });
    this.tail = Promise.resolve();
    this.tickPending = false;
  }
  queue(work) {
    const result = this.tail.then(() => {
      if (!this.canRun()) return null;
      return work();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async channel(id, publishing = false) {
    const channel = await this.bot.channels.fetch(id);
    if (!channel || channel.guildId !== this.guildId || channel.type !== ChannelType.GuildText) {
      throw new Error('اختر رومًا كتابيًا عاديًا في سيرفر الكلان للوحة setup.');
    }
    const permissions = channel.permissionsFor(this.bot.user);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    if (publishing) required.push(PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks);
    if (!permissions?.has(required)) throw new Error('البوت يحتاج مشاهدة الروم وقراءة سجل الرسائل وإرسال الرسائل وتضمين الروابط في روم اللوحة.');
    return channel;
  }
  async remove(ref) {
    try {
      const channel = await this.channel(ref.channelId);
      const message = await channel.messages.fetch(ref.messageId);
      if (!isOurPanel(message, this.bot.user.id)) throw new Error('رفض حذف رسالة ليست لوحة المهام الخاصة بهذا البوت.');
      await message.delete();
    } catch (error) { if (!missing(error)) throw error; }
  }
  async cleanup(state) {
    const pending = [];
    for (const ref of state.staleMessages || []) {
      // Never delete the current panel, even if a malformed old record lists it.
      if (ref.messageId === state.messageId && ref.channelId === state.channelId) continue;
      try { await this.remove(ref); }
      catch (error) { this.onError(error); pending.push(ref); }
    }
    if (pending.length !== (state.staleMessages || []).length) {
      state = { ...state, staleMessages: pending };
      await this.store.savePanel(state);
    }
    return state;
  }
  async publish(channelId, minutes, previous) {
    const channel = await this.channel(channelId, true);
    if (previous) {
      previous = await this.cleanup(previous);
      if (previous.staleMessages?.length) throw new Error('تعذر تنظيف لوحة سابقة. أصلح صلاحيات الروم السابق قبل إرسال لوحة إضافية.');
    }
    if (!this.canRun()) return null;
    // Keep the old usable panel until a replacement has been sent AND saved.
    const message = await channel.send(panelPayload(minutes));
    const created = this.clock();
    const state = {
      channelId, messageId: message.id, intervalMinutes: minutes,
      nextRefreshAt: created + minutes * 60000,
      staleMessages: previous?.messageId ? [{ channelId: previous.channelId, messageId: previous.messageId }] : []
    };
    try { await this.store.savePanel(state); }
    catch (error) {
      // A timed-out Mongo write might have committed. Check before rolling back.
      let saved;
      try { saved = await this.store.getPanel(); } catch { /* preserve both if the outcome is unknown */ }
      if (saved?.messageId !== message.id) {
        if (saved !== undefined) {
          try { await this.remove({ channelId, messageId: message.id }); }
          catch (rollbackError) { this.onError(rollbackError); }
        }
        throw error;
      }
    }
    return this.cleanup(state);
  }
  setup(channelId, minutes = DEFAULT_PANEL_MINUTES) {
    validateInterval(minutes);
    return this.queue(async () => this.publish(channelId, minutes, await this.store.getPanel()));
  }
  tick({ checkMessage = false } = {}) {
    if (this.tickPending || !this.canRun()) return Promise.resolve(null);
    this.tickPending = true;
    return this.queue(async () => {
      let state = await this.store.getPanel();
      if (!state) return null;
      state = await this.cleanup(state);
      if (state.staleMessages?.length) return state;
      let gone = false;
      if (checkMessage && this.clock() < state.nextRefreshAt) {
        try {
          const channel = await this.channel(state.channelId);
          const message = await channel.messages.fetch(state.messageId);
          if (!isOurPanel(message, this.bot.user.id)) throw new Error('الرسالة المحفوظة ليست لوحة المهام الحالية.');
        } catch (error) {
          if (Number(error?.code) !== 10008) throw error;
          gone = true;
        }
      }
      if (gone || this.clock() >= state.nextRefreshAt) return this.publish(state.channelId, state.intervalMinutes, state);
      return state;
    }).finally(() => { this.tickPending = false; });
  }
  async drain() { await this.tail; }
}

export function createSetupMessageHandler({ config, panel, onError = () => {} }) {
  return async message => {
    if (message.guildId !== config.clanGuildId || message.author?.bot || message.webhookId) return;
    const parsed = parseSetup(message.content);
    if (!parsed) return;
    const reply = content => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
    const member = message.member || await message.guild.members.fetch(message.author.id);
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await reply('تحتاج صلاحية إدارة السيرفر لاستخدام setup.'); return;
    }
    try {
      validateInterval(parsed.minutes);
      const created = await panel.setup(message.channelId, parsed.minutes);
      if (!created) throw new Error('البوت غير جاهز لتجهيز اللوحة حاليًا.');
      // The panel itself is the success reply; avoid an extra message under it.
    } catch (error) {
      onError(error);
      await reply(/[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تجهيز اللوحة. راجع الصلاحيات والاتصال بقاعدة البيانات.');
    }
  };
}
