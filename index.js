require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require('@discordjs/voice');

const play = require('play-dl');

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = "1486173778970017832";
const GUILD_ID = "1485405424977969184";

const MAX_CALLS = 3;

// ===== CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// ===== SISTEMA =====
const queues = new Map();

function canJoin(guildId) {
  return queues.size < MAX_CALLS || queues.has(guildId);
}

// ===== PLAYER =====
async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.songs.length === 0) {
    // espera 10s antes de sair (evita bug do Railway)
    setTimeout(() => {
      if (queue.songs.length === 0) {
        queue.connection.destroy();
        queues.delete(guildId);
      }
    }, 10000);
    return;
  }

  const song = queue.songs[0];

  try {
    const stream = await play.stream(song.url, {
      discordPlayerCompatibility: true
    });

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true
    });

    resource.volume.setVolume(queue.volume);

    queue.player.play(resource);

  } catch (err) {
    console.error("Erro ao tocar:", err);
    queue.songs.shift();
    playNext(guildId);
  }
}

// ===== COMANDOS =====
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Tocar música')
    .addStringOption(opt =>
      opt.setName('nome').setDescription('Nome ou link').setRequired(true)
    ),

  new SlashCommandBuilder().setName('skip').setDescription('Pular música'),
  new SlashCommandBuilder().setName('pause').setDescription('Pausar'),
  new SlashCommandBuilder().setName('resume').setDescription('Retomar'),
  new SlashCommandBuilder().setName('stop').setDescription('Parar'),
  new SlashCommandBuilder().setName('queue').setDescription('Ver fila'),

  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Volume')
    .addIntegerOption(opt =>
      opt.setName('valor').setDescription('0 a 100').setRequired(true)
    ),

  new SlashCommandBuilder().setName('loop').setDescription('Loop')
].map(cmd => cmd.toJSON());

// ===== REGISTRO =====
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log("🔄 Registrando comandos...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Comandos registrados!");
  } catch (err) {
    console.error(err);
  }
})();

// ===== INTERAÇÕES =====
client.on('interactionCreate', async interaction => {

  // BOTÕES
  if (interaction.isButton()) {
    const queue = queues.get(interaction.guildId);
    if (!queue) return;

    if (interaction.customId === 'skip') {
      queue.player.stop();
      return interaction.reply({ content: "⏭️ Skip!", ephemeral: true });
    }

    if (interaction.customId === 'pause') {
      queue.player.pause();
      return interaction.reply({ content: "⏸️ Pausado!", ephemeral: true });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { guildId } = interaction;

  // ===== PLAY =====
  if (interaction.commandName === 'play') {
    const query = interaction.options.getString('nome');
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel)
      return interaction.reply("❌ Entre em um canal de voz.");

    if (!canJoin(guildId))
      return interaction.reply("🚫 Limite de 3 calls.");

    let queue = queues.get(guildId);

    if (!queue) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator
      });

      const player = createAudioPlayer();

      queue = {
        connection,
        player,
        songs: [],
        volume: 0.5,
        loop: false,
        dj: interaction.user.id
      };

      queues.set(guildId, queue);
      connection.subscribe(player);

      player.on(AudioPlayerStatus.Idle, () => {
        if (!queue.loop) queue.songs.shift();
        playNext(guildId);
      });
    }

    const info = await play.search(query, {
      limit: 1,
      source: { youtube: "video" }
    });

    if (!info || info.length === 0)
      return interaction.reply("❌ Música não encontrada.");

    const song = {
      title: info[0].title,
      url: info[0].url
    };

    queue.songs.push(song);

    if (queue.songs.length === 1) playNext(guildId);

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('skip').setLabel('⏭️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pause').setLabel('⏸️').setStyle(ButtonStyle.Secondary)
    );

    return interaction.reply({
      content: `🎶 ${song.title}`,
      components: [buttons]
    });
  }

  // ===== QUEUE =====
  if (interaction.commandName === 'queue') {
    const queue = queues.get(guildId);
    if (!queue) return interaction.reply("❌ Fila vazia.");

    const list = queue.songs
      .map((s, i) => `${i + 1}. ${s.title}`)
      .slice(0, 10)
      .join("\n");

    return interaction.reply(`📃 Fila:\n${list}`);
  }

  // ===== SKIP =====
  if (interaction.commandName === 'skip') {
    const queue = queues.get(guildId);
    if (!queue) return interaction.reply("❌ Nada tocando.");

    queue.player.stop();
    return interaction.reply("⏭️ Pulado.");
  }

  // ===== PAUSE =====
  if (interaction.commandName === 'pause') {
    const queue = queues.get(guildId);
    if (!queue) return interaction.reply("❌ Nada tocando.");

    queue.player.pause();
    return interaction.reply("⏸️ Pausado.");
  }

  // ===== RESUME =====
  if (interaction.commandName === 'resume') {
    const queue = queues.get(guildId);
    if (!queue) return interaction.reply("❌ Nada tocando.");

    queue.player.unpause();
    return interaction.reply("▶️ Retomado.");
  }

  // ===== STOP =====
  if (interaction.commandName === 'stop') {
    const queue = queues.get(guildId);
    if (!queue) return interaction.reply("❌ Nada tocando.");

    queue.connection.destroy();
    queues.delete(guildId);

    return interaction.reply("🛑 Parado.");
  }

  // ===== VOLUME =====
  if (interaction.commandName === 'volume') {
    const queue = queues.get(guildId);
    if (!queue) return interaction.reply("❌ Nada tocando.");

    if (interaction.user.id !== queue.dj)
      return interaction.reply("❌ Apenas o DJ pode alterar.");

    const vol = interaction.options.getInteger('valor');

    queue.volume = vol / 100;

    return interaction.reply(`🔊 Volume: ${vol}%`);
  }

  // ===== LOOP =====
  if (interaction.commandName === 'loop') {
    const queue = queues.get(guildId);
    if (!queue) return interaction.reply("❌ Nada tocando.");

    queue.loop = !queue.loop;

    return interaction.reply(`🔁 Loop: ${queue.loop ? "ON" : "OFF"}`);
  }
});

// ===== ERROS =====
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

// ===== LOGIN =====
client.once('ready', () => {
  console.log(`🤖 Online como ${client.user.tag}`);
});

client.login(TOKEN);
