require('dotenv').config();
const { REST, Routes } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

// Coloque o ID do seu servidor (Coleguium ou de testes) para limpar os comandos presos lá
const guildId = 'COLOQUE_O_ID_DO_SEU_SERVIDOR_AQUI'; 

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('🗑️  Iniciando a faxina dos Slash Commands...');

    // 1. Limpa TODOS os comandos Globais
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('✅ Comandos Globais limpos com sucesso!');

    // 2. Limpa TODOS os comandos de Servidor (Guild)
    if (guildId !== 'COLOQUE_O_ID_DO_SEU_SERVIDOR_AQUI') {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
      console.log(`✅ Comandos do Servidor (${guildId}) limpos com sucesso!`);
    } else {
      console.log('⚠️ ID do servidor não configurado. Pulando limpeza de servidor.');
    }

    console.log('🚀 Pronto! Faxina concluída.');
    console.log('➡️  Agora inicie o seu bot (node index.js) para ele registrar os novos comandos atualizados.');
  } catch (error) {
    console.error('❌ Erro ao limpar comandos:', error);
  }
})();

