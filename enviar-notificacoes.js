/**
 * Envia avisos de contas a vencer pelo WhatsApp (Green API).
 * Roda pelo GitHub Actions (agendado). Lê os dados do Firestore com uma chave de serviço.
 *
 * Como funciona o Green API: diferente do CallMeBot, aqui é UMA conta de WhatsApp sua
 * (conectada por QR Code) que envia mensagens para os números que você cadastrar no app.
 * Os destinatários não precisam ativar nada — só precisam ter o número cadastrado.
 *
 * Variáveis de ambiente (definidas como "secrets" no GitHub):
 *   SERVICE_ACCOUNT       -> conteúdo JSON da chave de serviço do Firebase
 *   APP_EMAIL             -> e-mail de login do app (para achar o usuário)
 *   GREENAPI_URL           -> apiUrl mostrado no console do Green API (ex.: https://7105.api.greenapi.com)
 *   GREENAPI_ID_INSTANCE   -> idInstance do seu instance no Green API
 *   GREENAPI_TOKEN_INSTANCE-> apiTokenInstance do seu instance no Green API
 *   JANELA_DIAS            -> (opcional) quantos dias à frente contam como "vencendo em breve".
 *                             Padrão: "5". As que vencem hoje têm seção própria.
 *
 * Além dos lembretes de vencimento, o serviço avisa quando um mês é QUITADO: assim que a
 * última conta em aberto de um mês é paga, sai uma mensagem de fechamento. O controle do que
 * já foi avisado fica em appSettings.notificacoes.mesesQuitadosAvisados, para a mensagem não
 * se repetir a cada execução. Se o mês voltar a ter conta em aberto, o aviso é rearmado.
 */

const admin = require('firebase-admin');

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const TZ = 'America/Sao_Paulo';
const JANELA_DIAS = parseInt(process.env.JANELA_DIAS || '5', 10);

const moeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retorna diferença em dias entre o vencimento da despesa e hoje (negativo = vencida, 0 = hoje, positivo = futuro)
// Usa dueDate (data completa) quando disponível; cai no due (dia do mês) para dados antigos
function getDueDiffDays(e, hoje) {
  if (e.dueDate) return Math.round((new Date(e.dueDate + 'T00:00:00') - hoje) / 86400000);
  if (e.due != null) return e.due - hoje.getDate();
  return null;
}

// Formata o vencimento para exibição na mensagem
function fmtDueMsg(e) {
  if (e.dueDate) { const p = e.dueDate.split('-'); return `${p[2]}/${p[1]}`; }
  if (e.due) return `dia ${e.due}`;
  return '?';
}

// Divide uma mensagem muito longa em partes (o Green API aceita até 20.000 caracteres por mensagem,
// então isso só entra em ação em casos extremos — é mais uma rede de segurança que uma necessidade)
function dividirMensagem(texto, maxLen = 15000) {
  const partes = [];
  let atual = '';
  const push = () => { if (atual) { partes.push(atual); atual = ''; } };
  for (const bloco of texto.split('\n\n')) {
    if (bloco.length > maxLen) {
      push();
      let sub = '';
      for (const linha of bloco.split('\n')) {
        if (sub && (sub + '\n' + linha).length > maxLen) { partes.push(sub); sub = linha; }
        else sub = sub ? sub + '\n' + linha : linha;
      }
      if (sub) atual = sub;
    } else if (atual && (atual + '\n\n' + bloco).length > maxLen) {
      push(); atual = bloco;
    } else {
      atual = atual ? atual + '\n\n' + bloco : bloco;
    }
  }
  push();
  return partes;
}

function hojeSaoPaulo() {
  const now = new Date();
  const get = (opt) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opt }).format(now));
  return { ano: get({ year: 'numeric' }), mesIndex: get({ month: 'numeric' }) - 1, dia: get({ day: 'numeric' }) };
}

// Formata um número de telefone brasileiro (com ou sem +, espaços, etc.) para o formato de chatId do Green API
function paraChatId(numero) {
  const digitos = String(numero).replace(/\D/g, '');
  return `${digitos}@c.us`;
}

