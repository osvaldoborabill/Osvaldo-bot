/**
 * index.js — Bot Discord completo para Railway
 *
 * Variáveis de ambiente necessárias (.env ou Railway Dashboard):
 *   DISCORD_TOKEN       — token do bot
 *   CLIENT_ID           — application/client ID (para deploy de slash commands)
 *
 * Banco de dados SQLite salvo em ./data/jake.db
 * (Monte um volume persistente no Railway apontando para /app/data)
 */

'use strict';
require('dotenv').config();

// ─── Dependências ──────────────────────────────────────────────────────────────
const {
  Client, GatewayIntentBits, Collection, Events,
  ActivityType, EmbedBuilder, PermissionFlagsBits,
  SlashCommandBuilder, REST, Routes,
} = require('discord.js');
const Database = require('better-sqlite3');
const cron      = require('node-cron');
const path      = require('path');
const fs        = require('fs');

// ─── Banco de dados ────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'jake.db'), { timeout: 10000 });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -65536');
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456');
db.pragma('wal_autocheckpoint = 1000');

db.exec(`
  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL, reason TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mod_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL, action TEXT NOT NULL,
    reason TEXT, timestamp INTEGER NOT NULL, extra TEXT
  );
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT, welcome_channel_id TEXT,
    welcome_message TEXT DEFAULT 'Welcome {mention} to **{server}**! You are member #{membercount}.',
    bye_channel_id TEXT,
    bye_message TEXT DEFAULT 'Goodbye {user}, we hope to see you again!',
    prefix TEXT DEFAULT '!',
    bot_role TEXT
  );
  CREATE TABLE IF NOT EXISTS automod_config (
    guild_id TEXT PRIMARY KEY,
    antispam INTEGER DEFAULT 0, antilinks INTEGER DEFAULT 0,
    bad_words TEXT DEFAULT '[]', whitelisted_channels TEXT DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    content TEXT NOT NULL, is_embed INTEGER DEFAULT 0,
    embed_data TEXT, scheduled_time INTEGER,
    is_recurring INTEGER DEFAULT 0, interval_minutes INTEGER,
    is_active INTEGER DEFAULT 1
  );
`);

// Migrações seguras
try { db.exec("ALTER TABLE guild_config ADD COLUMN prefix TEXT DEFAULT '!'"); } catch {}
try { db.exec("ALTER TABLE guild_config ADD COLUMN bot_role TEXT"); } catch {}

// Cache de config (60s TTL)
const configCache = new Map();
const CACHE_TTL = 60_000;

const dbFns = {
  addWarning: (gid, uid, mid, reason) =>
    db.prepare('INSERT INTO warnings (guild_id,user_id,moderator_id,reason,timestamp) VALUES (?,?,?,?,?)').run(gid, uid, mid, reason, Date.now()),
  getWarnings: (gid, uid) =>
    db.prepare('SELECT * FROM warnings WHERE guild_id=? AND user_id=? ORDER BY timestamp DESC').all(gid, uid),
  clearWarnings: (gid, uid) =>
    db.prepare('DELETE FROM warnings WHERE guild_id=? AND user_id=?').run(gid, uid),
  logModAction: (gid, uid, mid, action, reason, extra = null) =>
    db.prepare('INSERT INTO mod_actions (guild_id,user_id,moderator_id,action,reason,timestamp,extra) VALUES (?,?,?,?,?,?,?)').run(gid, uid, mid, action, reason, Date.now(), extra),
  getModActions: (gid, uid) =>
    db.prepare('SELECT * FROM mod_actions WHERE guild_id=? AND user_id=? ORDER BY timestamp DESC').all(gid, uid),
  getGuildConfig(gid) {
    const cached = configCache.get(gid);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
    let cfg = db.prepare('SELECT * FROM guild_config WHERE guild_id=?').get(gid);
    if (!cfg) {
      db.prepare('INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)').run(gid);
      cfg = db.prepare('SELECT * FROM guild_config WHERE guild_id=?').get(gid);
    }
    configCache.set(gid, { data: cfg, ts: Date.now() });
    return cfg;
  },
  setGuildConfig(gid, key, value) {
    this.getGuildConfig(gid);
    db.prepare(`UPDATE guild_config SET ${key}=? WHERE guild_id=?`).run(value, gid);
    configCache.delete(gid);
  },
  resetGuildConfig(gid) {
    db.prepare('DELETE FROM guild_config WHERE guild_id=?').run(gid);
    configCache.delete(gid);
  },
  getAutomodConfig(gid) {
    let cfg = db.prepare('SELECT * FROM automod_config WHERE guild_id=?').get(gid);
    if (!cfg) {
      db.prepare('INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)').run(gid);
      cfg = db.prepare('SELECT * FROM automod_config WHERE guild_id=?').get(gid);
    }
    return cfg;
  },
  setAutomodConfig: (gid, key, value) =>
    db.prepare(`UPDATE automod_config SET ${key}=? WHERE guild_id=?`).run(value, gid),
  addSchedule: (gid, cid, content, isEmbed, embedData, scheduledTime, isRecurring, intervalMinutes) =>
    db.prepare('INSERT INTO schedules (guild_id,channel_id,content,is_embed,embed_data,scheduled_time,is_recurring,interval_minutes,is_active) VALUES (?,?,?,?,?,?,?,?,1)')
      .run(gid, cid, content, isEmbed ? 1 : 0, embedData, scheduledTime, isRecurring ? 1 : 0, intervalMinutes),
  getDueSchedules: (now) =>
    db.prepare('SELECT * FROM schedules WHERE is_active=1 AND scheduled_time<=?').all(now),
  updateScheduleTime: (id, newTime) =>
    db.prepare('UPDATE schedules SET scheduled_time=? WHERE id=?').run(newTime, id),
  deactivateSchedule: (id) =>
    db.prepare('UPDATE schedules SET is_active=0 WHERE id=?').run(id),
  getActiveSchedules: (gid) =>
    db.prepare('SELECT * FROM schedules WHERE guild_id=? AND is_active=1').all(gid),
  getPrefix: (gid) => {
    const cfg = dbFns.getGuildConfig(gid);
    return cfg?.prefix || '!';
  },
};

