require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus
} = require('@discordjs/voice');

const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = "1486173778970017832";
const GUILD_ID = "1485405424977969184";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const queues = new Map();

// ===== PLAY NEXT =====
async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.songs.length === 0) {
    setTimeout(() => {
      if (queue.songs.length === 0) {
        queue.connection.destroy();
        queues.delete(guildId);
      }
    }, 15000);
    return;
  }

  const song = queue.songs[0];

  try {
    const stream = await play.stream(song.url, {
      discordPlayerCompatibility: true
    });

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type
    });

    queue.player.play(resource);

  } catch (err) {
    console.error("Erro stream:", err);
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
    )
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
})();

// ===== INTERAÇÃO =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'play') {
    const query = interaction.options.getString('nome');
    const vc = interaction.member.voice.channel;

    if (!vc) return interaction.reply("❌ Entre em call");

    let queue = queues.get(interaction.guildId);

    if (!queue) {
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      // 🔥 ESPERA FICAR PRONTO (ESSENCIAL)
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20000);
      } catch {
        connection.destroy();
        return interaction.reply("❌ Falha ao conectar no áudio");
      }

      const player = createAudioPlayer();

      queue = {
        connection,
        player,
        songs: []
      };

      queues.set(interaction.guildId, queue);

      connection.subscribe(player);

      player.on(AudioPlayerStatus.Idle, () => {
        queue.songs.shift();
        playNext(interaction.guildId);
      });
    }

    const result = await play.search(query, {
      limit: 1,
      source: { youtube: "video" }
    });

    if (!result.length)
      return interaction.reply("❌ Não encontrado");

    const song = {
      title: result[0].title,
      url: result[0].url
    };

    queue.songs.push(song);

    if (queue.songs.length === 1)
      playNext(interaction.guildId);

    return interaction.reply(`🎶 Tocando: ${song.title}`);
  }
});

// ===== ERROS =====
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.once('ready', () => {
  console.log(`🤖 Online ${client.user.tag}`);
});

client.login(TOKEN);
