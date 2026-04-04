require('dotenv').config();
const { REST, Routes } = require('discord.js');
const path = require('path');
const fs = require('fs');

const commands = [];

function loadDir(dir) {
  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      loadDir(fullPath);
    } else if (item.endsWith('.js')) {
      const cmd = require(fullPath);
      if (cmd.data) commands.push(cmd.data.toJSON());
    }
  }
}
loadDir(path.join(__dirname, 'commands'));

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Registrando ${commands.length} slash commands...`);
    if (process.env.GUILD_ID) {
      // Rápido: só no servidor específico
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID || '', process.env.GUILD_ID), { body: commands });
      console.log('✅ Comandos registrados no servidor (instantâneo)');
    } else {
      // Global (pode levar até 1h)
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID || ''), { body: commands });
      console.log('✅ Comandos registrados globalmente (até 1h para aparecer)');
    }
  } catch (err) {
    console.error(err);
  }
})();