// ─── Utilitários ───────────────────────────────────────────────────────────────
function hasAccess(member, guild, botOwnerId = null) {
  if (!member || !guild) return false;
  if (botOwnerId && member.id === botOwnerId) return true;
  if (guild.ownerId === member.id) return true;
  const cfg = dbFns.getGuildConfig(guild.id);
  if (!cfg?.bot_role) return true;
  return member.roles.cache.has(cfg.bot_role);
}

async function denyAccess(ctx, roleId) {
  const roleMention = roleId ? `<@&${roleId}>` : 'the required role';
  const msg = `🔒 You need ${roleMention} to use bot commands.`;
  if (typeof ctx.isChatInputCommand === 'function') {
    try {
      if (ctx.deferred || ctx.replied) await ctx.followUp({ content: msg, ephemeral: true });
      else await ctx.reply({ content: msg, ephemeral: true });
    } catch {}
  } else {
    try { await ctx.reply(msg); } catch {}
  }
}

function requirePermission(interaction, ...perms) {
  if (!interaction.memberPermissions.has(perms)) {
    interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    return false;
  }
  return true;
}

function requireBotPermission(interaction, ...perms) {
  if (!interaction.guild.members.me.permissions.has(perms)) {
    interaction.reply({ content: '❌ I do not have the required permissions to do this.', ephemeral: true });
    return false;
  }
  return true;
}

function timestamp(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

function parseTime(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const map = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * (map[unit] || 0);
}

// ─── Slash Commands ────────────────────────────────────────────────────────────
const slashCommands = [];

// ── Moderation ──
const banCmd = {
  data: new SlashCommandBuilder().setName('ban').setDescription('Ban a user')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction, client) {
    if (!requirePermission(interaction, PermissionFlagsBits.BanMembers)) return;
    if (!requireBotPermission(interaction, PermissionFlagsBits.BanMembers)) return;
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    try {
      await interaction.guild.members.ban(target, { reason });
      dbFns.logModAction(interaction.guild.id, target.id, interaction.user.id, 'ban', reason);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🔨 Banned').setDescription(`**${target.tag}** was banned.\n**Reason:** ${reason}`)] });
    } catch { await interaction.reply({ content: '❌ Could not ban that user.', ephemeral: true }); }
  },
};

const kickCmd = {
  data: new SlashCommandBuilder().setName('kick').setDescription('Kick a user')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.KickMembers)) return;
    if (!requireBotPermission(interaction, PermissionFlagsBits.KickMembers)) return;
    const member = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    try {
      await member.kick(reason);
      dbFns.logModAction(interaction.guild.id, member.id, interaction.user.id, 'kick', reason);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle('👢 Kicked').setDescription(`**${member.user.tag}** was kicked.\n**Reason:** ${reason}`)] });
    } catch { await interaction.reply({ content: '❌ Could not kick that user.', ephemeral: true }); }
  },
};

const muteCmd = {
  data: new SlashCommandBuilder().setName('mute').setDescription('Timeout a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 10m, 1h').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers)) return;
    if (!requireBotPermission(interaction, PermissionFlagsBits.ModerateMembers)) return;
    const member = interaction.options.getMember('user');
    const dur    = interaction.options.getString('duration');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const ms     = parseTime(dur);
    if (!ms || ms > 28 * 86_400_000) return interaction.reply({ content: '❌ Invalid duration. Use e.g. 10m, 1h, 7d (max 28d).', ephemeral: true });
    try {
      await member.timeout(ms, reason);
      dbFns.logModAction(interaction.guild.id, member.id, interaction.user.id, 'mute', reason, dur);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle('🔇 Muted').setDescription(`**${member.user.tag}** muted for **${dur}**.\n**Reason:** ${reason}`)] });
    } catch { await interaction.reply({ content: '❌ Could not mute that user.', ephemeral: true }); }
  },
};

const unmuteCmd = {
  data: new SlashCommandBuilder().setName('unmute').setDescription('Remove timeout from a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers)) return;
    const member = interaction.options.getMember('user');
    try {
      await member.timeout(null);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('🔊 Unmuted').setDescription(`**${member.user.tag}** unmuted.`)] });
    } catch { await interaction.reply({ content: '❌ Could not unmute.', ephemeral: true }); }
  },
};

const warnCmd = {
  data: new SlashCommandBuilder().setName('warn').setDescription('Warn a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers)) return;
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    dbFns.addWarning(interaction.guild.id, target.id, interaction.user.id, reason);
    dbFns.logModAction(interaction.guild.id, target.id, interaction.user.id, 'warn', reason);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('⚠️ Warned').setDescription(`**${target.tag}** warned.\n**Reason:** ${reason}`)] });
  },
};

const warnsCmd = {
  data: new SlashCommandBuilder().setName('warns').setDescription('View warnings for a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const warns  = dbFns.getWarnings(interaction.guild.id, target.id);
    const embed  = new EmbedBuilder().setColor(0xf1c40f).setTitle(`⚠️ Warnings for ${target.tag}`)
      .setDescription(warns.length ? warns.map((w, i) => `**${i + 1}.** ${w.reason} — <t:${Math.floor(w.timestamp / 1000)}:R>`).join('\n') : 'No warnings.');
    await interaction.reply({ embeds: [embed] });
  },
};

const clearwarnsCmd = {
  data: new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ModerateMembers)) return;
    const target = interaction.options.getUser('user');
    dbFns.clearWarnings(interaction.guild.id, target.id);
    await interaction.reply({ content: `✅ Warnings cleared for **${target.tag}**.` });
  },
};

