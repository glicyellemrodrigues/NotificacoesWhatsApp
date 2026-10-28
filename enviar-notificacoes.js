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

async function main() {
  if (!process.env.SERVICE_ACCOUNT) throw new Error('Falta o secret SERVICE_ACCOUNT.');
  if (!process.env.APP_EMAIL) throw new Error('Falta o secret APP_EMAIL.');
  if (!process.env.GREENAPI_URL) throw new Error('Falta o secret GREENAPI_URL.');
  if (!process.env.GREENAPI_ID_INSTANCE) throw new Error('Falta o secret GREENAPI_ID_INSTANCE.');
  if (!process.env.GREENAPI_TOKEN_INSTANCE) throw new Error('Falta o secret GREENAPI_TOKEN_INSTANCE.');

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT)) });

  const user = await admin.auth().getUserByEmail(process.env.APP_EMAIL);
  const snap = await admin.firestore().collection('users').doc(user.uid).get();
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

  if (emBreve.length === 0 && hoje.length === 0 && vencidas.length === 0) {
    console.log('Nada a vencer (em breve/hoje) nem vencido. Nada será enviado.');
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
  for (const pagina of [msgDespesas, msgOrcamentos]) partes = partes.concat(dividirMensagem(pagina));

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

main().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
