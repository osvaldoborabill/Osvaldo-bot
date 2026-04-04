require('dotenv').config();
const { ShardingManager } = require('discord.js');
const http = require('http');

const manager = new ShardingManager('./index.js', {
  token: process.env.DISCORD_TOKEN,
  totalShards: 'auto',
  respawn: true,
});

manager.on('shardCreate', shard => {
  console.log(`[ShardManager] Shard ${shard.id} lançado`);
  shard.on('ready', () => console.log(`[Shard ${shard.id}] Pronto`));
  shard.on('disconnect', () => console.warn(`[Shard ${shard.id}] Desconectado`));
  shard.on('reconnecting', () => console.log(`[Shard ${shard.id}] Reconectando...`));
  shard.on('death', () => console.error(`[Shard ${shard.id}] Morreu — reiniciando`));
});

manager.spawn({ amount: 'auto', delay: 5500, timeout: 30000 })
  .then(() => console.log('[ShardManager] Todos os shards ativos'))
  .catch(console.error);

// ─── Health check server (Railway precisa de uma porta aberta) ────────────────
const PORT = process.env.PORT || 8080;
const START_TIME = Date.now();

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }

  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  const shardCount = manager.shards.size;
  const aliveShards = [...manager.shards.values()].filter(s => s.process && !s.process.killed).length;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    shards: { total: shardCount, alive: aliveShards },
    uptime_seconds: uptime,
    timestamp: new Date().toISOString(),
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Health] Servidor rodando na porta ${PORT}`);
});