const softbanCmd = {
  data: new SlashCommandBuilder().setName('softban').setDescription('Ban then immediately unban (clears messages)')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.BanMembers)) return;
    if (!requireBotPermission(interaction, PermissionFlagsBits.BanMembers)) return;
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'Softban';
    try {
      await interaction.guild.members.ban(target, { reason, deleteMessageSeconds: 604800 });
      await interaction.guild.members.unban(target, 'Softban unban');
      dbFns.logModAction(interaction.guild.id, target.id, interaction.user.id, 'softban', reason);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🔨 Softbanned').setDescription(`**${target.tag}** softbanned.`)] });
    } catch { await interaction.reply({ content: '❌ Could not softban.', ephemeral: true }); }
  },
};

const unbanCmd = {
  data: new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID')
    .addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.BanMembers)) return;
    const userId = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason') || 'No reason';
    try {
      await interaction.guild.members.unban(userId, reason);
      await interaction.reply({ content: `✅ Unban <@${userId}>.` });
    } catch { await interaction.reply({ content: '❌ Could not unban.', ephemeral: true }); }
  },
};

const modlogCmd = {
  data: new SlashCommandBuilder().setName('modlog').setDescription('View mod log for a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  async execute(interaction) {
    const target  = interaction.options.getUser('user');
    const actions = dbFns.getModActions(interaction.guild.id, target.id);
    const embed   = new EmbedBuilder().setColor(0x5865f2).setTitle(`📋 Mod Log — ${target.tag}`)
      .setDescription(actions.length ? actions.slice(0, 10).map((a, i) => `**${i + 1}.** \`${a.action}\` — ${a.reason || 'N/A'} — <t:${Math.floor(a.timestamp / 1000)}:R>`).join('\n') : 'No actions.');
    await interaction.reply({ embeds: [embed] });
  },
};

// ── Channels ──
const purgeCmd = {
  data: new SlashCommandBuilder().setName('purge').setDescription('Delete messages')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageMessages)) return;
    const amount = interaction.options.getInteger('amount');
    await interaction.deferReply({ ephemeral: true });
    const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);
    await interaction.editReply({ content: `✅ Deleted ${deleted?.size ?? 0} message(s).` });
  },
};

const lockdownCmd = {
  data: new SlashCommandBuilder().setName('lockdown').setDescription('Lock the current channel')
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageChannels)) return;
    const reason = interaction.options.getString('reason') || 'No reason';
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }, { reason });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🔒 Locked').setDescription(`Channel locked.\n**Reason:** ${reason}`)] });
  },
};

const unlockCmd = {
  data: new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel'),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageChannels)) return;
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('🔓 Unlocked').setDescription('Channel unlocked.')] });
  },
};

const slowmodeCmd = {
  data: new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode on this channel')
    .addIntegerOption(o => o.setName('seconds').setDescription('Slowmode in seconds (0 to disable)').setRequired(true).setMinValue(0).setMaxValue(21600)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageChannels)) return;
    const s = interaction.options.getInteger('seconds');
    await interaction.channel.setRateLimitPerUser(s);
    await interaction.reply({ content: s === 0 ? '✅ Slowmode disabled.' : `✅ Slowmode set to **${s}s**.` });
  },
};

const nickCmd = {
  data: new SlashCommandBuilder().setName('nick').setDescription('Change a member\'s nickname')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('nickname').setDescription('New nickname (leave blank to reset)')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageNicknames)) return;
    const member = interaction.options.getMember('user');
    const nick   = interaction.options.getString('nickname') || null;
    await member.setNickname(nick).catch(() => {});
    await interaction.reply({ content: `✅ Nickname ${nick ? `set to **${nick}**` : 'reset'} for ${member}.` });
  },
};

// ── Messaging ──
const announceCmd = {
  data: new SlashCommandBuilder().setName('announce').setDescription('Send an announcement embed')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('Hex color e.g. #FF0000')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const channel = interaction.options.getChannel('channel');
    const title   = interaction.options.getString('title');
    const message = interaction.options.getString('message');
    const color   = parseInt((interaction.options.getString('color') || '#5865F2').replace('#', ''), 16);
    await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(message).setTimestamp()] });
    await interaction.reply({ content: '✅ Announcement sent!', ephemeral: true });
  },
};

const embedCmd = {
  data: new SlashCommandBuilder().setName('embed').setDescription('Send a custom embed')
    .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Description').setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('Hex color')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageMessages)) return;
    const title = interaction.options.getString('title');
    const desc  = interaction.options.getString('description');
    const color = parseInt((interaction.options.getString('color') || '#5865F2').replace('#', ''), 16);
    await interaction.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc)] });
    await interaction.reply({ content: '✅ Embed sent!', ephemeral: true });
  },
};

const dmCmd = {
  data: new SlashCommandBuilder().setName('dm').setDescription('Send a DM to a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const target  = interaction.options.getUser('user');
    const message = interaction.options.getString('message');
    try {
      await target.send(`📩 **Message from ${interaction.guild.name}:**\n${message}`);
      await interaction.reply({ content: '✅ DM sent!', ephemeral: true });
    } catch { await interaction.reply({ content: '❌ Could not DM that user.', ephemeral: true }); }
  },
};

const dmEmbedCmd = {
  data: new SlashCommandBuilder().setName('dm-embed').setDescription('Send an embed DM to a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const target  = interaction.options.getUser('user');
    const title   = interaction.options.getString('title');
    const message = interaction.options.getString('message');
    try {
      await target.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(message).setFooter({ text: `From ${interaction.guild.name}` })] });
      await interaction.reply({ content: '✅ Embed DM sent!', ephemeral: true });
    } catch { await interaction.reply({ content: '❌ Could not DM that user.', ephemeral: true }); }
  },
};

