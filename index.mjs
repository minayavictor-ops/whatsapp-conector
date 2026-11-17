// Ponto de entrada do conector do WhatsApp (Render).
// Variáveis: CONECTOR_TOKEN (obrigatória), PORT (o Render define), PASTA_SESSAO, LIMITE_SESSOES e LOG_LEVEL (opcionais).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import * as baileys from 'baileys';
import { criarGerente } from './sessoes.mjs';
import { criarServidor } from './server.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const token = process.env.CONECTOR_TOKEN || '';
const porta = Number(process.env.PORT) || 10000;
const pasta = path.resolve(process.env.PASTA_SESSAO || path.join(aqui, 'sessao'));

if (!token) console.error('ATENÇÃO: falta a variável CONECTOR_TOKEN. O conector vai recusar todos os pedidos.');

const gerente = criarGerente({ baileys, raiz: path.join(pasta, 'pessoas'), logger, limite: Number(process.env.LIMITE_SESSOES) || 6 });
// A tela pode estar na pasta public/ ou solta na raiz do repositório (envio pelo site do GitHub).
const pastaPublica = existsSync(path.join(aqui, 'public', 'index.html')) ? path.join(aqui, 'public') : aqui;
const servidor = criarServidor({ gerente, token, pastaPublica, logger });

servidor.listen(porta, '0.0.0.0', () => {
  console.log(`Conector do WhatsApp ouvindo na porta ${porta}. Uma conexão por pessoa (até ${Number(process.env.LIMITE_SESSOES) || 6} abertas ao mesmo tempo).`);
});

async function sair() {
  await gerente.encerrarTodas().catch(() => {});
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', sair);
process.on('SIGINT', sair);
