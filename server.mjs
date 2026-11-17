// Servidor HTTP do conector: tela do extrator e API. Tudo exige o token secreto,
// que só a ponte do vaileads (função /whatsapp no Netlify) conhece. A API também exige o
// cabeçalho x-sessao (cookie individual do navegador), que escolhe a conexão de cada pessoa.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ARQUIVOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

const SEGURANCA = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function tokenConfere(recebido, esperado) {
  if (!recebido || !esperado) return false;
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

function responder(res, status, corpo, cabecalhos = {}) {
  const ehJson = typeof corpo !== 'string' && !Buffer.isBuffer(corpo);
  const dados = ehJson ? JSON.stringify(corpo) : corpo;
  res.writeHead(status, { ...SEGURANCA, ...(ehJson ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...cabecalhos });
  res.end(dados);
}

async function lerJson(req) {
  let tamanho = 0;
  const partes = [];
  for await (const p of req) {
    tamanho += p.length;
    if (tamanho > 1_000_000) throw Object.assign(new Error('Pedido grande demais.'), { status: 413 });
    partes.push(p);
  }
  if (!partes.length) return {};
  try { return JSON.parse(Buffer.concat(partes).toString('utf8')); } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}

export function criarServidor({ gerente, token, pastaPublica, logger }) {
  const cacheArquivos = new Map();
  async function arquivo(nome) {
    if (!cacheArquivos.has(nome) || process.env.NODE_ENV === 'development') cacheArquivos.set(nome, await readFile(path.join(pastaPublica, nome)));
    return cacheArquivos.get(nome);
  }

  const rotas = {
    'GET /api/status': (sessao) => sessao.status(),
    'POST /api/conectar': (sessao, corpo) => sessao.conectar({ telefone: corpo.telefone }),
    'POST /api/cancelar': (sessao) => sessao.cancelar(),
    'POST /api/desconectar': (sessao) => sessao.desconectar(),
    'GET /api/grupos': async (sessao, _c, url) => {
      const forcar = url.searchParams.get('atualizar') === '1';
      let atualizando = false;
      try {
        await Promise.race([
          sessao.atualizarGrupos(forcar),
          new Promise((_, falha) => setTimeout(() => falha(Object.assign(new Error('demorou'), { demora: true })), 8000)),
        ]);
      } catch (e) {
        if (!e.demora) throw e;
        atualizando = true;
      }
      return { grupos: sessao.resumoGrupos(), atualizando, em: sessao.status().gruposEm };
    },
    'POST /api/extrair': (sessao, corpo) => sessao.iniciarExtracao(corpo),
    'POST /api/extracao/cancelar': (sessao) => sessao.cancelarExtracao(),
    'GET /api/extracao': (sessao, _c, url) => {
      const limite = Math.min(5000, Math.max(100, Number(url.searchParams.get('limite')) || 3000));
      return sessao.linhasExtracao(url.searchParams.get('id'), url.searchParams.get('desde'), limite);
    },
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://conector');
    try {
      if (url.pathname === '/saude') return responder(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
      if (!token) return responder(res, 503, { erro: 'Conector sem CONECTOR_TOKEN configurado.' });
      const recebido = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenConfere(recebido, token)) return responder(res, 401, { erro: 'Acesso negado.' });

      if (req.method === 'GET' && ARQUIVOS[url.pathname]) {
        const [nome, tipo] = ARQUIVOS[url.pathname];
        return responder(res, 200, await arquivo(nome), { 'content-type': tipo, ...(tipo.startsWith('text/html') ? { 'content-security-policy': CSP } : {}) });
      }
      const rota = rotas[`${req.method} ${url.pathname}`];
      if (!rota) return responder(res, 404, { erro: 'Rota não encontrada.' });
      const corpo = req.method === 'POST' ? await lerJson(req) : {};
      const sessao = await gerente.obter(req.headers['x-sessao']);
      const resposta = await rota(sessao, corpo, url);
      return responder(res, 200, resposta ?? {});
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) logger?.error({ err: e.message, rota: url.pathname }, 'erro na API');
      return responder(res, status, { erro: status >= 500 ? `Falha no conector: ${e.message}` : e.message });
    }
  });
}