const pingEveryoneCmd = {
  data: new SlashCommandBuilder().setName('ping-everyone').setDescription('Ping @everyone with a message')
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.MentionEveryone)) return;
    await interaction.channel.send({ content: `@everyone ${interaction.options.getString('message')}`, allowedMentions: { parse: ['everyone'] } });
    await interaction.reply({ content: '✅ Done!', ephemeral: true });
  },
};

const pingHereCmd = {
  data: new SlashCommandBuilder().setName('ping-here').setDescription('Ping @here with a message')
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.MentionEveryone)) return;
    await interaction.channel.send({ content: `@here ${interaction.options.getString('message')}`, allowedMentions: { parse: ['here'] } });
    await interaction.reply({ content: '✅ Done!', ephemeral: true });
  },
};

// ── Roles ──
const roleAddCmd = {
  data: new SlashCommandBuilder().setName('role-add').setDescription('Add a role to a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageRoles)) return;
    const member = interaction.options.getMember('user');
    const role   = interaction.options.getRole('role');
    await member.roles.add(role).catch(() => {});
    await interaction.reply({ content: `✅ Added **${role.name}** to ${member}.` });
  },
};

const roleRemoveCmd = {
  data: new SlashCommandBuilder().setName('role-remove').setDescription('Remove a role from a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageRoles)) return;
    const member = interaction.options.getMember('user');
    const role   = interaction.options.getRole('role');
    await member.roles.remove(role).catch(() => {});
    await interaction.reply({ content: `✅ Removed **${role.name}** from ${member}.` });
  },
};

const roleColorCmd = {
  data: new SlashCommandBuilder().setName('role-color').setDescription('Change a role\'s color')
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('Hex color e.g. #FF0000').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageRoles)) return;
    const role  = interaction.options.getRole('role');
    const color = interaction.options.getString('color');
    await role.setColor(color).catch(() => {});
    await interaction.reply({ content: `✅ Color of **${role.name}** changed.` });
  },
};

const roleInfoCmd = {
  data: new SlashCommandBuilder().setName('role-info').setDescription('Get info about a role')
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  async execute(interaction) {
    const role  = interaction.options.getRole('role');
    const embed = new EmbedBuilder().setColor(role.color || 0x5865f2).setTitle(`Role: ${role.name}`)
      .addFields(
        { name: 'ID', value: role.id, inline: true },
        { name: 'Members', value: `${role.members.size}`, inline: true },
        { name: 'Color', value: role.hexColor, inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Hoisted', value: role.hoist ? 'Yes' : 'No', inline: true },
        { name: 'Created', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`, inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

const roleAllCmd = {
  data: new SlashCommandBuilder().setName('role-all').setDescription('Add or remove a role from ALL members')
    .addStringOption(o => o.setName('action').setDescription('add or remove').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageRoles)) return;
    await interaction.deferReply();
    const action = interaction.options.getString('action');
    const role   = interaction.options.getRole('role');
    const members = await interaction.guild.members.fetch();
    let count = 0;
    for (const [, m] of members) {
      if (m.user.bot) continue;
      try {
        action === 'add' ? await m.roles.add(role) : await m.roles.remove(role);
        count++;
      } catch {}
    }
    await interaction.editReply({ content: `✅ ${action === 'add' ? 'Added' : 'Removed'} **${role.name}** for **${count}** member(s).` });
  },
};

// ── Scheduling ──
const scheduleCmd = {
  data: new SlashCommandBuilder().setName('schedule').setDescription('Schedule a message')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true))
    .addStringOption(o => o.setName('delay').setDescription('Delay e.g. 30m, 2h').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');
    const delay   = interaction.options.getString('delay');
    const ms      = parseTime(delay);
    if (!ms) return interaction.reply({ content: '❌ Invalid delay format.', ephemeral: true });
    const time = Date.now() + ms;
    const r = dbFns.addSchedule(interaction.guild.id, channel.id, message, false, null, time, false, null);
    await interaction.reply({ content: `✅ Message scheduled (ID: \`${r.lastInsertRowid}\`) for <t:${Math.floor(time / 1000)}:R> in ${channel}.` });
  },
};

const repeatCmd = {
  data: new SlashCommandBuilder().setName('repeat').setDescription('Repeat a message at an interval')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true))
    .addStringOption(o => o.setName('interval').setDescription('Interval e.g. 30m, 2h').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const channel  = interaction.options.getChannel('channel');
    const message  = interaction.options.getString('message');
    const interval = interaction.options.getString('interval');
    const ms       = parseTime(interval);
    if (!ms) return interaction.reply({ content: '❌ Invalid interval format.', ephemeral: true });
    const intervalMin = Math.floor(ms / 60_000);
    const r = dbFns.addSchedule(interaction.guild.id, channel.id, message, false, null, Date.now() + ms, true, intervalMin);
    await interaction.reply({ content: `✅ Repeat message set (ID: \`${r.lastInsertRowid}\`) every **${interval}** in ${channel}.` });
  },
};

const scheduleListCmd = {
  data: new SlashCommandBuilder().setName('schedule-list').setDescription('List all active schedules'),
  async execute(interaction) {
    const schedules = dbFns.getActiveSchedules(interaction.guild.id);
    if (!schedules.length) return interaction.reply({ content: 'No active schedules.', ephemeral: true });
    const desc = schedules.slice(0, 10).map(s => `**ID ${s.id}** — <#${s.channel_id}> — ${s.is_recurring ? `every ${s.interval_minutes}m` : `once <t:${Math.floor(s.scheduled_time / 1000)}:R>`}\n> ${s.content.slice(0, 60)}`).join('\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📅 Schedules').setDescription(desc)] });
  },
};

const scheduleCancelCmd = {
  data: new SlashCommandBuilder().setName('schedule-cancel').setDescription('Cancel a scheduled message')
    .addIntegerOption(o => o.setName('id').setDescription('Schedule ID').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const id = interaction.options.getInteger('id');
    dbFns.deactivateSchedule(id);
    await interaction.reply({ content: `✅ Schedule \`${id}\` cancelled.` });
  },
};

