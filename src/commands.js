import { randomUUID } from 'node:crypto';
import {
  SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, escapeMarkdown
} from 'discord.js';
import { validateTemplate } from './domain.js';
import { dayKey, nextReset } from './time.js';
import { isId } from './config.js';
import { parsePanelAction, TOP_PREFIX, DEFAULT_PANEL_MINUTES } from './panel.js';

const periods = [
  { name: 'يومي', value: 'daily' }, { name: 'أسبوعي', value: 'weekly' },
  { name: 'شهري', value: 'monthly' }, { name: 'كلي', value: 'all' }
];
const categories = [{ name: 'الإجمالي', value: 'total' }, { name: 'نقاط المهام', value: 'tasks' }, { name: 'نقاط الحضور', value: 'attendance' }];
const periodLabel = p => periods.find(x => x.value === p)?.name || p;
const categoryLabel = p => categories.find(x => x.value === p)?.name || p;
const safe = value => escapeMarkdown(String(value)).replace(/@/g, '@\u200b');
const countOption = (sub, name, desc, max, required = false) => sub.addIntegerOption(o => o.setName(name).setDescription(desc).setMinValue(1).setMaxValue(max).setRequired(required));

export function buildCommands() {
  const setup = new SlashCommandBuilder().setName('setup').setDescription('إرسال لوحة أزرار المهام والتوب وتجديدها تلقائيًا')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('الروم').setDescription('روم اللوحة؛ الافتراضي الروم الحالي').addChannelTypes(ChannelType.GuildText))
    .addIntegerOption(o => o.setName('التجديد').setDescription('كل كم دقيقة تعاد الرسالة؛ الافتراضي 60').setMinValue(1).setMaxValue(1440));
  const tasks = new SlashCommandBuilder().setName('مهامي').setDescription('مهامك اليومية الخمس وتقدمك ومكافآتك');
  const points = new SlashCommandBuilder().setName('نقاطي').setDescription('رصيد نقاط المهام والحضور');
  const board = new SlashCommandBuilder().setName('المتصدرين').setDescription('ترتيب أعضاء الكلان بالنقاط')
    .addStringOption(o => o.setName('الفترة').setDescription('فترة الترتيب').setChoices(...periods))
    .addStringOption(o => o.setName('النوع').setDescription('نوع النقاط').setChoices(...categories))
    .addIntegerOption(o => o.setName('الصفحة').setDescription('10 أعضاء في كل صفحة').setMinValue(1).setMaxValue(100));
  const admin = new SlashCommandBuilder().setName('ادارة_المهام').setDescription('إنشاء وتعديل قوالب المهام اليومية')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => {
      s.setName('اضافة').setDescription('إنشاء قالب مهمة يدخل في الاختيار اليومي');
      s.addStringOption(o => o.setName('الاسم').setDescription('اسم المهمة').setRequired(true).setMaxLength(100));
      s.addStringOption(o => o.setName('النوع').setDescription('نوع الإنجاز').setRequired(true).setChoices(
        { name: 'عدد الرسائل', value: 'messages' }, { name: 'دقائق الصوت', value: 'voice' }));
      s.addStringOption(o => o.setName('الروم').setDescription('ID الروم في أرينا، وليس اسم الروم').setRequired(true));
      countOption(s, 'العدد', 'عدد الرسائل أو الدقائق المطلوب لكل إنجاز', 100000, true);
      countOption(s, 'النقاط', 'مكافأة كل إنجاز كامل', 100000, true);
      countOption(s, 'التكرار', 'عدد مرات مكافأة هذه المهمة في اليوم؛ الافتراضي 1', 20);
      s.addUserOption(o => o.setName('عضو').setDescription('اختياري: حصر هذا القالب في عضو محدد'));
      return s;
    })
    .addSubcommand(s => {
      s.setName('تعديل').setDescription('تعديل قالب؛ لا يغير المهام المسحوبة سابقًا اليوم');
      s.addStringOption(o => o.setName('المعرف').setDescription('معرف القالب من قائمة المهام').setRequired(true));
      s.addStringOption(o => o.setName('الاسم').setDescription('الاسم الجديد').setMaxLength(100));
      countOption(s, 'العدد', 'العدد أو الدقائق الجديد', 100000);
      countOption(s, 'النقاط', 'المكافأة الجديدة', 100000);
      countOption(s, 'التكرار', 'أقصى تكرار يومي جديد', 20);
      return s;
    });
  for (const name of ['تعطيل', 'تفعيل']) admin.addSubcommand(s => s.setName(name).setDescription(`${name} قالب للمهام القادمة`)
    .addStringOption(o => o.setName('المعرف').setDescription('معرف القالب').setRequired(true)));
  admin.addSubcommand(s => s.setName('قائمة').setDescription('قوالب المهام وأرقامها')
    .addIntegerOption(o => o.setName('الصفحة').setDescription('صفحة القوالب').setMinValue(1).setMaxValue(100)));
  const attendance = new SlashCommandBuilder().setName('اعدادات_الحضور').setDescription('عرض أو تغيير نقاط روم الكلان وشروط احتساب الصوت')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('الروم').setDescription('ID الروم الصوتي في أرينا'));
  countOption(attendance, 'النقاط', 'النقاط لكل فترة حضور', 100000);
  countOption(attendance, 'الدقائق', 'عدد الدقائق اللازمة لكل مكافأة', 1440);
  countOption(attendance, 'الحد_اليومي', 'الحد الأعلى لنقاط الحضور للعضو باليوم', 1000000);
  countOption(attendance, 'اقل_عدد', 'الحد الأدنى للبشر بالروم؛ 1 يسمح بالوجود منفردًا', 100);
  attendance.addBooleanOption(o => o.setName('تجاهل_الميوت').setDescription('عدم احتساب الميكروفون المكتوم في المهام والحضور'))
    .addBooleanOption(o => o.setName('تجاهل_الديفن').setDescription('عدم احتساب كتم السماعات في المهام والحضور'))
    .addBooleanOption(o => o.setName('مفعل').setDescription('تفعيل أو إيقاف نقاط الحضور الإضافية فقط'));
  const status = new SlashCommandBuilder().setName('حالة_البوت').setDescription('فحص القارئ والقنوات والحفظ')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return [tasks, points, board, admin, attendance, status, setup].map(c => c.setDMPermission(false).toJSON());
}