async function enviarGreenAPI(numero, texto) {
  const { GREENAPI_URL, GREENAPI_ID_INSTANCE, GREENAPI_TOKEN_INSTANCE } = process.env;
  const url = `${GREENAPI_URL}/waInstance${GREENAPI_ID_INSTANCE}/sendMessage/${GREENAPI_TOKEN_INSTANCE}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: paraChatId(numero), message: texto }),
  });
  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body: body.slice(0, 300) };
}

// Resumo de um mês: quantas despesas tem, quantas estão em aberto e o total pago
function resumoDoMes(database, anoKey, mesNome) {
  const despesas = database?.[anoKey]?.monthlyDetails?.[mesNome]?.expenses || [];
  const emAberto = despesas.filter((e) => !e.paid);
  return {
    ano: anoKey,
    mes: mesNome,
    chave: `${mesNome}/${anoKey}`,
    total: despesas.length,
    emAberto: emAberto.length,
    quitado: despesas.length > 0 && emAberto.length === 0,
    valorPago: despesas.filter((e) => e.paid).reduce((s, e) => s + (e.value || 0), 0),
  };
}

/**
 * Decide se deve sair o aviso de "mês quitado".
 * - candidatos: mês anterior e mês atual (os dois que o sistema acompanha).
 * - um mês só é avisado uma vez; se voltar a ter conta em aberto, o aviso é rearmado.
 * - na primeira execução (estado ainda inexistente) o serviço apenas registra a situação,
 *   sem disparar mensagem, para não avisar meses que já estavam fechados antes.
 * Devolve { avisar, estado, inicializou }.
 */
function avaliarMesesQuitados(candidatos, estadoAtual) {
  const primeiraVez = !Array.isArray(estadoAtual);
  const jaAvisados = new Set(primeiraVez ? [] : estadoAtual);

  // mês que voltou a ter conta em aberto deixa de estar avisado
  for (const c of candidatos) {
    if (c.emAberto > 0) jaAvisados.delete(c.chave);
  }

  const quitadosNovos = candidatos.filter((c) => c.quitado && !jaAvisados.has(c.chave));

  if (primeiraVez) {
    // registra a situação atual sem enviar nada
    quitadosNovos.forEach((c) => jaAvisados.add(c.chave));
    return { avisar: null, estado: [...jaAvisados], inicializou: true };
  }

  // no máximo um aviso por execução: o mês mais recente que acabou de fechar
  const avisar = quitadosNovos.length ? quitadosNovos[quitadosNovos.length - 1] : null;
  if (avisar) jaAvisados.add(avisar.chave);
  return { avisar, estado: [...jaAvisados], inicializou: false };
}

// Mensagem de fechamento do mês
function montarMensagemQuitado(resumo, proximos) {
  let msg = `✅ *Contas em dia!* — ${resumo.mes}/${resumo.ano}\n\n`;
  msg += `Todas as contas de *${resumo.mes}/${resumo.ano}* foram pagas. 🎉\n\n`;
  msg += `*Contas pagas:* ${resumo.total}\n`;
  msg += `*Total pago:* ${moeda(resumo.valorPago)}`;
  if (proximos && proximos.qtd > 0) {
    msg += `\n\n_Em ${proximos.mes}/${proximos.ano} há ${proximos.qtd} conta(s) em aberto, somando ${moeda(proximos.valor)}._`;
  }
  msg += `\n\n_Controle Financeiro PRO_`;
  return msg;
}

async function main() {
  if (!process.env.SERVICE_ACCOUNT) throw new Error('Falta o secret SERVICE_ACCOUNT.');
  if (!process.env.APP_EMAIL) throw new Error('Falta o secret APP_EMAIL.');
  if (!process.env.GREENAPI_URL) throw new Error('Falta o secret GREENAPI_URL.');
  if (!process.env.GREENAPI_ID_INSTANCE) throw new Error('Falta o secret GREENAPI_ID_INSTANCE.');
  if (!process.env.GREENAPI_TOKEN_INSTANCE) throw new Error('Falta o secret GREENAPI_TOKEN_INSTANCE.');

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT)) });

  const user = await admin.auth().getUserByEmail(process.env.APP_EMAIL);
  const userRef = admin.firestore().collection('users').doc(user.uid);
  const snap = await userRef.get();
  if (!snap.exists) { console.log('Documento do usuário não encontrado. Nada a fazer.'); return; }
  const database = snap.data();

  const cfg = database.appSettings || database['__settings__'] || {};
  const contatos = (cfg.whatsappContacts || []).filter((c) => c.number);

  // MODO TESTE: envia uma mensagem de verificação e encerra (ignora vencimentos)
  if (process.env.MODO_TESTE === 'true' || process.env.MODO_TESTE === '1') {
    if (contatos.length === 0) { console.log('TESTE: nenhum contato com número cadastrado.'); return; }
    const teste = '✅ *Teste — Controle Financeiro PRO*\n\nSe você recebeu esta mensagem, as notificações de WhatsApp estão funcionando! 🎉';
    for (const c of contatos) {
      try {
        const r = await enviarGreenAPI(c.number, teste);
        console.log(`TESTE enviado para ${c.name} (${c.number}): status ${r.status} | resposta: ${r.body}`);
      } catch (err) {
        console.error(`TESTE falhou para ${c.name}:`, err.message);
      }
      await sleep(2000);
    }
    console.log('TESTE concluído.');
    return;
  }

  // Data de hoje à meia-noite no fuso de SP
  function hojeMidnight() {
    const get = (opt) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opt }).format(new Date()));
    const ano = get({ year: 'numeric' }), mes = get({ month: 'numeric' }), dia = get({ day: 'numeric' });
    return new Date(ano, mes - 1, dia);
  }
  const hojeDate = hojeMidnight();
  const { ano, mesIndex, dia } = hojeSaoPaulo();
  const anoKey = String(ano);
  const mesNome = MESES[mesIndex];

  // Mês de competência baseado no status de pagamento:
  // → Se o mês anterior ainda tem despesas NÃO pagas: fica no mês anterior
  // → Se todas as despesas do mês anterior estão pagas: vira o mês atual
  const mesPrevIdx = mesIndex === 0 ? 11 : mesIndex - 1;
  const anoPrevKey = mesIndex === 0 ? String(ano - 1) : anoKey;
  const mesNomePrev = MESES[mesPrevIdx];

  const despesasMesPrev = database?.[anoPrevKey]?.monthlyDetails?.[mesNomePrev]?.expenses || [];
  const prevTemNaoPagas = despesasMesPrev.some(e => !e.paid);

  const usaMesAnterior = prevTemNaoPagas;
  const mesComp = usaMesAnterior ? mesNomePrev : mesNome;
  const anoComp = usaMesAnterior ? anoPrevKey : anoKey;
  const mesOpostoNome = usaMesAnterior ? mesNome : mesNomePrev;
  const anoOposto = usaMesAnterior ? anoKey : anoPrevKey;

  console.log(`Mês anterior (${mesNomePrev}): ${despesasMesPrev.filter(e => !e.paid).length} não pagas — Competência: ${mesComp}/${anoComp}`);

  // Despesas do mês de competência (primário: vencimentos + orçamento)
  const despesasComp = database?.[anoComp]?.monthlyDetails?.[mesComp]?.expenses || [];
  // Despesas do mês oposto (secundário: captura pendências dos dois lados)
  const despesasOposto = database?.[anoOposto]?.monthlyDetails?.[mesOpostoNome]?.expenses || [];

  // Mescla deduplicando — competência tem prioridade
  const seen = new Set();
  const despesas = [];
  for (const e of [...despesasComp, ...despesasOposto]) {
    const key = `${(e.name || '').toLowerCase().trim()}__${e.dueDate || e.due}`;
    if (!seen.has(key)) { seen.add(key); despesas.push(e); }
  }
  console.log(`Despesas: ${despesasComp.length} de ${mesComp} + ${despesasOposto.length} de ${mesOpostoNome} = ${despesas.length} (após dedup)`);

  const emBreve = [];
  const hoje = [];
  const vencidas = [];
  const pagas = [];
  for (const e of despesas) {
    const venc = parseInt(e.due, 10);
    if (e.paid) {
      pagas.push({ e, venc: isNaN(venc) ? null : venc });
      continue;
    }
    if (!e.dueDate && (isNaN(venc) || !venc)) continue;
    const diff = getDueDiffDays(e, hojeDate);
    if (diff === null) continue;
    if (diff < 0) vencidas.push({ e, venc, diff });
    else if (diff === 0) hoje.push({ e, venc });
    else if (diff <= JANELA_DIAS) emBreve.push({ e, venc, diff });
  }

  // ===== Aviso de mês quitado =====
  // Antes, quando a última conta em aberto era paga, o serviço simplesmente parava de enviar
  // e o usuário ficava sem retorno. Agora sai uma mensagem de fechamento do mês.
  const candidatosQuitados = [
    resumoDoMes(database, anoPrevKey, mesNomePrev),
    resumoDoMes(database, anoKey, mesNome),
  ];
  const estadoSalvo = (cfg.notificacoes || {}).mesesQuitadosAvisados;
  const { avisar: mesQuitado, estado: novoEstado, inicializou } = avaliarMesesQuitados(candidatosQuitados, estadoSalvo);

  if (inicializou) {
    console.log(`Primeira execução do aviso de mês quitado. Situação registrada: ${novoEstado.join(', ') || '(nenhum mês fechado)'}. Nada enviado por isso.`);
  }
  if (JSON.stringify(novoEstado) !== JSON.stringify(estadoSalvo || [])) {
    try {
      await userRef.set({ appSettings: { notificacoes: { mesesQuitadosAvisados: novoEstado } } }, { merge: true });
    } catch (err) {
      console.error('Não foi possível gravar o controle de meses avisados:', err.message);
    }
  }

  let msgQuitado = null;
  if (mesQuitado) {
    // se o outro mês ainda tem contas em aberto, a mensagem já avisa
    const outro = candidatosQuitados.find((c) => c.chave !== mesQuitado.chave && c.emAberto > 0);
    const proximos = outro
      ? {
          mes: outro.mes,
          ano: outro.ano,
          qtd: outro.emAberto,
          valor: (database?.[outro.ano]?.monthlyDetails?.[outro.mes]?.expenses || [])
            .filter((e) => !e.paid)
            .reduce((s, e) => s + (e.value || 0), 0),
        }
      : null;
    msgQuitado = montarMensagemQuitado(mesQuitado, proximos);
    console.log(`Mês quitado: ${mesQuitado.chave} (${mesQuitado.total} conta(s), ${moeda(mesQuitado.valorPago)}). Enviando aviso de fechamento.`);
  }

  if (emBreve.length === 0 && hoje.length === 0 && vencidas.length === 0) {
    if (!msgQuitado) {
      console.log('Nada a vencer (em breve/hoje) nem vencido. Nada será enviado.');
      return;
    }
    if (contatos.length === 0) { console.log('Nenhum contato com número cadastrado. Nada enviado.'); return; }
    for (const c of contatos) {
      try {
        const r = await enviarGreenAPI(c.number, msgQuitado);
        console.log(`Aviso de mês quitado enviado para ${c.name} (${c.number}): status ${r.status} | ${r.body}`);
      } catch (err) {
        console.error(`Falha ao enviar o aviso de mês quitado para ${c.name}:`, err.message);
      }
      await sleep(2000);
    }
    console.log('Concluído.');
    return;
  }

  // ===== Página 1: DESPESAS =====
  let msgDespesas = `🔔 *Lembrete de contas* — ${mesComp}/${anoComp}\n`;

  if (emBreve.length) {
    msgDespesas += `\n*Vencendo em breve:*\n`;
    emBreve.sort((a, b) => a.diff - b.diff);
    for (const { e, diff } of emBreve) {
      const quando = diff === 1 ? `vence amanhã (${fmtDueMsg(e)})` : `faltam ${diff} dias (vence ${fmtDueMsg(e)})`;
      msgDespesas += `• ${e.name} — ${moeda(e.value)} — ${quando}\n`;
    }
  }
  if (hoje.length) {
    msgDespesas += `\n*Vencendo hoje:*\n`;
    for (const { e } of hoje) {
      msgDespesas += `• ${e.name} — ${moeda(e.value)} — vence hoje (${fmtDueMsg(e)})\n`;
    }
  }
  if (vencidas.length) {
    msgDespesas += `\n*Vencidas (não pagas):*\n`;
    vencidas.sort((a, b) => a.diff - b.diff);
    for (const { e, diff } of vencidas) {
      const atraso = Math.abs(diff);
      const txtAtraso = atraso === 1 ? 'atrasada há 1 dia' : `atrasada há ${atraso} dias`;
      msgDespesas += `• ${e.name} — ${moeda(e.value)} — venceu ${fmtDueMsg(e)} (${txtAtraso})\n`;
    }
  }

  const totalAVencer = emBreve.reduce((s, x) => s + (x.e.value || 0), 0);
  const totalHoje = hoje.reduce((s, x) => s + (x.e.value || 0), 0);
  const totalVencidas = vencidas.reduce((s, x) => s + (x.e.value || 0), 0);
  const totalPago = pagas.reduce((s, x) => s + (x.e.value || 0), 0);
  const totalAPagar = despesas.filter((e) => !e.paid).reduce((s, e) => s + (e.value || 0), 0);
  if (emBreve.length) msgDespesas += `\n*Total a vencer:* ${moeda(totalAVencer)}`;
  if (hoje.length) msgDespesas += `\n*Total vencendo hoje:* ${moeda(totalHoje)}`;
  if (vencidas.length) msgDespesas += `\n*Total em atraso:* ${moeda(totalVencidas)}`;
  msgDespesas += `\n*Total a pagar (todas as despesas):* ${moeda(totalAPagar)}`;
  if (pagas.length) msgDespesas += `\n*Total pago:* ${moeda(totalPago)}`;
  msgDespesas += `\n\n_Controle Financeiro PRO_`;

  // ===== Página 2: ORÇAMENTOS (usa mês de competência) =====
  const budgets = database?.[anoComp]?.budgets || [];
  const categorias = database?.[anoComp]?.expenseCategories || [];
  const nomeCat = (id) => ((categorias.find((c) => c.id === id) || {}).name) || 'Categoria';
  const LIMITE_APERTADO = 80;

  let msgOrcamentos = `📊 *Orçamentos do mês* — ${mesComp}/${anoComp}`;
  if (budgets.length === 0) {
    msgOrcamentos += `\n\n_Nenhum orçamento cadastrado._`;
  } else {
    const dentro = [], apertado = [], estourado = [];
    for (const b of budgets) {
      if (!b.limit || b.limit <= 0) continue;
      // Orçamento usa só o mês de competência (não mescla meses)
      const gasto = despesasComp.filter((e) => e.categoryId === b.categoryId).reduce((s, e) => s + (e.value || 0), 0);
      const pct = Math.round((gasto / b.limit) * 100);
      const item = { nome: nomeCat(b.categoryId), gasto, limit: b.limit, pct };
      if (gasto > b.limit) estourado.push(item);
      else if (pct >= LIMITE_APERTADO) apertado.push(item);
      else dentro.push(item);
    }
    const linhaOk = (it) => `• ${it.nome}: ${moeda(it.gasto)} de ${moeda(it.limit)} — ${it.pct}% já utilizado.\n  Pode utilizar ${moeda(it.limit - it.gasto)}.`;
    const linhaEstourou = (it) => `• ${it.nome}: ${moeda(it.gasto)} de ${moeda(it.limit)} — ${it.pct}% já utilizado.\n  Você estourou ${moeda(it.gasto - it.limit)} a mais do cadastrado.`;
    const bloco = (titulo, itens, fmt) => `\n\n_${titulo}:_` + (itens.length ? '\n' + itens.map(fmt).join('\n') : `\n_Sem orçamento nessa situação._`);
    msgOrcamentos += bloco('Dentro da margem', dentro, linhaOk);
    msgOrcamentos += bloco('Apertado (perto do limite)', apertado, linhaOk);
    msgOrcamentos += bloco('Estourado', estourado, linhaEstourou);
  }
  msgOrcamentos += `\n\n_Controle Financeiro PRO_`;

  if (contatos.length === 0) { console.log('Nenhum contato com número cadastrado. Nada enviado.'); return; }

  // Página 1 = despesas, Página 2 = orçamentos (cada página só é subdividida em casos extremos)
  let partes = [];
  const paginas = msgQuitado ? [msgQuitado, msgDespesas, msgOrcamentos] : [msgDespesas, msgOrcamentos];
  for (const pagina of paginas) partes = partes.concat(dividirMensagem(pagina));

  for (const c of contatos) {
    for (let i = 0; i < partes.length; i++) {
      const texto = partes.length > 1 ? `(${i + 1}/${partes.length})\n${partes[i]}` : partes[i];
      try {
        const r = await enviarGreenAPI(c.number, texto);
        console.log(`Enviado para ${c.name} (${c.number}) parte ${i + 1}/${partes.length}: status ${r.status} | ${r.body}`);
      } catch (err) {
        console.error(`Falha ao enviar para ${c.name} (parte ${i + 1}):`, err.message);
      }
      await sleep(2000); // pequeno intervalo entre envios
    }
  }
  console.log('Concluído.');
}

if (require.main === module) {
  main().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
}

module.exports = { resumoDoMes, avaliarMesesQuitados, montarMensagemQuitado };