const repeatListCmd = {
  data: new SlashCommandBuilder().setName('repeat-list').setDescription('List all repeating messages'),
  async execute(interaction) {
    const schedules = dbFns.getActiveSchedules(interaction.guild.id).filter(s => s.is_recurring);
    if (!schedules.length) return interaction.reply({ content: 'No repeating messages.', ephemeral: true });
    const desc = schedules.slice(0, 10).map(s => `**ID ${s.id}** — <#${s.channel_id}> — every **${s.interval_minutes}m**\n> ${s.content.slice(0, 60)}`).join('\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔁 Repeating Messages').setDescription(desc)] });
  },
};

const repeatStopCmd = {
  data: new SlashCommandBuilder().setName('repeat-stop').setDescription('Stop a repeating message')
    .addIntegerOption(o => o.setName('id').setDescription('Repeat ID').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    dbFns.deactivateSchedule(interaction.options.getInteger('id'));
    await interaction.reply({ content: '✅ Repeat stopped.' });
  },
};

// ── Automod ──
const automodCmd = {
  data: new SlashCommandBuilder().setName('automod').setDescription('Configure automod')
    .addSubcommand(s => s.setName('antispam').setDescription('Toggle anti-spam').addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
    .addSubcommand(s => s.setName('antilinks').setDescription('Toggle anti-links').addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true)))
    .addSubcommand(s => s.setName('badwords').setDescription('Set bad words list (comma-separated)').addStringOption(o => o.setName('words').setDescription('Words').setRequired(true)))
    .addSubcommand(s => s.setName('whitelist').setDescription('Whitelist a channel from automod').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('status').setDescription('Show automod config')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guild.id;
    dbFns.getAutomodConfig(gid); // ensure row exists
    if (sub === 'antispam') {
      const v = interaction.options.getBoolean('enabled') ? 1 : 0;
      dbFns.setAutomodConfig(gid, 'antispam', v);
      await interaction.reply({ content: `✅ Anti-spam ${v ? 'enabled' : 'disabled'}.` });
    } else if (sub === 'antilinks') {
      const v = interaction.options.getBoolean('enabled') ? 1 : 0;
      dbFns.setAutomodConfig(gid, 'antilinks', v);
      await interaction.reply({ content: `✅ Anti-links ${v ? 'enabled' : 'disabled'}.` });
    } else if (sub === 'badwords') {
      const words = interaction.options.getString('words').split(',').map(w => w.trim()).filter(Boolean);
      dbFns.setAutomodConfig(gid, 'bad_words', JSON.stringify(words));
      await interaction.reply({ content: `✅ Bad words updated: ${words.join(', ')}` });
    } else if (sub === 'whitelist') {
      const cfg = dbFns.getAutomodConfig(gid);
      const list = JSON.parse(cfg.whitelisted_channels || '[]');
      const ch   = interaction.options.getChannel('channel');
      if (!list.includes(ch.id)) list.push(ch.id);
      dbFns.setAutomodConfig(gid, 'whitelisted_channels', JSON.stringify(list));
      await interaction.reply({ content: `✅ ${ch} whitelisted from automod.` });
    } else {
      const cfg = dbFns.getAutomodConfig(gid);
      const bad = JSON.parse(cfg.bad_words || '[]');
      const wl  = JSON.parse(cfg.whitelisted_channels || '[]');
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🛡️ Automod Status')
        .addFields(
          { name: 'Anti-Spam', value: cfg.antispam ? '✅ On' : '❌ Off', inline: true },
          { name: 'Anti-Links', value: cfg.antilinks ? '✅ On' : '❌ Off', inline: true },
          { name: 'Bad Words', value: bad.length ? bad.join(', ') : 'None', inline: false },
          { name: 'Whitelisted Channels', value: wl.length ? wl.map(id => `<#${id}>`).join(', ') : 'None', inline: false },
        )] });
    }
  },
};

// ── Config ──
const configCmd = {
  data: new SlashCommandBuilder().setName('config').setDescription('Server configuration')
    .addSubcommand(s => s.setName('logchannel').setDescription('Set mod log channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('welcome').setDescription('Set welcome channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('bye').setDescription('Set goodbye channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('view').setDescription('View current config'))
    .addSubcommand(s => s.setName('reset').setDescription('Reset all config')),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guild.id;
    if (sub === 'logchannel') {
      dbFns.setGuildConfig(gid, 'log_channel_id', interaction.options.getChannel('channel').id);
      await interaction.reply({ content: '✅ Log channel set.' });
    } else if (sub === 'welcome') {
      dbFns.setGuildConfig(gid, 'welcome_channel_id', interaction.options.getChannel('channel').id);
      await interaction.reply({ content: '✅ Welcome channel set.' });
    } else if (sub === 'bye') {
      dbFns.setGuildConfig(gid, 'bye_channel_id', interaction.options.getChannel('channel').id);
      await interaction.reply({ content: '✅ Goodbye channel set.' });
    } else if (sub === 'reset') {
      dbFns.resetGuildConfig(gid);
      await interaction.reply({ content: '✅ Config reset.' });
    } else {
      const cfg = dbFns.getGuildConfig(gid);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Server Config')
        .addFields(
          { name: 'Log Channel', value: cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : 'Not set', inline: true },
          { name: 'Welcome Channel', value: cfg.welcome_channel_id ? `<#${cfg.welcome_channel_id}>` : 'Not set', inline: true },
          { name: 'Goodbye Channel', value: cfg.bye_channel_id ? `<#${cfg.bye_channel_id}>` : 'Not set', inline: true },
          { name: 'Prefix', value: cfg.prefix || '!', inline: true },
          { name: 'Bot Role', value: cfg.bot_role ? `<@&${cfg.bot_role}>` : 'None', inline: true },
        )] });
    }
  },
};

