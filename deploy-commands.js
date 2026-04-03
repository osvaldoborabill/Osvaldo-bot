/**
 * deploy-commands.js
 *
 * Apaga TODOS os slash commands globais antigos e registra os novos.
 * Rode este script sempre que adicionar/remover comandos.
 *
 * Uso:
 *   node deploy-commands.js
 *
 * Variáveis de ambiente necessárias:
 *   DISCORD_TOKEN
 *   CLIENT_ID
 */

'use strict';

// Impede que o index.js faça login ao ser importado aqui
// Precisamos setar isso ANTES do require('./index')
process.env.DEPLOY_ONLY = 'true';

require('dotenv').config();

const { REST, Routes } = require('discord.js');

const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error('❌ Defina DISCORD_TOKEN e CLIENT_ID no .env ou nas variáveis do Railway.');
  process.exit(1);
}

// Importa a lista de slash commands definida no index.js
// O index.js exporta { slashCommands } no final
const { slashCommands } = require('./index');

const rest = new REST({ version: '10' }).setToken(token);

async function main() {
  try {
    // 1. Lista os comandos globais existentes
    console.log('🔍 Buscando comandos globais existentes...');
    const existing = await rest.get(Routes.applicationCommands(clientId));
    console.log(`   Encontrados: ${existing.length} comando(s).`);

    // 2. Apaga todos os antigos
    if (existing.length > 0) {
      console.log('\n🗑️  Apagando comandos antigos...');
      await Promise.all(
        existing.map(async (cmd) => {
          await rest.delete(Routes.applicationCommand(clientId, cmd.id));
          console.log(`   ✅ Apagado: /${cmd.name}`);
        })
      );
    } else {
      console.log('   Nenhum comando antigo para apagar.');
    }

    // 3. Registra os novos
    console.log(`\n📤 Registrando ${slashCommands.length} novo(s) comando(s)...`);
    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: slashCommands.map(c => c.data.toJSON()) }
    );
    console.log(`\n✅ ${data.length} comando(s) registrado(s) com sucesso!`);
    console.log('   Pode levar até 1 hora para propagar globalmente.');
    console.log('   Para testar instantaneamente, use registro por guild (adicione GUILD_ID).');

  } catch (err) {
    console.error('\n❌ Erro durante deploy:', err.message);
    if (err.status === 401) console.error('   Token inválido. Verifique DISCORD_TOKEN.');
    if (err.status === 403) console.error('   Sem permissão. Verifique CLIENT_ID.');
    process.exit(1);
  }
}

main();