function progressBar(ratio) { const n = Math.max(0, Math.min(10, Math.floor(ratio * 10))); return '▰'.repeat(n) + '▱'.repeat(10 - n); }

export function tasksEmbed(state, at, connected) {
  const embed = new EmbedBuilder().setColor(0x99ddff).setTitle('❄️ مهامك اليومية')
    .setDescription(`اليوم: **${state.day}** • تتجدد <t:${Math.floor(nextReset(at) / 1000)}:R>\n`
      + `${connected ? '🟢 القارئ متصل' : '🔴 الرصد متوقف؛ لا تحتسب إنجازات جديدة الآن'}\n`
      + 'الرسالة أو دقيقة الصوت تتقدم بها جميع مهامك المطابقة للروم.')
    .setFooter({ text: 'توقيت السعودية • احتساب تلقائي • استخدم تحديث لعرض أحدث تقدم' });
  for (const [i, task] of state.tasks.entries()) {
    const divisor = task.type === 'voice' ? 60000 : 1;
    const total = task.target * task.repeat;
    const value = Math.min(total, Math.floor(task.progress / divisor));
    embed.addFields({
      name: `${task.completed === task.repeat ? '✅' : '📌'} ${i + 1}. ${safe(task.title)}`,
      value: `${progressBar(task.progress / (total * divisor))} **${value} / ${total}** ${task.type === 'voice' ? 'دقيقة' : 'رسالة'}\n`
        + `الإنجازات: **${task.completed}/${task.repeat}** • **${task.reward} نقطة** لكل ${task.target} ${task.type === 'voice' ? 'دقيقة' : 'رسالة'}\n`
        + `روم أرينا: <#${task.channelId}>`, inline: false
    });
  }
  if (state.tasks.length < 5) embed.addFields({ name: 'تنبيه القوالب', value: `تتوفر لك ${state.tasks.length} مهام فقط. على الإدارة توفير 5 قوالب نشطة على الأقل؛ لا تتكرر المهمة لملء الخانات.` });
  embed.addFields({ name: 'نقاط اليوم', value: `المهام: **${state.points.tasks}** • الحضور: **${state.points.attendance}** • الإجمالي: **${state.points.tasks + state.points.attendance}**` });
  return embed;
}

