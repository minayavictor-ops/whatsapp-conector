'use strict';
/* Máquina de Leads — extrator de contatos do WhatsApp (JavaScript puro). */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
const POR_PAGINA = 50;
const ICONE_WA = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3zm0 2a7 7 0 1 1-3.6 13l-.3-.2-2.4.6.6-2.3-.2-.4A7 7 0 0 1 12 5zm-2.6 3.4c-.2 0-.5 0-.7.3-.3.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.8 2.9 4.5 3.9 2.2.9 2.7.7 3.1.6.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2l-.4-.3-1.6-.8c-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.5.1a5.7 5.7 0 0 1-2.9-2.5c-.2-.4.2-.4.6-1.2.1-.1 0-.3 0-.4l-.8-1.8c-.2-.4-.3-.4-.5-.4h-.4z"/></svg>';

const estado = {
  status: null,
  grupos: [],
  gruposCarregados: false,
  carregandoGrupos: false,
  marcados: new Set(),
  linhas: [],
  meta: null,
  pagina: 1,
  extraindo: false,
  extracaoId: null,
  timerStatus: null,
  timerConfirmar: null,
};

// ================================================================ API
async function api(rota, corpo) {
  const opts = { method: corpo === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store' };
  if (corpo !== undefined) opts.body = JSON.stringify(corpo);
  let res;
  try {
    res = await fetch(`api/${rota}`, opts);
  } catch {
    throw new Error('Sem resposta do servidor. Confira a internet e tente de novo.');
  }
  if (res.redirected && /\/entrar/.test(res.url)) { location.href = '/entrar'; throw new Error('Sessão expirada.'); }
  let dados = {};
  try { dados = await res.json(); } catch { /* sem JSON */ }
  if (res.status === 401 && dados.entrar) { location.href = '/entrar'; throw new Error('Sessão expirada.'); }
  if (!res.ok) {
    const e = new Error(dados.erro || (res.status === 401 ? 'O conector recusou o acesso. Confira o token nas configurações.' : `Erro ${res.status}.`));
    e.status = res.status;
    throw e;
  }
  return dados;
}

// ================================================================ conexão
function agendarStatus(ms) {
  clearTimeout(estado.timerStatus);
  estado.timerStatus = setTimeout(atualizarStatus, document.hidden ? Math.max(ms, 30000) : ms);
}

async function atualizarStatus() {
  try {
    const st = await api('status');
    const antes = estado.status?.estado;
    estado.status = st;
    renderConexao();
    if (st.estado === 'conectado' && (!estado.gruposCarregados || antes !== 'conectado')) carregarGrupos(false);
    if (st.estado !== 'conectado') { estado.gruposCarregados = false; }
    const rapido = ['iniciando', 'aguardando', 'reconectando'].includes(st.estado) || st.sincronizando;
    agendarStatus(rapido ? 2000 : 15000);
  } catch (e) {
    renderConexaoErro(e.message);
    agendarStatus(8000);
  }
}

function formatarNumero(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const local = d.slice(4);
    return local.length === 9 ? `+55 (${ddd}) ${local.slice(0, 5)}-${local.slice(5)}` : `+55 (${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
  }
  return d ? `+${d}` : '';
}

function htmlFormCodigo(titulo) {
  const valor = esc($('#telCodigo')?.value || '');
  return `<div class="form-codigo">
    <label class="rotulo" for="telCodigo">${titulo}</label>
    <div class="linha"><input id="telCodigo" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="DDD + número" value="${valor}"><button type="button" class="btn-sec" data-acao="codigo">Gerar código</button></div>
    <p class="dica">Digite o número do WhatsApp que vai ser conectado. Use quando estiver no próprio celular e não der para ler o QR Code.</p>
  </div>`;
}

function htmlAviso(texto) {
  return texto ? `<div class="aviso" role="alert"><span>${esc(texto)}</span></div>` : '';
}

function renderConexao() {
  const st = estado.status;
  if (!st) return;
  const caixa = $('#conexao');
  const focoTel = document.activeElement?.id === 'telCodigo';
  const topo = { conectado: ['', 'WhatsApp conectado'], aguardando: ['espera', 'WhatsApp aguardando leitura'], iniciando: ['espera', 'Conectando o WhatsApp'], reconectando: ['espera', 'Reconectando o WhatsApp'] }[st.estado] || ['off', 'WhatsApp desconectado'];
  $('#topoStatus').innerHTML = `<span><i class="${topo[0]}"></i>${topo[1]}</span>`;

  let html = '';
  if (st.estado === 'conectado') {
    const eu = st.eu || {};
    html = `<span class="estado-pill ok"><i></i>Conectado</span>
      <div class="conta"><span class="avatar">${ICONE_WA}</span><div><strong>${esc(eu.nome || 'Sua conta do WhatsApp')}</strong><small>${esc(formatarNumero(eu.numero))}</small></div></div>
      <p class="sincronia"><b>${num(st.grupos)}</b> grupos · <b>${num(st.agenda)}</b> contatos salvos · <b>${num(st.conversas)}</b> conversas${st.sincronizando ? ' · sincronizando…' : ''}</p>
      ${st.sincronizando ? '<p class="dica">Logo depois de conectar, o WhatsApp manda a agenda e as conversas aos poucos. Os grupos já podem ser extraídos.</p>' : ''}
      ${htmlAviso(st.aviso)}
      <div class="linha-acoes"><button type="button" class="btn-sec perigo" data-acao="desconectar">Desconectar</button></div>`;
  } else if (st.estado === 'aguardando' && st.codigo) {
    html = `<span class="estado-pill espera"><i></i>Aguardando o código no celular</span>
      <div class="codigo-pareamento" aria-label="Código de conexão">${esc(st.codigo)}</div>
      <ol class="passos">
        <li>No celular, abra o <b>WhatsApp</b> e vá em <b>Aparelhos conectados</b>.</li>
        <li>Toque em <b>Conectar aparelho</b> e depois em <b>Conectar com número de telefone</b>.</li>
        <li>Digite o código acima.</li>
      </ol>
      <p class="dica">Código gerado para ${esc(formatarNumero(st.codigoPara))}. Esta tela atualiza sozinha quando a conexão terminar.</p>
      <div class="linha-acoes"><button type="button" class="btn-sec" data-acao="qr">Usar QR Code</button><button type="button" class="btn-sec" data-acao="cancelar">Cancelar</button></div>`;
  } else if (st.estado === 'aguardando' && st.qr) {
    html = `<span class="estado-pill espera"><i></i>Aguardando leitura do QR Code</span>
      <div class="qr-caixa"><img src="${esc(st.qr)}" alt="QR Code para conectar o WhatsApp" width="260" height="260"></div>
      <ol class="passos">
        <li>Abra o <b>WhatsApp</b> no celular.</li>
        <li>Toque em <b>Mais opções ⋮</b> (Android) ou em <b>Configurações</b> (iPhone) e depois em <b>Aparelhos conectados</b>.</li>
        <li>Toque em <b>Conectar aparelho</b> e aponte a câmera para este código.</li>
      </ol>
      <p class="dica">O código muda sozinho a cada poucos segundos. Esta tela atualiza automaticamente.</p>
      <div class="linha-acoes"><button type="button" class="btn-sec" data-acao="cancelar">Cancelar</button></div>
      ${htmlFormCodigo('Prefere conectar com um código?')}`;
  } else if (['iniciando', 'reconectando', 'aguardando'].includes(st.estado)) {
    html = `<span class="estado-pill espera"><i></i>${st.estado === 'reconectando' ? 'Reconectando…' : 'Abrindo a conexão…'}</span>
      <p class="dica">Falando com o WhatsApp. Leva alguns segundos.</p>
      <div class="linha-acoes"><button type="button" class="btn-sec" data-acao="cancelar">Cancelar</button></div>`;
  } else {
    html = `<span class="estado-pill"><i></i>Desconectado</span>
      ${htmlAviso(st.aviso)}
      <p>Conecte o WhatsApp de onde quer tirar os contatos. Ele entra como um aparelho conectado, igual ao WhatsApp Web, e o celular continua funcionando normalmente.</p>
      <button type="button" class="btn-ouro" data-acao="qr">Conectar com QR Code</button>
      ${htmlFormCodigo('Está no celular? Conecte com um código')}`;
  }
  if (caixa.dataset.html !== html) {
    caixa.innerHTML = html;
    caixa.dataset.html = html;
    if (focoTel) $('#telCodigo')?.focus();
  }
  const conectado = st.estado === 'conectado';
  $('#opcoes').disabled = !conectado;
  $('#infoAgenda').textContent = conectado ? `${num(st.agenda)} contatos salvos sincronizados` : 'Quem está na agenda do celular e usa WhatsApp';
  $('#infoConversas').textContent = conectado ? `${num(st.conversas)} pessoas com conversa aberta` : 'Pessoas com quem você já conversou';
  atualizarPrevia();
}

function renderConexaoErro(msg) {
  const caixa = $('#conexao');
  caixa.dataset.html = '';
  caixa.innerHTML = `<span class="estado-pill"><i></i>Sem contato com o conector</span>${htmlAviso(msg)}<p class="dica">Tentando de novo em alguns segundos.</p>`;
  $('#opcoes').disabled = true;
  atualizarPrevia();
}

async function acaoConexao(acao, botao) {
  if (acao === 'desconectar' && !botao.classList.contains('confirmar')) {
    botao.classList.add('confirmar');
    botao.textContent = 'Clique de novo para desconectar';
    clearTimeout(estado.timerConfirmar);
    estado.timerConfirmar = setTimeout(() => { botao.classList.remove('confirmar'); botao.textContent = 'Desconectar'; }, 4000);
    return;
  }
  botao.disabled = true;
  try {
    let st;
    if (acao === 'qr') {
      if (estado.status?.estado === 'aguardando') await api('cancelar', {});
      st = await api('conectar', {});
    } else if (acao === 'codigo') {
      let tel = ($('#telCodigo')?.value || '').replace(/\D/g, '');
      if (tel.length === 10 || tel.length === 11) tel = `55${tel}`;
      if (tel.length < 12 || tel.length > 15) { aviso('Digite o número com DDD, por exemplo (61) 99999-8888.'); botao.disabled = false; return; }
      st = await api('conectar', { telefone: tel });
    } else if (acao === 'cancelar') {
      st = await api('cancelar', {});
    } else if (acao === 'desconectar') {
      st = await api('desconectar', {});
      estado.grupos = []; estado.marcados.clear(); estado.gruposCarregados = false;
      renderGrupos();
    }
    if (st) { estado.status = st; renderConexao(); }
    agendarStatus(1500);
  } catch (e) {
    aviso(e.message);
    botao.disabled = false;
  }
}

// ================================================================ grupos
async function carregarGrupos(forcar) {
  if (estado.carregandoGrupos) return;
  estado.carregandoGrupos = true;
  if (!estado.grupos.length) $('#gruposInfo').textContent = 'Carregando seus grupos…';
  try {
    const r = await api(`grupos${forcar ? '?atualizar=1' : ''}`);
    estado.grupos = r.grupos || [];
    const ids = new Set(estado.grupos.map((g) => g.id));
    for (const id of [...estado.marcados]) if (!ids.has(id)) estado.marcados.delete(id);
    estado.gruposCarregados = true;
    renderGrupos();
    if (r.atualizando) { $('#gruposInfo').textContent += ' · atualizando…'; setTimeout(() => carregarGrupos(false), 4000); }
  } catch (e) {
    $('#gruposInfo').textContent = e.message;
  } finally {
    estado.carregandoGrupos = false;
  }
}

function gruposFiltrados() {
  const q = norm($('#buscaGrupo').value);
  let lista = q ? estado.grupos.filter((g) => norm(g.nome).includes(q)) : [...estado.grupos];
  if ($('#ordemGrupos input:checked')?.value === 'maiores') lista.sort((a, b) => b.membros - a.membros);
  return lista;
}

function renderGrupos() {
  const lista = gruposFiltrados();
  const conectado = estado.status?.estado === 'conectado';
  $('#listaGrupos').innerHTML = lista.map((g) => {
    const marcado = estado.marcados.has(g.id);
    const extras = `${g.souAdmin ? ' <span class="badge ouro">você é admin</span>' : ''}${g.comunidade ? ' <span class="badge">comunidade</span>' : ''}`;
    return `<li class="${marcado ? 'marcado' : ''}"><label>
      <input type="checkbox" data-g="${esc(g.id)}" ${marcado ? 'checked' : ''}>
      <span><div class="g-nome" title="${esc(g.nome)}">${esc(g.nome)}</div><div class="g-sub">${num(g.visiveis)} com número visível${extras}</div></span>
      <span class="g-qtd" title="Membros">${num(g.membros)}</span></label></li>`;
  }).join('') || `<li class="vazia">${!conectado ? 'Conecte o WhatsApp para ver seus grupos.' : estado.grupos.length ? 'Nenhum grupo com esse nome.' : estado.gruposCarregados ? 'Esta conta não participa de nenhum grupo.' : 'Carregando…'}</li>`;
  if (estado.gruposCarregados) $('#gruposInfo').textContent = `${num(estado.grupos.length)} grupos · ${num(estado.marcados.size)} marcados`;
  else if (!conectado) $('#gruposInfo').textContent = '';
  atualizarPrevia();
}

function atualizarPrevia() {
  const st = estado.status;
  const conectado = st?.estado === 'conectado';
  const usaGrupos = $('#fGrupos').checked;
  const usaAgenda = $('#fAgenda').checked;
  const usaConversas = $('#fConversas').checked;
  $('#blocoGrupos').hidden = !usaGrupos;
  let texto = 'Conecte o WhatsApp para começar.';
  let pode = false;
  if (conectado) {
    const partes = [];
    if (usaGrupos && estado.marcados.size) {
      const marcados = estado.grupos.filter((g) => estado.marcados.has(g.id));
      const visiveis = marcados.reduce((t, g) => t + g.visiveis, 0);
      partes.push(`<strong>${num(marcados.length)}</strong> ${marcados.length === 1 ? 'grupo' : 'grupos'} (até ${num(visiveis)} números)`);
    }
    if (usaAgenda) partes.push(`<strong>${num(st.agenda)}</strong> contatos salvos`);
    if (usaConversas) partes.push(`<strong>${num(st.conversas)}</strong> conversas`);
    pode = partes.length > 0;
    texto = pode ? `Vai extrair de ${partes.join(' + ')}. Números repetidos viram um contato só.` : usaGrupos ? 'Marque pelo menos um grupo, ou escolha a agenda ou as conversas.' : 'Escolha pelo menos uma fonte de contatos.';
  }
  $('#previa').innerHTML = texto;
  $('#btnExtrair').disabled = !pode || estado.extraindo;
}

// ================================================================ extração
function mostrarStatus(texto, ativo) {
  const b = $('#barraStatus');
  b.hidden = false;
  b.classList.toggle('concluido', !ativo);
  $('#statusTexto').textContent = texto;
  $('#btnParar').hidden = !ativo;
}

function aviso(msg, nivel) {
  const d = document.createElement('div');
  d.className = `aviso ${nivel === 'info' ? 'info' : ''}`;
  d.innerHTML = `<span>${esc(msg)}</span><button type="button" aria-label="Fechar">×</button>`;
  d.querySelector('button').onclick = () => d.remove();
  $('#avisos').append(d);
  if ($('#avisos').children.length > 4) $('#avisos').firstElementChild.remove();
}

function enriquecer(l) {
  const n = String(l.numero || '');
  const br = n.startsWith('55') && (n.length === 12 || n.length === 13);
  let ddd = '';
  let exibicao = '';
  let celularBR = n;
  if (br) {
    ddd = n.slice(2, 4);
    let local = n.slice(4);
    // números antigos de celular aparecem no WhatsApp sem o 9 da frente: devolve o 9
    if (local.length === 8 && /^[6-9]/.test(local)) local = `9${local}`;
    celularBR = `55${ddd}${local}`;
    exibicao = local.length === 9 ? `(${ddd}) ${local.slice(0, 5)}-${local.slice(5)}` : `(${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
  } else if (n) {
    exibicao = `+${n}`;
  }
  const nomeExib = l.nome || l.nomeWhatsApp || (l.username ? `@${l.username}` : '');
  return {
    ...l,
    br, ddd, exibicao, celularBR, nomeExib,
    busca: norm([nomeExib, l.nomeWhatsApp, l.username, n, celularBR, exibicao, (l.grupos || []).join(' ')].join(' ')),
  };
}

async function extrair() {
  if (estado.extraindo) return;
  const corpo = {
    grupos: $('#fGrupos').checked ? [...estado.marcados] : [],
    agenda: $('#fAgenda').checked,
    conversas: $('#fConversas').checked,
  };
  estado.extraindo = true;
  atualizarPrevia();
  $('#avisos').innerHTML = '';
  mostrarStatus('Iniciando a extração…', true);
  try {
    const job = await api('extrair', corpo);
    estado.extracaoId = job.id;
    let r = job;
    while (r.estado === 'rodando') {
      await pausa(1000);
      r = await api(`extracao?id=${encodeURIComponent(job.id)}&desde=0`);
      const partes = [r.etapa || 'Extraindo'];
      if (r.total) partes.push(`${num(r.feitos)} de ${num(r.total)} grupos`);
      mostrarStatus(partes.join(' · '), r.estado === 'rodando');
    }
    if (r.estado === 'erro') throw new Error(r.erro || 'A extração falhou.');
    if (r.itens === undefined) r = await api(`extracao?id=${encodeURIComponent(job.id)}&desde=0`);
    const linhas = [...r.itens];
    let proximo = r.proximo;
    while (proximo !== null && proximo !== undefined) {
      mostrarStatus(`Baixando a lista: ${num(linhas.length)} de ${num(r.linhas)} contatos`, true);
      const p = await api(`extracao?id=${encodeURIComponent(job.id)}&desde=${proximo}`);
      linhas.push(...p.itens);
      proximo = p.proximo;
    }
    const nomes = new Map(estado.grupos.map((g) => [g.id, g.nome]));
    estado.linhas = linhas.map(enriquecer);
    estado.meta = { em: new Date(), grupos: corpo.grupos.map((id) => nomes.get(id) || id), agenda: corpo.agenda, conversas: corpo.conversas, cancelada: r.estado === 'cancelada' };
    estado.pagina = 1;
    render();
    const visiveis = linhasVisiveis().length;
    mostrarStatus(`${r.estado === 'cancelada' ? 'Interrompida' : 'Concluída'}: ${num(linhas.length)} contatos encontrados${visiveis !== linhas.length ? `, ${num(visiveis)} dentro dos filtros` : ''}.`, false);
    if (window.matchMedia('(max-width: 1100px)').matches) $('#barraStatus').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    mostrarStatus('A extração não terminou.', false);
    aviso(e.message);
  } finally {
    estado.extraindo = false;
    atualizarPrevia();
  }
}

// ================================================================ resultados
function filtros() {
  const ddds = ($('#ddds').value.match(/\d{2}/g) || []);
  return { soBrasil: $('#soBrasil').checked, comOcultos: $('#comOcultos').checked, ddds: new Set(ddds), texto: norm($('#filtroTexto').value) };
}

function linhasVisiveis() {
  const f = filtros();
  return estado.linhas.filter((l) => {
    if (!l.numero) {
      if (!f.comOcultos || f.ddds.size) return false;
    } else {
      if (f.soBrasil && !l.br) return false;
      if (f.ddds.size && !(l.br && f.ddds.has(l.ddd))) return false;
    }
    if (f.texto && !l.busca.includes(f.texto)) return false;
    return true;
  });
}

function render() {
  const lista = linhasVisiveis();
  $('#kTotal').textContent = num(lista.length);
  $('#kNome').textContent = num(lista.filter((l) => l.nome || l.nomeWhatsApp).length);
  $('#kGrupos').textContent = num(lista.filter((l) => l.origens.includes('Grupo')).length);
  $('#kAgenda').textContent = num(lista.filter((l) => l.origens.includes('Agenda')).length);
  $('#kConversas').textContent = num(lista.filter((l) => l.origens.includes('Conversa')).length);

  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
  estado.pagina = Math.min(estado.pagina, paginas);
  const ini = (estado.pagina - 1) * POR_PAGINA;
  const pagina = lista.slice(ini, ini + POR_PAGINA);
  $('#vazio').hidden = estado.linhas.length > 0;
  $('#corpo').innerHTML = pagina.map(linhaHTML).join('')
    || (estado.linhas.length ? '<tr class="linha-vazia"><td colspan="4" class="nada">Nenhum contato com esses filtros.</td></tr>' : '');
  $('#paginacao').innerHTML = lista.length > POR_PAGINA
    ? `<button type="button" data-pag="-1" ${estado.pagina <= 1 ? 'disabled' : ''}>‹ Anterior</button><span>Página ${estado.pagina} de ${paginas} · ${num(lista.length)} contatos</span><button type="button" data-pag="1" ${estado.pagina >= paginas ? 'disabled' : ''}>Próxima ›</button>`
    : '';
  $('#expRotulo').textContent = lista.length ? `Exportar ${num(lista.length)}` : 'Exportar';
  $$('.btn-exp').forEach((b) => { b.disabled = !lista.length; });
}

function linhaHTML(l) {
  const sub = [];
  if (l.nome && l.nomeWhatsApp && norm(l.nome) !== norm(l.nomeWhatsApp)) sub.push(`No WhatsApp: ${esc(l.nomeWhatsApp)}`);
  if (l.username) sub.push(`@${esc(l.username)}`);
  const tel = l.numero
    ? `<div class="tel cel"><span class="t">${esc(l.exibicao)}</span><a class="wa" href="https://wa.me/${esc(l.numero)}" target="_blank" rel="noopener" title="Abrir conversa no WhatsApp">${ICONE_WA}</a></div>`
    : '<div class="tel oculto"><span class="t">número oculto</span></div>';
  const origens = l.origens.map((o) => `<span class="badge ${o === 'Grupo' ? '' : 'ouro'}">${esc(o)}</span>`).join('');
  const grupos = (l.grupos || []).slice(0, 2).map((g) => `<div title="${esc(g)}">${esc(g)}${l.admin?.includes(g) ? ' <small>(admin)</small>' : ''}</div>`).join('')
    + (l.grupos?.length > 2 ? `<small>+${num(l.grupos.length - 2)} ${l.grupos.length - 2 === 1 ? 'grupo' : 'grupos'}</small>` : '');
  return `<tr>
    <td><div class="nome">${l.nomeExib ? esc(l.nomeExib) : '<span class="nada">Sem nome</span>'}</div>${sub.length ? `<div class="sub">${sub.join(' · ')}</div>` : ''}</td>
    <td>${tel}</td>
    <td><div class="badges">${origens}</div></td>
    <td class="grupos-col">${grupos || '<span class="nada">—</span>'}</td>
  </tr>`;
}

// ================================================================ exportação
const COLUNAS = [
  ['Nome', 30], ['Nome no WhatsApp', 26], ['WhatsApp', 17], ['Celular', 17], ['DDD', 6],
  ['Origem', 20], ['Grupos', 48], ['Administrador em', 28], ['Link do WhatsApp', 30], ['Observação', 28],
];

function valoresLinha(l) {
  return [
    l.nome || '',
    l.nomeWhatsApp || (l.username ? `@${l.username}` : ''),
    l.numero || '',
    l.br ? l.exibicao : '',
    l.ddd || '',
    l.origens.join(', '),
    (l.grupos || []).join(' | '),
    (l.admin || []).join(' | '),
    l.numero ? `https://wa.me/${l.numero}` : '',
    l.numero ? '' : 'Número oculto pelo WhatsApp',
  ];
}

function csv(linhas) {
  const seguro = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita que o Excel trate nomes como fórmulas
    return `"${s.replace(/"/g, '""')}"`;
  };
  const corpo = [COLUNAS.map((c) => c[0]), ...linhas.map(valoresLinha)].map((r) => r.map(seguro).join(';')).join('\r\n');
  return new Blob([`﻿${corpo}`], { type: 'text/csv;charset=utf-8' });
}

const scripts = new Map();
function carregarScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => { scripts.delete(src); falha(new Error('Não consegui carregar o gerador de planilhas.')); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

async function xlsx(linhas) {
  await carregarScript('/vendor/exceljs.min.js');
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Máquina de Leads';
  wb.created = new Date();
  const ws = wb.addWorksheet('Contatos WhatsApp', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUNAS.map(([header, width]) => ({ header, width }));
  ws.getColumn(3).numFmt = '@';
  for (const l of linhas) {
    const v = valoresLinha(l);
    const row = ws.addRow(v);
    if (v[8]) row.getCell(9).value = { text: v[8], hyperlink: v[8] };
    row.getCell(9).font = { color: { argb: 'FF1D3A66' }, underline: Boolean(v[8]) };
  }
  const cab = ws.getRow(1);
  cab.height = 22;
  cab.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1F3A' } };
    c.alignment = { vertical: 'middle' };
    c.border = { bottom: { style: 'medium', color: { argb: 'FFC9A227' } } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUNAS.length } };

  const m = estado.meta || {};
  const f = filtros();
  const resumo = wb.addWorksheet('Resumo');
  resumo.columns = [{ width: 26 }, { width: 80 }];
  const linhasResumo = [
    ['Extraído em', (m.em || new Date()).toLocaleString('pt-BR')],
    ['Conta do WhatsApp', formatarNumero(estado.status?.eu?.numero)],
    ['Contatos exportados', linhas.length],
    ['Grupos', (m.grupos || []).join(' | ') || '—'],
    ['Contatos salvos (agenda)', m.agenda ? 'Sim' : 'Não'],
    ['Conversas', m.conversas ? 'Sim' : 'Não'],
    ['Filtros', [f.soBrasil ? 'só Brasil' : '', f.ddds.size ? `DDDs ${[...f.ddds].join(', ')}` : '', f.comOcultos ? 'com números ocultos' : '', f.texto ? `texto "${$('#filtroTexto').value}"` : ''].filter(Boolean).join(' · ') || 'nenhum'],
  ];
  linhasResumo.forEach((r) => { const row = resumo.addRow(r); row.getCell(1).font = { bold: true, color: { argb: 'FF0B1F3A' } }; row.getCell(2).alignment = { wrapText: true, vertical: 'top' }; });
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function baixar(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

async function exportar(formato, botao) {
  const linhas = linhasVisiveis();
  if (!linhas.length) return;
  const original = botao.textContent;
  botao.disabled = true;
  botao.textContent = '…';
  try {
    const data = new Date();
    const carimbo = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
    const blob = formato === 'csv' ? csv(linhas) : await xlsx(linhas);
    baixar(blob, `contatos-whatsapp-${carimbo}.${formato}`);
  } catch (e) {
    aviso(`Não foi possível exportar: ${e.message}`);
  } finally {
    botao.disabled = false;
    botao.textContent = original;
  }
}

// ================================================================ eventos
function ligarEventos() {
  $('#conexao').addEventListener('click', (e) => {
    const b = e.target.closest('[data-acao]');
    if (b) acaoConexao(b.dataset.acao, b);
  });
  $('#conexao').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'telCodigo') { e.preventDefault(); $('[data-acao="codigo"]')?.click(); }
  });
  $('#listaGrupos').addEventListener('change', (e) => {
    const id = e.target.dataset.g;
    if (!id) return;
    if (e.target.checked) estado.marcados.add(id); else estado.marcados.delete(id);
    e.target.closest('li').classList.toggle('marcado', e.target.checked);
    $('#gruposInfo').textContent = `${num(estado.grupos.length)} grupos · ${num(estado.marcados.size)} marcados`;
    atualizarPrevia();
  });
  $('#buscaGrupo').addEventListener('input', renderGrupos);
  $('#ordemGrupos').addEventListener('change', renderGrupos);
  $('#marcarTodos').addEventListener('click', () => { gruposFiltrados().forEach((g) => estado.marcados.add(g.id)); renderGrupos(); });
  $('#desmarcarTodos').addEventListener('click', () => { estado.marcados.clear(); renderGrupos(); });
  $('#atualizarGrupos').addEventListener('click', () => carregarGrupos(true));
  $$('#fGrupos, #fAgenda, #fConversas').forEach((c) => c.addEventListener('change', atualizarPrevia));
  $('#formExtrair').addEventListener('submit', (e) => { e.preventDefault(); extrair(); });
  $('#btnParar').addEventListener('click', () => { api('extracao/cancelar', {}).catch(() => {}); $('#statusTexto').textContent = 'Parando…'; });
  $$('#soBrasil, #comOcultos').forEach((c) => c.addEventListener('change', () => { estado.pagina = 1; render(); }));
  $$('#ddds, #filtroTexto').forEach((c) => c.addEventListener('input', () => { estado.pagina = 1; render(); }));
  $('#paginacao').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pag]');
    if (!b) return;
    estado.pagina += Number(b.dataset.pag);
    render();
    $('.tabela-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $$('.btn-exp').forEach((b) => b.addEventListener('click', () => exportar(b.dataset.formato, b)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) agendarStatus(200); });
}

ligarEventos();
render();
renderGrupos();
atualizarStatus();
