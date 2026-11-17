// Sessão do WhatsApp: login (QR Code ou código), sincronização de contatos e conversas,
// leitura de grupos e extração dos contatos. Só lê dados; nunca envia mensagens.
import { mkdir, readFile, rm, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';

const usuario = (jid) => String(jid || '').split('@')[0].split(':')[0];
const soDigitos = (v) => String(v || '').replace(/\D/g, '');

export function criarSessao({ baileys, pasta, logger, browser }) {
  const makeWASocket = baileys.makeWASocket || baileys.default;
  const { Browsers, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
  const ehPn = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
  const ehLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
  const ehPessoa = (jid) => ehPn(jid) || ehLid(jid);
  const pastaCredenciais = path.join(pasta, 'credenciais');
  const arquivoDados = path.join(pasta, 'dados.json');

  const s = {
    sock: null,
    estado: 'desconectado', // desconectado | iniciando | aguardando | conectado | reconectando
    qr: null,
    qrImagem: null,
    codigo: null,
    codigoPara: null,
    telefonePedido: null,
    eu: null,
    aviso: '',
    tentativas: 0,
    parando: false,
    versao: undefined,
    historico: { ativo: false, lotes: 0, progresso: null, ultimoEm: 0 },
    porPn: new Map(), // número (só dígitos) -> registro
    porLid: new Map(), // LID (só dígitos) -> registro
    lidParaPn: new Map(),
    conversas: new Set(), // registros de pessoas com conversa individual
    grupos: new Map(),
    gruposEm: 0,
    gruposPromessa: null,
    extracao: null,
    salvarTimer: null,
  };

  // ------------------------------------------------------------------ contatos
  function registro(pn, lid) {
    const peloNumero = pn ? s.porPn.get(pn) : undefined;
    const peloLid = lid ? s.porLid.get(lid) : undefined;
    let reg = peloNumero || peloLid || {};
    if (peloNumero && peloLid && peloNumero !== peloLid) {
      // o mesmo contato estava guardado duas vezes (pelo número e pelo LID): junta os dois
      for (const k of ['nome', 'notify', 'username', 'nomeConversa']) if (!peloNumero[k] && peloLid[k]) peloNumero[k] = peloLid[k];
      if (s.conversas.delete(peloLid)) s.conversas.add(peloNumero);
      reg = peloNumero;
    }
    if (pn) { reg.pn = pn; s.porPn.set(pn, reg); }
    if (lid) { reg.lid = lid; s.porLid.set(lid, reg); }
    if (pn && lid) s.lidParaPn.set(lid, pn);
    return reg;
  }

  function vincular(lidJid, pnJid) {
    if (!ehLid(lidJid) || !ehPn(pnJid)) return;
    registro(usuario(pnJid), usuario(lidJid));
    marcarAlterado();
  }

  function idsDe(c) {
    const pnJid = ehPn(c.id) ? c.id : ehPn(c.phoneNumber) ? c.phoneNumber : ehPn(c.pnJid) ? c.pnJid : null;
    const lidJid = ehLid(c.id) ? c.id : ehLid(c.lid) ? c.lid : ehLid(c.lidJid) ? c.lidJid : null;
    const lid = lidJid ? usuario(lidJid) : null;
    const pn = pnJid ? usuario(pnJid) : lid ? s.lidParaPn.get(lid) || null : null;
    return { pn, lid };
  }

  function guardarContato(c) {
    if (!c || !ehPessoa(c.id || c.phoneNumber || c.lid)) return null;
    const { pn, lid } = idsDe(c);
    if (!pn && !lid) return null;
    const reg = registro(pn, lid);
    if (c.name) reg.nome = String(c.name).trim();
    if (c.notify) reg.notify = String(c.notify).trim();
    else if (c.verifiedName && !reg.notify) reg.notify = String(c.verifiedName).trim();
    if (c.username) reg.username = String(c.username).trim();
    marcarAlterado();
    return reg;
  }

  function guardarConversa(chat) {
    if (!chat || !ehPessoa(chat.id)) return;
    const reg = guardarContato({ id: chat.id, phoneNumber: chat.pnJid, lid: chat.lidJid, username: chat.username });
    if (!reg) return;
    const nome = chat.name || chat.displayName;
    if (nome && !reg.nomeConversa) reg.nomeConversa = String(nome).trim();
    s.conversas.add(reg);
  }

  // ------------------------------------------------------------------ memória em disco
  function marcarAlterado() {
    if (s.salvarTimer) return;
    s.salvarTimer = setTimeout(() => { s.salvarTimer = null; salvarDados().catch((e) => logger.warn({ err: e.message }, 'falha ao salvar dados')); }, 10000);
    s.salvarTimer.unref?.();
  }

  async function salvarDados() {
    const regs = new Set([...s.porPn.values(), ...s.porLid.values()]);
    const lista = [...regs];
    const indice = new Map(lista.map((r, i) => [r, i]));
    const dados = {
      versao: 1,
      contatos: lista,
      conversas: [...s.conversas].map((r) => indice.get(r)).filter((i) => i !== undefined),
      lidParaPn: [...s.lidParaPn],
    };
    await mkdir(pasta, { recursive: true });
    const tmp = `${arquivoDados}.tmp`;
    await writeFile(tmp, JSON.stringify(dados));
    await rename(tmp, arquivoDados);
  }

  async function carregarDados() {
    try {
      const dados = JSON.parse(await readFile(arquivoDados, 'utf8'));
      for (const [lid, pn] of dados.lidParaPn || []) s.lidParaPn.set(lid, pn);
      const regs = (dados.contatos || []).map((r) => {
        const reg = registro(r.pn || null, r.lid || null);
        Object.assign(reg, r);
        return reg;
      });
      for (const i of dados.conversas || []) if (regs[i]) s.conversas.add(regs[i]);
    } catch { /* primeira vez: nada salvo ainda */ }
  }

  function limparMemoria() {
    s.porPn.clear(); s.porLid.clear(); s.lidParaPn.clear(); s.conversas.clear(); s.grupos.clear();
    s.gruposEm = 0; s.extracao = null; s.eu = null;
    s.historico = { ativo: false, lotes: 0, progresso: null, ultimoEm: 0 };
  }

  async function apagarSessao() {
    clearTimeout(s.salvarTimer); s.salvarTimer = null;
    await rm(pasta, { recursive: true, force: true });
    limparMemoria();
  }

  // ------------------------------------------------------------------ conexão
  async function versaoAtual() {
    if (s.versao !== undefined) return s.versao;
    try {
      const r = await Promise.race([fetchLatestBaileysVersion(), new Promise((_, n) => setTimeout(() => n(new Error('tempo')), 8000))]);
      s.versao = r?.version || null;
    } catch { s.versao = null; }
    return s.versao;
  }

  async function abrir() {
    s.estado = s.estado === 'reconectando' ? 'reconectando' : 'iniciando';
    s.qr = null; s.qrImagem = null; s.codigo = null;
    await mkdir(pastaCredenciais, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(pastaCredenciais);
    const versao = await versaoAtual();
    const sock = makeWASocket({
      auth: state,
      ...(versao ? { version: versao } : {}),
      browser: browser || Browsers.ubuntu('Chrome'),
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false, // o celular continua recebendo notificações normalmente
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    s.sock = sock;
    s.qrNesteSocket = false;
    const ev = sock.ev;
    ev.on('creds.update', saveCreds);
    ev.on('connection.update', (u) => { tratarConexao(sock, u).catch((e) => logger.error({ err: e.message }, 'conexão')); });
    ev.on('contacts.upsert', (cs) => cs.forEach(guardarContato));
    ev.on('contacts.update', (cs) => cs.forEach(guardarContato));
    ev.on('chats.upsert', (chats) => chats.forEach(guardarConversa));
    ev.on('lid-mapping.update', (m) => vincular(m?.lid, m?.pn));
    ev.on('messaging-history.set', ({ chats = [], contacts = [], lidPnMappings = [], progress }) => {
      for (const m of lidPnMappings || []) vincular(m.lid, m.pn);
      contacts.forEach(guardarContato);
      chats.forEach(guardarConversa);
      s.historico.ativo = true;
      s.historico.lotes += 1;
      s.historico.ultimoEm = Date.now();
      if (typeof progress === 'number') s.historico.progresso = progress;
      if (progress === 100) s.historico.ativo = false;
    });
    ev.on('messaging-history.status', ({ status }) => { if (status === 'complete') s.historico.ativo = false; });
    ev.on('groups.upsert', (gs) => gs.forEach((g) => s.grupos.set(g.id, g)));
    ev.on('groups.update', (gs) => gs.forEach((g) => { const atual = s.grupos.get(g.id); if (atual) Object.assign(atual, g); }));
    ev.on('group-participants.update', () => { s.gruposEm = 0; });
    return sock;
  }

  async function tratarConexao(sock, { connection, lastDisconnect, qr }) {
    if (sock !== s.sock) return;
    if (qr) {
      s.qrNesteSocket = true;
      s.estado = 'aguardando';
      s.qr = qr;
      s.qrImagem = await QRCode.toDataURL(qr, { margin: 1, width: 300, errorCorrectionLevel: 'M' });
      if (s.telefonePedido && !s.codigo) await pedirCodigo();
    }
    if (connection === 'open') {
      s.estado = 'conectado';
      s.qr = null; s.qrImagem = null; s.codigo = null; s.codigoPara = null; s.telefonePedido = null;
      s.tentativas = 0; s.aviso = '';
      const u = sock.user || {};
      s.eu = { numero: usuario(u.id), lid: u.lid ? usuario(u.lid) : null, nome: u.name || u.verifiedName || u.notify || '' };
      setTimeout(() => { atualizarGrupos(true).catch(() => {}); }, 2500).unref?.();
      return;
    }
    if (connection !== 'close') return;
    const codigo = lastDisconnect?.error?.output?.statusCode;
    s.sock = null;
    try { sock.end?.(undefined); } catch { /* já fechado */ }
    if (s.parando) return;
    if (codigo === DisconnectReason.loggedOut) {
      await apagarSessao();
      s.estado = 'desconectado';
      s.aviso = 'O WhatsApp encerrou esta conexão (ela foi removida no celular ou expirou). Conecte de novo.';
      return;
    }
    if (codigo === DisconnectReason.connectionReplaced) {
      s.estado = 'desconectado';
      s.aviso = 'Esta conexão foi aberta em outro lugar. Clique em Conectar para retomar aqui.';
      return;
    }
    if (codigo === DisconnectReason.forbidden) {
      s.estado = 'desconectado';
      s.aviso = 'O WhatsApp recusou a conexão desta conta. Tente de novo mais tarde.';
      return;
    }
    const semLogin = !sock.authState?.creds?.me;
    // 408 serve tanto para "QR expirou" quanto para "conexão caiu": só é expiração se o QR chegou a aparecer
    if (semLogin && codigo === DisconnectReason.timedOut && s.qrNesteSocket) {
      s.estado = 'desconectado';
      s.aviso = s.codigo ? 'O código expirou sem ser usado. Gere outro.' : 'O QR Code expirou sem ser lido. Clique em Conectar para gerar outro.';
      s.qr = null; s.qrImagem = null; s.codigo = null; s.telefonePedido = null;
      return;
    }
    s.tentativas += 1;
    if (s.tentativas > 6) {
      s.estado = 'desconectado';
      s.aviso = semLogin
        ? `Não consegui falar com o WhatsApp (código ${codigo ?? 'desconhecido'}). Confira se o conector tem internet e clique em Conectar de novo.`
        : `Não consegui manter a conexão com o WhatsApp (código ${codigo ?? 'desconhecido'}). Clique em Conectar para tentar de novo.`;
      return;
    }
    s.estado = 'reconectando';
    const espera = codigo === DisconnectReason.restartRequired ? 200 : Math.min(30000, 1000 * 2 ** s.tentativas);
    setTimeout(() => { abrir().catch((e) => { s.estado = 'desconectado'; s.aviso = `Falha ao reconectar: ${e.message}`; }); }, espera).unref?.();
  }

  async function pedirCodigo() {
    const tel = s.telefonePedido;
    if (!tel || !s.sock) return;
    try {
      const c = String(await s.sock.requestPairingCode(tel)).toUpperCase();
      s.codigo = c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
      s.codigoPara = tel;
      s.aviso = '';
    } catch (e) {
      logger.warn({ err: e.message }, 'falha no código de pareamento');
      s.aviso = 'Não consegui gerar o código. Confira o número (com DDI 55 e DDD) e tente de novo, ou use o QR Code.';
      s.telefonePedido = null;
    }
  }

  async function conectar({ telefone } = {}) {
    const tel = soDigitos(telefone);
    if (telefone !== undefined && tel && (tel.length < 10 || tel.length > 15)) {
      const e = new Error('Número inválido. Digite com DDI e DDD, por exemplo 5561999998888.');
      e.status = 422;
      throw e;
    }
    if (tel) { s.telefonePedido = tel; s.codigo = null; }
    s.aviso = '';
    if (s.sock) {
      if (tel && s.estado === 'aguardando') await pedirCodigo();
      return status();
    }
    s.tentativas = 0;
    await abrir();
    return status();
  }

  async function cancelar() {
    if (s.estado === 'conectado') return status();
    s.parando = true;
    try { s.sock?.end?.(undefined); } catch { /* nada */ }
    s.sock = null;
    s.estado = 'desconectado'; s.qr = null; s.qrImagem = null; s.codigo = null; s.telefonePedido = null; s.aviso = '';
    await rm(pastaCredenciais, { recursive: true, force: true });
    s.parando = false;
    return status();
  }

  async function desconectar() {
    s.parando = true;
    const sock = s.sock;
    try { await sock?.logout?.('Saiu pela Máquina de Leads'); } catch { /* já estava fora */ }
    try { sock?.end?.(undefined); } catch { /* nada */ }
    s.sock = null;
    await apagarSessao();
    s.estado = 'desconectado'; s.qr = null; s.qrImagem = null; s.codigo = null; s.telefonePedido = null; s.aviso = '';
    s.parando = false;
    return status();
  }

  async function retomar() {
    await carregarDados();
    try {
      await access(path.join(pastaCredenciais, 'creds.json'));
    } catch { return false; }
    await abrir();
    return true;
  }

  // ------------------------------------------------------------------ grupos
  function souEu(p) {
    if (!s.eu) return false;
    const ids = [p.id, p.phoneNumber, p.lid].filter(Boolean).map(usuario);
    return ids.includes(s.eu.numero) || (s.eu.lid && ids.includes(s.eu.lid));
  }

  function numeroDoParticipante(p) {
    const pnJid = ehPn(p.id) ? p.id : ehPn(p.phoneNumber) ? p.phoneNumber : null;
    const lidJid = ehLid(p.id) ? p.id : ehLid(p.lid) ? p.lid : null;
    if (pnJid && lidJid) vincular(lidJid, pnJid);
    const lid = lidJid ? usuario(lidJid) : null;
    const pn = pnJid ? usuario(pnJid) : lid ? s.lidParaPn.get(lid) || null : null;
    return { pn, lid };
  }

  async function atualizarGrupos(forcar = false) {
    if (!s.sock || s.estado !== 'conectado') throw Object.assign(new Error('Conecte o WhatsApp primeiro.'), { status: 409 });
    if (s.gruposPromessa) return s.gruposPromessa;
    if (!forcar && s.gruposEm && Date.now() - s.gruposEm < 60000) return s.grupos;
    s.gruposPromessa = (async () => {
      try {
        const todos = await s.sock.groupFetchAllParticipating();
        s.grupos = new Map(Object.entries(todos || {}));
        for (const g of s.grupos.values()) for (const p of g.participants || []) numeroDoParticipante(p);
        s.gruposEm = Date.now();
        return s.grupos;
      } finally { s.gruposPromessa = null; }
    })();
    return s.gruposPromessa;
  }

  function resumoGrupos() {
    return [...s.grupos.values()].map((g) => {
      const ps = g.participants || [];
      let visiveis = 0;
      let souAdmin = false;
      for (const p of ps) {
        if (souEu(p)) { souAdmin = Boolean(p.admin); continue; }
        if (numeroDoParticipante(p).pn) visiveis += 1;
      }
      return {
        id: g.id,
        nome: g.subject || '(grupo sem nome)',
        membros: ps.length || g.size || 0,
        visiveis,
        souAdmin,
        comunidade: Boolean(g.isCommunity || g.isCommunityAnnounce || g.linkedParent),
        avisos: Boolean(g.isCommunityAnnounce),
      };
    }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  // ------------------------------------------------------------------ extração
  async function resolverLids(lids) {
    const faltam = [...new Set(lids)].filter((l) => !s.lidParaPn.has(l));
    const lm = s.sock?.signalRepository?.lidMapping;
    if (!faltam.length || !lm?.getPNsForLIDs) return;
    for (let i = 0; i < faltam.length; i += 500) {
      try {
        const r = await lm.getPNsForLIDs(faltam.slice(i, i + 500).map((l) => `${l}@lid`));
        for (const m of r || []) vincular(`${usuario(m.lid)}@lid`, `${usuario(m.pn)}@s.whatsapp.net`);
      } catch (e) { logger.warn({ err: e.message }, 'falha ao converter LID'); }
    }
  }

  async function executarExtracao(job, { grupos = [], agenda = false, conversas = false }) {
    const linhas = new Map();
    const meu = s.eu ? new Set([s.eu.numero, s.eu.lid].filter(Boolean)) : new Set();
    const linhaDe = (pn, lid) => {
      if ((pn && meu.has(pn)) || (lid && meu.has(lid))) return null;
      const reg = (pn && s.porPn.get(pn)) || (lid && s.porLid.get(lid)) || null;
      const chave = pn || `lid:${lid}`;
      let l = linhas.get(chave);
      if (!l && lid && pn) { l = linhas.get(`lid:${lid}`); if (l) { linhas.delete(`lid:${lid}`); linhas.set(chave, l); } }
      if (!l) {
        l = { numero: pn || '', lid: lid || '', nome: '', nomeWhatsApp: '', username: '', origens: [], grupos: [], admin: [] };
        linhas.set(chave, l);
      }
      if (pn) l.numero = pn;
      if (reg) {
        l.nome = l.nome || reg.nome || '';
        l.nomeWhatsApp = l.nomeWhatsApp || reg.notify || reg.nomeConversa || '';
        l.username = l.username || reg.username || '';
      }
      return l;
    };
    const marcar = (l, origem) => { if (l && !l.origens.includes(origem)) l.origens.push(origem); };

    if (grupos.length) {
      job.etapa = 'Lendo os grupos no WhatsApp';
      await atualizarGrupos(true);
      const escolhidos = grupos.map((id) => s.grupos.get(id)).filter(Boolean);
      job.total = escolhidos.length;
      const semNumero = [];
      for (const g of escolhidos) for (const p of g.participants || []) { const { pn, lid } = numeroDoParticipante(p); if (!pn && lid) semNumero.push(lid); }
      await resolverLids(semNumero);
      for (const g of escolhidos) {
        if (job.cancelada) break;
        job.etapa = `Grupo: ${g.subject || 'sem nome'}`;
        for (const p of g.participants || []) {
          const { pn, lid } = numeroDoParticipante(p);
          if (!pn && !lid) continue;
          const l = linhaDe(pn, lid);
          if (!l) continue;
          if (!l.username && p.username) l.username = p.username;
          marcar(l, 'Grupo');
          const nomeGrupo = g.subject || '(grupo sem nome)';
          if (!l.grupos.includes(nomeGrupo)) l.grupos.push(nomeGrupo);
          if (p.admin && !l.admin.includes(nomeGrupo)) l.admin.push(nomeGrupo);
        }
        job.feitos += 1;
        await new Promise((ok) => setImmediate(ok));
      }
    }
    if (agenda && !job.cancelada) {
      job.etapa = 'Lendo os contatos salvos';
      for (const reg of new Set([...s.porPn.values(), ...s.porLid.values()])) {
        if (!reg.nome) continue;
        marcar(linhaDe(reg.pn || (reg.lid && s.lidParaPn.get(reg.lid)) || null, reg.lid || null), 'Agenda');
      }
    }
    if (conversas && !job.cancelada) {
      job.etapa = 'Lendo as conversas';
      for (const reg of s.conversas) marcar(linhaDe(reg.pn || (reg.lid && s.lidParaPn.get(reg.lid)) || null, reg.lid || null), 'Conversa');
    }
    job.linhas = [...linhas.values()].sort((a, b) => (a.nome || a.nomeWhatsApp || '~').localeCompare(b.nome || b.nomeWhatsApp || '~', 'pt-BR'));
  }

  function iniciarExtracao(opcoes = {}) {
    if (s.estado !== 'conectado') throw Object.assign(new Error('Conecte o WhatsApp primeiro.'), { status: 409 });
    if (s.extracao?.estado === 'rodando') throw Object.assign(new Error('Já existe uma extração em andamento.'), { status: 409 });
    const grupos = Array.isArray(opcoes.grupos) ? opcoes.grupos.filter((g) => typeof g === 'string' && g.endsWith('@g.us')).slice(0, 5000) : [];
    const agenda = Boolean(opcoes.agenda);
    const conversas = Boolean(opcoes.conversas);
    if (!grupos.length && !agenda && !conversas) throw Object.assign(new Error('Escolha pelo menos um grupo, a agenda ou as conversas.'), { status: 422 });
    const job = { id: crypto.randomUUID(), estado: 'rodando', etapa: 'Preparando', feitos: 0, total: grupos.length, linhas: [], erro: '', inicio: Date.now(), fim: 0, cancelada: false };
    s.extracao = job;
    executarExtracao(job, { grupos, agenda, conversas })
      .then(() => { job.estado = job.cancelada ? 'cancelada' : 'concluida'; })
      .catch((e) => { job.estado = 'erro'; job.erro = e.message || 'Falha na extração.'; logger.error({ err: e.message }, 'extração'); })
      .finally(() => { job.fim = Date.now(); job.etapa = ''; });
    return resumoExtracao();
  }

  function cancelarExtracao() {
    if (s.extracao?.estado === 'rodando') s.extracao.cancelada = true;
    return resumoExtracao();
  }

  function resumoExtracao() {
    const j = s.extracao;
    if (!j) return null;
    return { id: j.id, estado: j.estado, etapa: j.etapa, feitos: j.feitos, total: j.total, linhas: j.linhas.length, erro: j.erro, inicio: j.inicio, fim: j.fim };
  }

  function linhasExtracao(id, desde = 0, limite = 3000) {
    const j = s.extracao;
    if (!j || (id && j.id !== id)) throw Object.assign(new Error('Extração não encontrada. Rode de novo.'), { status: 404 });
    const ini = Math.max(0, Number(desde) || 0);
    return { ...resumoExtracao(), desde: ini, itens: j.estado === 'rodando' ? [] : j.linhas.slice(ini, ini + limite), proximo: ini + limite < j.linhas.length ? ini + limite : null };
  }

  // ------------------------------------------------------------------ status
  function status() {
    let agenda = 0;
    for (const reg of new Set([...s.porPn.values(), ...s.porLid.values()])) {
      if (reg.nome && !(s.eu && (reg.pn === s.eu.numero || (reg.lid && reg.lid === s.eu.lid)))) agenda += 1;
    }
    if (s.historico.ativo && Date.now() - s.historico.ultimoEm > 90000) s.historico.ativo = false;
    return {
      estado: s.estado,
      qr: s.estado === 'aguardando' && !s.codigo ? s.qrImagem : null,
      codigo: s.codigo,
      codigoPara: s.codigoPara,
      eu: s.eu,
      aviso: s.aviso,
      agenda,
      conversas: s.conversas.size,
      grupos: s.grupos.size,
      gruposEm: s.gruposEm,
      sincronizando: s.historico.ativo,
      progresso: s.historico.progresso,
      extracao: resumoExtracao(),
    };
  }

  async function encerrar() {
    clearTimeout(s.salvarTimer);
    s.salvarTimer = null;
    if (s.estado !== 'desconectado') await salvarDados().catch(() => {});
    s.parando = true;
    try { s.sock?.end?.(undefined); } catch { /* nada */ }
  }

  return {
    status, conectar, cancelar, desconectar, retomar, encerrar,
    atualizarGrupos, resumoGrupos, iniciarExtracao, cancelarExtracao, linhasExtracao,
    _interno: s,
  };
}