const prefixCmd = {
  data: new SlashCommandBuilder().setName('prefix').setDescription('Change the bot prefix')
    .addStringOption(o => o.setName('prefix').setDescription('New prefix').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    const p = interaction.options.getString('prefix');
    dbFns.setGuildConfig(interaction.guild.id, 'prefix', p);
    await interaction.reply({ content: `✅ Prefix updated to \`${p}\`.` });
  },
};

const setRoleCmd = {
  data: new SlashCommandBuilder().setName('setrole').setDescription('Set which role can use bot commands (server owner only)')
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  async execute(interaction, client) {
    if (interaction.user.id !== interaction.guild.ownerId && interaction.user.id !== client.botOwnerId) {
      return interaction.reply({ content: '❌ Only the server owner can use this.', ephemeral: true });
    }
    const role = interaction.options.getRole('role');
    dbFns.setGuildConfig(interaction.guild.id, 'bot_role', role.id);
    await interaction.reply({ content: `✅ Bot role set to **${role.name}**.` });
  },
};

// ── Welcome / Bye ──
const welcomeCmd = {
  data: new SlashCommandBuilder().setName('welcome').setDescription('Set welcome message')
    .addStringOption(o => o.setName('message').setDescription('Message. Use {mention}, {user}, {server}, {membercount}').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    dbFns.setGuildConfig(interaction.guild.id, 'welcome_message', interaction.options.getString('message'));
    await interaction.reply({ content: '✅ Welcome message set.' });
  },
};

const byeCmd = {
  data: new SlashCommandBuilder().setName('bye').setDescription('Set goodbye message')
    .addStringOption(o => o.setName('message').setDescription('Message. Use {user}, {server}, {membercount}').setRequired(true)),
  async execute(interaction) {
    if (!requirePermission(interaction, PermissionFlagsBits.ManageGuild)) return;
    dbFns.setGuildConfig(interaction.guild.id, 'bye_message', interaction.options.getString('message'));
    await interaction.reply({ content: '✅ Goodbye message set.' });
  },
};

// ── Utility ──
const pingCmd = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  async execute(interaction, client) {
    const sent = await interaction.reply({ content: 'Pinging…', fetchReply: true });
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`🏓 **Pong!**\nRoundtrip: \`${roundtrip}ms\` | WS: \`${client.ws.ping}ms\``);
  },
};

