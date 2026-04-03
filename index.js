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
    if (!requirePermis