export function createHandler(ctx) {
  const { config, service, store, isMember, validateChannel, refreshSettings, status, panel } = ctx;
  const adminNames = new Set(['ادارة_المهام', 'اعدادات_الحضور', 'حالة_البوت', 'setup']);
  return async interaction => {
    const button = interaction.isButton();
    if (!interaction.isChatInputCommand() && !button) return;
    const action = button ? parsePanelAction(interaction.customId) : null;
    const taskRefresh = button && interaction.customId.startsWith('quests:');
    if (button && !taskRefresh && !action) return;
    const name = button ? (action?.kind === 'top' ? 'المتصدرين' : 'مهامي') : interaction.commandName;
    if (interaction.guildId !== config.clanGuildId) {
      await interaction.reply({ content: 'هذا البوت مخصص لسيرفر الكلان فقط.', flags: MessageFlags.Ephemeral });
      return;
    }
    if ((taskRefresh && interaction.customId !== `quests:${interaction.user.id}`)
      || (action?.ownerId && action.ownerId !== interaction.user.id)) {
      await interaction.reply({ content: 'هذه لوحة عضو آخر. استخدم /مهامي.', flags: MessageFlags.Ephemeral });
      return;
    }
    const admin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (adminNames.has(name) && !admin) {
      await interaction.reply({ content: 'تحتاج صلاحية إدارة السيرفر لاستخدام هذا الأمر.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (['مهامي', 'نقاطي'].includes(name) && !isMember(interaction.user.id)) {
      await interaction.reply({ content: 'أنت غير مسجل ضمن رتبة أعضاء الكلان، أو لم يكتمل تحميل الأعضاء.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (taskRefresh || action?.update) await interaction.deferUpdate();
    else await interaction.deferReply(name === 'المتصدرين' && !button ? {} : { flags: MessageFlags.Ephemeral });
    const reply = payload => interaction.editReply({ allowedMentions: { parse: [] }, ...payload });
    try {
      if (name === 'setup') {
        const channelId = interaction.options.getChannel('الروم')?.id || interaction.channelId;
        const minutes = interaction.options.getInteger('التجديد') ?? DEFAULT_PANEL_MINUTES;
        const created = await panel.setup(channelId, minutes);
        if (!created) throw new Error('البوت غير جاهز لتجهيز اللوحة حاليًا.');
        return await reply({ content: `✅ تم إرسال اللوحة في <#${channelId}>. تتجدد كل **${minutes} دقيقة**، وإعدادها محفوظ بعد إعادة التشغيل.` });
      }
      if (name === 'مهامي') {
        const state = await service.day(interaction.user.id);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
          .setCustomId(`quests:${interaction.user.id}`).setLabel('تحديث التقدم').setEmoji('🔄').setStyle(ButtonStyle.Secondary));
        return await reply({ embeds: [tasksEmbed(state, Date.now(), status().tracking)], components: [row] });
      }
      if (name === 'نقاطي') {
        const embed = new EmbedBuilder().setColor(0x99ddff).setTitle('🏅 رصيد نقاطك');
        for (const p of periods) {
          const t = await store.totals(interaction.user.id, p.value, Date.now());
          embed.addFields({ name: p.name, value: `المهام: **${t.tasks}** • الحضور: **${t.attendance}** • الإجمالي: **${t.total}**` });
        }
        return await reply({ embeds: [embed] });
      }
      if (name === 'المتصدرين') {
        const period = action?.period || interaction.options.getString('الفترة') || 'daily';
        const category = action?.category || interaction.options.getString('النوع') || 'total';
        const page = action?.page || interaction.options.getInteger('الصفحة') || 1;
        const rows = await store.ranking(period, category, Date.now(), { skip: (page - 1) * 10 });
        const lines = rows.map((entry, i) => `**${(page - 1) * 10 + i + 1}.** <@${entry._id}> — **${entry[category]}** نقطة`);
        const components = [];
        if (action) {
          const key = (period, page, action) => `${TOP_PREFIX}${interaction.user.id}:${category}:${period}:${page}:${action}`;
          components.push(new ActionRowBuilder().addComponents(...periods.map(p => new ButtonBuilder()
            .setCustomId(key(p.value, 1, 'period')).setLabel(p.value === 'all' ? 'الشامل' : p.name)
            .setStyle(p.value === period ? ButtonStyle.Primary : ButtonStyle.Secondary))));
          components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(key(period, Math.max(1, page - 1), 'previous')).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
            new ButtonBuilder().setCustomId(key(period, Math.min(100, page + 1), 'next')).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(rows.length < 10 || page === 100)
          ));
        }
        return await reply({ components, embeds: [new EmbedBuilder().setColor(0xffcd70)
          .setTitle(`🏆 المتصدرون • ${periodLabel(period)} • ${categoryLabel(category)}`)
          .setDescription(lines.join('\n') || 'لا توجد نقاط في هذه الصفحة حتى الآن.')
          .setFooter({ text: `صفحة ${page} • توقيت السعودية • بداية الأسبوع: ${['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'][config.weekStart]}` })] });
      }
      if (name === 'ادارة_المهام') {
        const sub = interaction.options.getSubcommand();
        const templates = await store.templates();
        if (sub === 'قائمة') {
          const page = interaction.options.getInteger('الصفحة') || 1;
          const list = templates.slice((page - 1) * 10, page * 10);
          return await reply({ embeds: [new EmbedBuilder().setColor(0x99ddff).setTitle(`📋 قوالب المهام • ${page}`)
            .setDescription(list.map(t => `${t.enabled ? '🟢' : '⏸️'} **${safe(t.title)}**\n`
              + `المعرف: \`${t.id}\` • ${t.type === 'voice' ? 'دقائق' : 'رسائل'}: ${t.target} • نقاط: ${t.reward} • تكرار: ${t.repeat}`
              + (t.forUser ? ` • مخصص لـ <@${t.forUser}>` : '')).join('\n\n') || 'لا توجد قوالب.')
            .setFooter({ text: 'التغييرات تسري على السحب القادم؛ المهام المسحوبة اليوم لا تتغير.' })] });
        }
        if (sub === 'اضافة') {
          const forUser = interaction.options.getUser('عضو');
          if (forUser && !isMember(forUser.id)) throw new Error('العضو المختار ليس ضمن أعضاء الكلان المؤهلين.');
          const task = validateTemplate({
            id: randomUUID().slice(0, 8), title: interaction.options.getString('الاسم'), type: interaction.options.getString('النوع'),
            channelId: interaction.options.getString('الروم').trim(), target: interaction.options.getInteger('العدد'),
            reward: interaction.options.getInteger('النقاط'), repeat: interaction.options.getInteger('التكرار') || 1,
            enabled: true, forUser: forUser?.id || null
          });
          if (task.forUser && templates.filter(t => t.enabled && t.forUser === task.forUser).length >= 5) throw new Error('لهذا العضو 5 قوالب خاصة بالفعل. عطل واحدًا أولًا.');
          await validateChannel(task.channelId, task.type);
          await store.addTemplate(task);
          await refreshSettings();
          return await reply({ content: `✅ تم إنشاء **${safe(task.title)}**. المعرف: \`${task.id}\`\n${task.target} ${task.type === 'voice' ? 'دقيقة' : 'رسالة'} = ${task.reward} نقطة، حتى ${task.repeat} مرة يوميًا.\nيدخل في اختيار المهام الجديدة؛ لا يستبدل مهام اليوم المسحوبة.` });
        }
        const id = interaction.options.getString('المعرف').trim();
        const old = templates.find(t => t.id === id);
        if (!old) throw new Error('معرف المهمة غير موجود. استخدم /ادارة_المهام قائمة.');
        const fields = {};
        if (sub === 'تعديل') {
          for (const [key, option] of [['target', 'العدد'], ['reward', 'النقاط'], ['repeat', 'التكرار']]) {
            const value = interaction.options.getInteger(option); if (value !== null) fields[key] = value;
          }
          const title = interaction.options.getString('الاسم'); if (title) fields.title = title;
          validateTemplate({ ...old, ...fields });
          if (!Object.keys(fields).length) throw new Error('حدد قيمة واحدة على الأقل لتعديلها.');
        } else {
          fields.enabled = sub === 'تفعيل';
          if (!fields.enabled && !old.forUser && templates.filter(t => t.enabled && !t.forUser && t.id !== id).length < 5) throw new Error('يجب إبقاء 5 قوالب عامة نشطة على الأقل. أضف بديلًا أولًا.');
          if (fields.enabled && old.forUser && templates.filter(t => t.enabled && t.forUser === old.forUser && t.id !== id).length >= 5) throw new Error('لا يمكن تفعيل أكثر من 5 مهام خاصة للعضو.');
        }
        await store.updateTemplate(id, fields);
        await refreshSettings();
        return await reply({ content: `✅ تم ${sub} القالب. المهام المسحوبة اليوم تبقى كما هي؛ التغيير للسحب القادم.` });
      }
      if (name === 'اعدادات_الحضور') {
        const fields = {};
        const channel = interaction.options.getString('الروم');
        if (channel) { fields.channelId = channel.trim(); await validateChannel(fields.channelId, 'voice'); }
        for (const [key, option, factor] of [['points', 'النقاط', 1], ['intervalMs', 'الدقائق', 60000], ['dailyCap', 'الحد_اليومي', 1], ['minPeople', 'اقل_عدد', 1]]) {
          const value = interaction.options.getInteger(option); if (value !== null) fields[key] = value * factor;
        }
        for (const [key, option] of [['ignoreMuted', 'تجاهل_الميوت'], ['ignoreDeafened', 'تجاهل_الديفن'], ['enabled', 'مفعل']]) {
          const value = interaction.options.getBoolean(option); if (value !== null) fields[key] = value;
        }
        if (Object.keys(fields).length) { await store.setAttendance(fields); await refreshSettings(); }
        const { attendance: a } = await store.settings();
        return await reply({ content: `${a.enabled ? '🟢' : '⏸️'} نقاط الحضور في <#${a.channelId}>\n`
          + `**${a.points} نقاط لكل ${a.intervalMs / 60000} دقائق** • الحد اليومي: **${a.dailyCap}**\n`
          + `أقل عدد بشر بالروم: ${a.minPeople} • تجاهل الميوت: ${a.ignoreMuted ? 'نعم' : 'لا'} • تجاهل الديفن: ${a.ignoreDeafened ? 'نعم' : 'لا'}\n`
          + 'شروط الميوت والديفن وعدد الأشخاص تنطبق أيضًا على المهام الصوتية.\n'
          + 'تغيير الإعدادات يحتفظ بالنقاط السابقة ويبدأ عدّ فترة الحضور الجزئية من جديد، بلا إعادة تسعير للماضي.' });
      }
      if (name === 'حالة_البوت') {
        const s = status();
        const errors = [];
        const { attendance } = await store.settings();
        const checks = [{ channelId: config.generalChannelId, type: 'messages' }, { channelId: attendance.channelId, type: 'voice' }];
        for (const item of checks) {
          try { await validateChannel(item.channelId, item.type); }
          catch (error) { errors.push(error.message); }
        }
        return await reply({ content: `البوت: ${s.bot ? '🟢' : '🔴'} • القارئ: ${s.observer ? '🟢' : '🔴'} • الرصد: ${s.tracking ? '🟢' : '🔴'}\n`
          + `الأعضاء المؤهلون: ${s.memberCount} • اليوم: ${dayKey(Date.now())}\n`
          + `نوع الربط: ${config.mode} • آخر رسالة محتسبة: ${s.lastMessageAt ? `<t:${Math.floor(s.lastMessageAt / 1000)}:R>` : 'لم تسجل بعد'}\n`
          + `آخر تحديث صوت ناجح: ${s.lastVoiceAt ? `<t:${Math.floor(s.lastVoiceAt / 1000)}:R>` : 'لم يسجل بعد'}\n`
          + `MongoDB: ${await store.db.command({ ping: 1 }).then(() => '🟢 متصل')}\n`
          + (errors.length ? errors.join('\n') : '✅ القنوات الأساسية متاحة للقارئ.')
          + '\nالاتصال وحده لا يضمن وصول كل أحداث الحساب غير الرسمي؛ اختبر رسالة ودخول وخروج عضو قبل اعتماد النقاط.' });
      }
    } catch (error) {
      ctx.onError(error);
      // Only our validation errors are exposed; remote errors can contain request secrets.
      const text = error instanceof Error && /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تنفيذ الأمر. راجع حالة الاتصال وسجل Render.';
      await reply({ content: `❌ ${text}`, embeds: [], components: [] });
    }
  };
}

export async function checkSourceChannel(source, guildId, id, type) {
  if (!isId(id)) throw new Error('ID الروم غير صالح.');
  if (!source?.isReady()) throw new Error('القارئ غير متصل بأرينا حاليًا.');
  const channel = source.channels.cache.get(id);
  if (!channel || channel.guild?.id !== guildId) throw new Error(`الروم ${id} غير متاح للحساب داخل أرينا.`);
  const view = channel.permissionsFor(source.user)?.has(1024n) ?? false;
  if (!view) throw new Error(`الحساب لا يملك صلاحية مشاهدة الروم ${id}.`);
  const voiceType = [2, 13, 'GUILD_VOICE', 'GUILD_STAGE_VOICE'].includes(channel.type);
  const textType = [0, 5, 10, 11, 12, 'GUILD_TEXT', 'GUILD_NEWS', 'GUILD_NEWS_THREAD', 'GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD'].includes(channel.type);
  if (type === 'voice' ? !voiceType : !textType) throw new Error('نوع الروم لا يطابق نوع المهمة.');
  return channel;
}