const userinfoCmd = {
  data: new SlashCommandBuilder().setName('userinfo').setDescription('Get info about a user')
    .addUserOption(o => o.setName('user').setDescription('User (default: yourself)')),
  async execute(interaction) {
    const target = interaction.options.getMember('user') || interaction.member;
    const user   = target.user;
    const embed  = new EmbedBuilder().setColor(0x5865f2).setTitle(`👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: 'ID', value: user.id, inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Roles', value: target.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `${r}`).join(', ') || 'None', inline: false },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

const serverinfoCmd = {
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Get info about this server'),
  async execute(interaction) {
    const g     = interaction.guild;
    const owner = await g.fetchOwner().catch(() => null);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🏠 ${g.name}`)
      .setThumbnail(g.iconURL({ dynamic: true }))
      .addFields(
        { name: 'Owner', value: owner ? owner.user.tag : 'Unknown', inline: true },
        { name: 'Members', value: `${g.memberCount}`, inline: true },
        { name: 'Channels', value: `${g.channels.cache.size}`, inline: true },
        { name: 'Roles', value: `${g.roles.cache.size}`, inline: true },
        { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Boost Level', value: `${g.premiumTier}`, inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

const avatarCmd = {
  data: new SlashCommandBuilder().setName('avatar').setDescription('Get a user\'s avatar')
    .addUserOption(o => o.setName('user').setDescription('User')),
  async execute(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🖼️ ${user.username}'s Avatar`).setImage(user.displayAvatarURL({ dynamic: true, size: 1024 }))] });
  },
};

const botinfoCmd = {
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Get info about this bot'),
  async execute(interaction, client) {
    const uptime = timestamp(client.uptime);
    const embed  = new EmbedBuilder().setColor(0x5865f2).setTitle(`🤖 ${client.user.username}`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Guilds', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Ping', value: `${client.ws.ping}ms`, inline: true },
        { name: 'Commands', value: `${client.commands.size} slash + ${client.prefixCommands.size} prefix`, inline: false },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

const rolesCmd = {
  data: new SlashCommandBuilder().setName('roles').setDescription('List all server roles'),
  async execute(interaction) {
    const roles = interaction.guild.roles.cache.sort((a, b) => b.position - a.position).filter(r => r.id !== interaction.guild.id);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎭 Server Roles').setDescription(roles.map(r => `${r}`).slice(0, 50).join(', ') || 'None')] });
  },
};

const emojisCmd = {
  data: new SlashCommandBuilder().setName('emojis').setDescription('List all server emojis'),
  async execute(interaction) {
    const emojis = interaction.guild.emojis.cache;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('😀 Server Emojis').setDescription(emojis.size ? [...emojis.values()].slice(0, 50).map(e => `${e}`).join(' ') : 'No custom emojis.')] });
  },
};

const inviteCmd = {
  data: new SlashCommandBuilder().setName('invite').setDescription('Get the bot invite link'),
  async execute(interaction, client) {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
    await interaction.reply({ content: `[Invite me!](${url})`, ephemeral: true });
  },
};

// ── Collect all slash commands ──
slashCommands.push(
  banCmd, kickCmd, muteCmd, unmuteCmd, warnCmd, warnsCmd, clearwarnsCmd,
  softbanCmd, unbanCmd, modlogCmd,
  purgeCmd, lockdownCmd, unlockCmd, slowmodeCmd, nickCmd,
  announceCmd, embedCmd, dmCmd, dmEmbedCmd, pingEveryoneCmd, pingHereCmd,
  roleAddCmd, roleRemoveCmd, roleColorCmd, roleInfoCmd, roleAllCmd,
  scheduleCmd, repeatCmd, scheduleListCmd, scheduleCancelCmd, repeatListCmd, repeatStopCmd,
  automodCmd,
  configCmd, prefixCmd, setRoleCmd,
  welcomeCmd, byeCmd,
  pingCmd, userinfoCmd, serverinfoCmd, avatarCmd, botinfoCmd, rolesCmd, emojisCmd, inviteCmd,
);

// ─── Prefix Commands ───────────────────────────────────────────────────────────
// A smaller but useful set of prefix commands for users who prefer them
const PREFIX_COMMANDS = new Map();

function addPrefix(names, fn) {
  const [name, ...aliases] = Array.isArray(names) ? names : [names];
  const cmd = { name, aliases, execute: fn };
  PREFIX_COMMANDS.set(name, cmd);
  aliases.forEach(a => PREFIX_COMMANDS.set(a, cmd));
}

addPrefix(['ping'], async (msg) => {
  const m = await msg.reply('Pinging…');
  await m.edit(`🏓 Pong! Roundtrip: \`${m.createdTimestamp - msg.createdTimestamp}ms\``);
});

addPrefix(['avatar', 'av'], async (msg, args) => {
  const user = msg.mentions.users.first() || msg.author;
  await msg.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${user.username}'s Avatar`).setImage(user.displayAvatarURL({ dynamic: true, size: 1024 }))] });
});

addPrefix(['userinfo', 'ui'], async (msg) => {
  const member = msg.mentions.members.first() || msg.member;
  const user   = member.user;
  await msg.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`👤 ${user.tag}`)
    .addFields(
      { name: 'ID', value: user.id, inline: true },
      { name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
      { name: 'Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
    )] });
});

addPrefix(['serverinfo', 'si'], async (msg) => {
  const g = msg.guild;
  const owner = await g.fetchOwner().catch(() => null);
  await msg.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🏠 ${g.name}`)
    .addFields(
      { name: 'Owner', value: owner?.user.tag || 'Unknown', inline: true },
      { name: 'Members', value: `${g.memberCount}`, inline: true },
      { name: 'Channels', value: `${g.channels.cache.size}`, inline: true },
    )] });
});

addPrefix(['ban'], async (msg, args) => {
  if (!msg.member.permissions.has(PermissionFlagsBits.BanMembers)) return msg.reply('❌ No permission.');
  const target = msg.mentions.users.first();
  if (!target) return msg.reply('❌ Mention a user.');
  const reason = args.slice(1).join(' ') || 'No reason';
  await msg.guild.members.ban(target, { reason }).catch(() => {});
  await msg.reply(`✅ Banned **${target.tag}**.`);
});

addPrefix(['kick'], async (msg) => {
  if (!msg.member.permissions.has(PermissionFlagsBits.KickMembers)) return msg.reply('❌ No permission.');
  const member = msg.mentions.members.first();
  if (!member) return msg.reply('❌ Mention a user.');
  await member.kick().catch(() => {});
  await msg.reply(`✅ Kicked **${member.user.tag}**.`);
});

addPrefix(['purge', 'clear'], async (msg, args) => {
  if (!msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return msg.reply('❌ No permission.');
  const n = parseInt(args[0]);
  if (!n || n < 1 || n > 100) return msg.reply('❌ Provide a number 1-100.');
  await msg.channel.bulkDelete(n + 1, true).catch(() => {});
});

addPrefix(['warn'], async (msg, args) => {
  if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return msg.reply('❌ No permission.');
  const target = msg.mentions.users.first();
  if (!target) return msg.reply('❌ Mention a user.');
  const reason = args.slice(1).join(' ') || 'No reason';
  dbFns.addWarning(msg.guild.id, target.id, msg.author.id, reason);
  await msg.reply(`⚠️ Warned **${target.tag}** — ${reason}`);
});

addPrefix(['warns'], async (msg) => {
  const target = msg.mentions.users.first() || msg.author;
  const warns  = dbFns.getWarnings(msg.guild.id, target.id);
  await msg.reply({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`Warnings for ${target.tag}`)
    .setDescription(warns.length ? warns.map((w, i) => `**${i + 1}.** ${w.reason}`).join('\n') : 'No warnings.')] });
});

addPrefix(['help', 'h'], async (msg) => {
  const prefix = dbFns.getPrefix(msg.guild.id);
  await msg.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📖 Prefix Commands')
    .setDescription(`**Prefix:** \`${prefix}\`\n\n` +
      `\`ping\` — Latency\n\`avatar [@user]\` — Avatar\n\`userinfo [@user]\` — User info\n` +
      `\`serverinfo\` — Server info\n\`ban @user [reason]\` — Ban\n\`kick @user\` — Kick\n` +
      `\`purge <1-100>\` — Delete messages\n\`warn @user <reason>\` — Warn\n\`warns [@user]\` — View warnings\n\n` +
      `Use \`/\` for full slash command list.`)] });
});

// ─── Client Setup ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  rest: { timeout: 15000 },
});

client.commands       = new Collection();
client.prefixCommands = PREFIX_COMMANDS;
client.cooldowns      = new Map();

for (const cmd of slashCommands) {
  client.commands.set(cmd.data.name, cmd);
}

// ─── Events ────────────────────────────────────────────────────────────────────

