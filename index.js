require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { loadCommands } = require('./handlers/commandHandler');
const db = require('./database');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.Message],
  rest: { timeout: 15000 },
});

// ─── Commands & Events ────────────────────────────────────────────────────────
loadCommands(client);

client.prefixCommands = new Map();
client.cooldowns = new Map();

function loadPrefixCommands(dir) {
  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      loadPrefixCommands(fullPath);
    } else if (item.endsWith('.js')) {
      const cmd = require(fullPath);
      if (cmd.name) {
        client.prefixCommands.set(cmd.name, cmd);
        if (cmd.aliases) cmd.aliases.forEach(a => client.prefixCommands.set(a, cmd));
      }
    }
  }
}
loadPrefixCommands(path.join(__dirname, 'prefix-commands'));
console.log(`Loaded ${client.prefixCommands.size} prefix commands.`);

const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// ─── Scheduled messages ───────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const { EmbedBuilder } = require('discord.js');
  const guildIds = new Set(client.guilds.cache.keys());
  const due = db.getDueSchedules(Date.now()).filter(s => guildIds.has(s.guild_id));

  for (const schedule of due) {
    try {
      const channel = await client.channels.fetch(schedule.channel_id).catch(() => null);
      if (!channel) { db.deactivateSchedule(schedule.id); continue; }

      if (schedule.is_embed) {
        const data = JSON.parse(schedule.embed_data);
        const embed = new EmbedBuilder().setTitle(data.title).setDescription(data.description).setColor(data.color || 0x5865F2).setTimestamp();
        await channel.send({ embeds: [embed] });
      } else {
        await channel.send(schedule.content);
      }

      if (schedule.is_recurring && schedule.interval_minutes) {
        db.updateScheduleTime(schedule.id, Date.now() + schedule.interval_minutes * 60 * 1000);
      } else {
        db.deactivateSchedule(schedule.id);
      }
    } catch (err) {
      console.error(`Schedule #${schedule.id} error:`, err.message);
    }
  }
});

// ─── Limpeza periódica de cooldowns ──────────────────────────────────────────
setInterval(() => { client.cooldowns?.clear(); }, 60 * 1000);

client.login(process.env.DISCORD_TOKEN);
