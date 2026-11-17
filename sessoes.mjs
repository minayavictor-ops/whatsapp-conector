// Uma conexão de WhatsApp por pessoa. Cada navegador recebe da ponte do vaileads um cookie
// aleatório e secreto; a ponte o repassa no cabeçalho x-sessao. Cada cookie tem a sua própria
// sessão, com pasta própria no disco: ninguém enxerga o WhatsApp de outra pessoa.
// Sessões sem uso adormecem (o WhatsApp continua conectado como aparelho, só o servidor solta a
// conexão) e voltam sozinhas, sem novo QR Code, na próxima vez que a pessoa abrir a tela.
import crypto from 'node:crypto';
import path from 'node:path';
import { criarSessao } from './sessao.mjs';

const erro = (status, mensagem) => Object.assign(new Error(mensagem), { status });

export function criarGerente({ baileys, raiz, logger, limite = 6, ociosoMs = 20 * 60 * 1000 }) {
  const ativas = new Map();
  const chaveDe = (id) => crypto.createHash('sha256').update(`vai-whatsapp:${id}`).digest('hex').slice(0, 40);

  async function obter(id) {
    if (!/^[a-f0-9]{64}$/.test(String(id || ''))) throw erro(400, 'Este navegador ainda não tem uma sessão própria. Recarregue a página.');
    const chave = chaveDe(id);
    let item = ativas.get(chave);
    if (!item) {
      if (ativas.size >= limite) await adormecer(5 * 60 * 1000);
      if (ativas.size >= limite) throw erro(503, 'Muitas pessoas estão com o WhatsApp aberto agora. Tente de novo em alguns minutos.');
      const sessao = criarSessao({ baileys, pasta: path.join(raiz, chave), logger: logger.child ? logger.child({ sessao: chave.slice(0, 8) }) : logger });
      item = { sessao, ultimoUso: Date.now(), pronta: null };
      item.pronta = sessao.retomar().catch((e) => logger.error({ err: e.message }, 'falha ao retomar sessão'));
      ativas.set(chave, item);
    }
    item.ultimoUso = Date.now();
    await item.pronta;
    return item.sessao;
  }

  async function adormecer(semUsoHa = ociosoMs) {
    for (const [chave, item] of [...ativas]) {
      if (Date.now() - item.ultimoUso < semUsoHa) continue;
      if (item.sessao.status().extracao?.estado === 'rodando') continue;
      ativas.delete(chave);
      await item.sessao.encerrar().catch(() => {});
    }
  }

  const relogio = setInterval(() => { adormecer().catch(() => {}); }, 60 * 1000);
  relogio.unref?.();

  async function encerrarTodas() {
    clearInterval(relogio);
    const itens = [...ativas.values()];
    ativas.clear();
    await Promise.all(itens.map((i) => i.sessao.encerrar().catch(() => {})));
  }

  return { obter, adormecer, encerrarTodas, ativas: () => ativas.size };
}