// Ready
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Serving ${client.guilds.cache.size} guild(s)`);
  client.user.setActivity('/help', { type: ActivityType.Listening });

  // Cache bot owner
  try {
    await client.application.fetch();
    client.botOwnerId = client.application.owner?.id ?? null;
    if (client.botOwnerId) console.log(`[Auth] Bot owner: ${client.botOwnerId}`);
  } catch (err) {
    console.warn('[Auth] Could not fetch owner:', err.message);
    client.botOwnerId = null;
  }

  // Auto-register slash commands globally
  if (process.env.CLIENT_ID) {
    try {
      const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
        body: slashCommands.map(c => c.data.toJSON()),
      });
      console.log(`✅ Registered ${slashCommands.length} slash commands globally.`);
    } catch (err) {
      console.error('[Commands] Failed to register slash commands:', err.message);
    }
  } else {
    console.warn('[Commands] CLIENT_ID not set — slash commands not auto-registered.');
  }
});

// Interaction (slash commands)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (interaction.commandName !== 'setrole') {
    if (!hasAccess(interaction.member, interaction.guild, client.botOwnerId)) {
      const cfg = dbFns.getGuildConfig(interaction.guild.id);
      return denyAccess(interaction, cfg?.bot_role);
    }
  }

  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    const reply = { content: '❌ An error occurred executing this command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

// Messages (prefix commands + automod)
const spamTracker = new Map();
const URL_REGEX   = /https?:\/\/[^\s]+/gi;

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;

  const prefix = dbFns.getPrefix(message.guild.id);

  // Prefix commands
  if (message.content.startsWith(prefix)) {
    const args        = message.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    const command     = client.prefixCommands.get(commandName);

    if (command) {
      if (!hasAccess(message.member, message.guild, client.botOwnerId)) {
        const cfg = dbFns.getGuildConfig(message.guild.id);
        return denyAccess(message, cfg?.bot_role);
      }
      const cooldownKey = `${message.author.id}-${commandName}`;
      if (client.cooldowns.has(cooldownKey)) return message.reply('⏳ Please wait before using this command again.');
      client.cooldowns.set(cooldownKey, true);
      setTimeout(() => client.cooldowns.delete(cooldownKey), 3000);
      try { await command.execute(message, args, client); }
      catch (err) {
        console.error(`Prefix command error [${commandName}]:`, err);
        message.reply('❌ An error occurred.').catch(() => {});
      }
      return;
    }
  }

  // Automod
  const cfg = dbFns.getAutomodConfig(message.guild.id);
  const whitelisted = JSON.parse(cfg.whitelisted_channels || '[]');
  if (whitelisted.includes(message.channel.id)) return;

  const member = message.member;
  if (!member || member.permissions.has(PermissionFlagsBits.Administrator)) return;

  if (cfg.antispam) {
    const key   = `${message.guild.id}-${message.author.id}`;
    const now   = Date.now();
    const entry = spamTracker.get(key) || { count: 0, reset: now + 5000 };
    if (now > entry.reset) { entry.count = 1; entry.reset = now + 5000; }
    else entry.count++;
    spamTracker.set(key, entry);
    if (entry.count >= 6) {
      spamTracker.delete(key);
      try {
        await member.timeout(5 * 60_000, 'Automod: Spam detected');
        const m = await message.channel.send(`⚠️ ${message.author} muted 5 min for spamming.`);
        setTimeout(() => m.delete().catch(() => {}), 10_000);
      } catch {}
    }
  }

  if (cfg.antilinks) {
    URL_REGEX.lastIndex = 0;
    if (URL_REGEX.test(message.content)) {
      try {
        await message.delete();
        const m = await message.channel.send(`⚠️ ${message.author}, links are not allowed here.`);
        setTimeout(() => m.delete().catch(() => {}), 5000);
      } catch {}
      return;
    }
  }

  const badWords = JSON.parse(cfg.bad_words || '[]');
  if (badWords.length) {
    const lower = message.content.toLowerCase();
    if (badWords.some(w => lower.includes(w.toLowerCase()))) {
      try {
        await message.delete();
        const m = await message.channel.send(`⚠️ ${message.author}, that language is not allowed here.`);
        setTimeout(() => m.delete().catch(() => {}), 5000);
      } catch {}
    }
  }
});

// Welcome
client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = dbFns.getGuildConfig(member.guild.id);
  if (!cfg?.welcome_channel_id) return;
  const channel = member.guild.channels.cache.get(cfg.welcome_channel_id);
  if (!channel) return;
  const msg = (cfg.welcome_message || 'Welcome {mention} to **{server}**!')
    .replace('{mention}', member.toString())
    .replace('{user}', member.user.tag)
    .replace('{server}', member.guild.name)
    .replace('{membercount}', member.guild.memberCount);
  channel.send(msg).catch(() => {});
});

// Goodbye
client.on(Events.GuildMemberRemove, async (member) => {
  const cfg = dbFns.getGuildConfig(member.guild.id);
  if (!cfg?.bye_channel_id) return;
  const channel = member.guild.channels.cache.get(cfg.bye_channel_id);
  if (!channel) return;
  const msg = (cfg.bye_message || 'Goodbye {user}!')
    .replace('{user}', member.user.tag)
    .replace('{server}', member.guild.name)
    .replace('{membercount}', member.guild.memberCount);
  channel.send(msg).catch(() => {});
});

// ─── Cron: Scheduled Messages ──────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const due = dbFns.getDueSchedules(Date.now());
  for (const schedule of due) {
    try {
      const channel = await client.channels.fetch(schedule.channel_id).catch(() => null);
      if (!channel) { dbFns.deactivateSchedule(schedule.id); continue; }

      if (schedule.is_embed) {
        const data = JSON.parse(schedule.embed_data);
        await channel.send({ embeds: [new EmbedBuilder().setTitle(data.title).setDescription(data.description).setColor(data.color || 0x5865f2).setTimestamp()] });
      } else {
        await channel.send(schedule.content);
      }

      if (schedule.is_recurring && schedule.interval_minutes) {
        dbFns.updateScheduleTime(schedule.id, Date.now() + schedule.interval_minutes * 60_000);
      } else {
        dbFns.deactivateSchedule(schedule.id);
      }
    } catch (err) {
      console.error(`[Cron] Schedule #${schedule.id} error:`, err.message);
    }
  }
});

// Cooldown cleanup
setInterval(() => client.cooldowns.clear(), 60_000);

// ─── Login ─────────────────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set. Please set it in Railway environment variables.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
