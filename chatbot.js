// ================= IMPORTS =================
require('./config/timezone');
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const axios = require('axios');
const dayjs = require('dayjs');
const path = require('path');
const fs = require("fs");
const qrcode = require('qrcode-terminal');
const db = require('./config/database');

// ================= CONFIG =================
const CONFIG = {
  MEU_NUMERO_SIMULACAO: "5563984425197",
  GATILHO_TESTE: "JOHNTESTE",
  URL_WEBHOOK_HISTORICO: "https://script.google.com/macros/s/AKfycbzFWguJIjPAUw7SlXXgdmtSZQCasBuOdNzFwdEaCzK0SplFyhYSZQxujD_LZMaBEh38hw/exec"
};

// ================= LOGGER =================
function registrarErro(erro, contexto = "") {
  const dataHora = dayjs().format('DD/MM/YYYY HH:mm:ss');
  const detalhe = erro.response
    ? `Status: ${erro.response.status} - ${JSON.stringify(erro.response.data)}`
    : (erro.stack || erro);

  const logMsg = `\n[${dataHora}] ❌ ERRO: ${contexto}\n${detalhe}\n${'-'.repeat(50)}`;

  console.error(logMsg);
  try {
    fs.appendFileSync(path.join(__dirname, 'erros_bot.txt'), logMsg);
  } catch {}
}

// ================= UTILS =================
const delay = ms => new Promise(res => setTimeout(res, ms));

function validarIP(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

function limparNumero(numero) {
  let num = numero.replace(/\D/g, '');
  if (!num.startsWith('55')) num = '55' + num;
  return num;
}

function formatarNumeroBR(numero) {
  numero = numero.replace(/\D/g, '');
  if (numero.length === 13) {
    return `(${numero.slice(2,4)}) ${numero[4]} ${numero.slice(5,9)}-${numero.slice(9)}`;
  }
  return numero;
}

function gerarProtocolo() {
  return `HGP-${dayjs().format('DDMM')}-${Math.random().toString(36).substring(2,5).toUpperCase()}`;
}

// ================= CLIENT =================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "bot-hgp-v6",
    dataPath: path.join(__dirname, 'wwebjs_sessions')
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  }
});

// ================= ESTADO =================
const estados = new Map();

const categoriasMap = {
  "1": "Soul MV",
  "2": "Impressora",
  "3": "Suporte Técnico",
  "4": "Telefonia / VOIP",
  "5": "Outras Solicitações"
};

// ================= SERVICES =================
async function enviarMensagemDireta(numeroBruto, mensagem) {
  const num = limparNumero(numeroBruto);

  async function tentar(id) {
    try {
      const res = await client.getNumberId(id);
      if (res) {
        await client.sendMessage(res._serialized, mensagem);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  let enviado = await tentar(num);

  if (!enviado) {
    if (num.length === 13) enviado = await tentar(num.slice(0, 4) + num.slice(5));
    else if (num.length === 12) enviado = await tentar(num.slice(0, 4) + '9' + num.slice(4));
  }

  return enviado;
}

async function buscarTecnicoEscala() {
  try {
    const hojeISO = dayjs().format('YYYY-MM-DD');

    const [rows] = await db.query(
      `SELECT
          COALESCE(NULLIF(a.nome_completo, ''), a.username) AS nome,
          a.telefone AS telefone
       FROM escalas e
       INNER JOIN admins a ON a.id = e.admin_id
       WHERE e.data_escala = ?
         AND a.ativo = TRUE
       LIMIT 1`,
      [hojeISO]
    );

    if (rows.length > 0) {
      return { nome: rows[0].nome, telefone: rows[0].telefone };
    }

    return null;
  } catch (e) {
    registrarErro(e, "Erro Escala");
    return null;
  }
}

// ================= FLUXO =================
const steps = {
  0.5: async (msg, est, chatId) => {
    const texto = msg.body.trim();

    if (texto === "6") {
      const pdf = path.join(__dirname, 'RAMAIS TELEFÔNICOS - HGP.pdf');
      if (fs.existsSync(pdf)) {
        await client.sendMessage(chatId, MessageMedia.fromFilePath(pdf));
      }
      estados.delete(chatId);
      return;
    }

    if (!categoriasMap[texto]) return;

    est.opcao = texto;
    est.step = 1;
    await client.sendMessage(chatId, "👤 Seu *Nome Completo*:");
  },

  1: async (msg, est, chatId) => {
    est.nome = msg.body;
    est.step = 2;
    await client.sendMessage(chatId, "🏢 Seu *Setor e Ala*:");
  },

  2: async (msg, est, chatId) => {
    est.setor = msg.body;
    est.step = 3;
    await client.sendMessage(chatId, "💻 *IP da Máquina*:");
  },

  3: async (msg, est, chatId) => {
    if (!validarIP(msg.body)) {
      return client.sendMessage(chatId, "❌ IP inválido. Tente novamente:");
    }

    est.ip = msg.body;

    if (est.opcao === "2") {
      est.step = 3.5;
      return client.sendMessage(chatId, "🖨️ Qual é o *código da impressora*? (Ex: TC1020)");
    }

    est.step = 4;
    await client.sendMessage(chatId, "📱 *Telefone* de contato:");
  },

  3.5: async (msg, est, chatId) => {
    est.codImpressora = msg.body;
    est.step = 4;
    await client.sendMessage(chatId, "📱 *Telefone* de contato:");
  },

  4: async (msg, est, chatId) => {
    est.tel = msg.body;
    est.step = 5;
    await client.sendMessage(chatId, "📝 Descreva o *Problema*:");
  },

  5: async (msg, est, chatId) => {
    est.desc = msg.body;

    const protocolo = gerarProtocolo();
    const contato = await msg.getContact();

    const numeroWhats = formatarNumeroBR(contato.number || '');
    const nomeWhats = contato.pushname || contato.name || "Não informado";

    const relatorio = `🛠️ *CHAMADO TI HGP*
📌 *Protocolo:* ${protocolo}
📂 *Categoria:* ${categoriasMap[est.opcao]}
👤 *Solicitante:* ${est.nome}
👤 *Nome do WhatsApp:* ${nomeWhats}
🏢 *Setor:* ${est.setor}
💻 *IP:* ${est.ip}
${est.codImpressora ? `🖨️ *Cod. Impressora:* ${est.codImpressora}\n` : ""}📱 *Contato Informado:* ${est.tel}
📲 *WhatsApp:* ${numeroWhats}
📝 *Problema:* ${est.desc}`;

    await client.sendMessage(chatId, relatorio);
    await client.sendMessage(chatId, "✅ Registrado e enviado ao técnico.");

    if (est.isTeste) {
      await enviarMensagemDireta(CONFIG.MEU_NUMERO_SIMULACAO, relatorio);
    } else {
      const tecnico = await buscarTecnicoEscala();
      if (tecnico?.telefone) {
        await enviarMensagemDireta(tecnico.telefone, relatorio);
      }
    }

    axios.post(CONFIG.URL_WEBHOOK_HISTORICO, JSON.stringify({ ...est, protocolo }), {
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    }).catch(e => registrarErro(e, "Webhook"));

    estados.delete(chatId);
  }
};

// ================= EVENT =================
client.on("message", async (msg) => {
  try {
    const chatId = msg.from;

    if (msg.fromMe || chatId.endsWith("@g.us")) return;

    const texto = msg.body?.trim().toUpperCase() || "";
    let est = estados.get(chatId);

    if (texto === "CANCELAR") {
      estados.delete(chatId);
      return client.sendMessage(chatId, "❌ Atendimento encerrado.");
    }

    if (!est || texto === CONFIG.GATILHO_TESTE) {
      const contato = await msg.getContact();

      estados.set(chatId, {
        step: 0.5,
        nomeWhats: contato.pushname || contato.name || 'Prezado',
        isTeste: texto === CONFIG.GATILHO_TESTE
      });

      await client.sendMessage(chatId, `*🛠️ TI - HGP*\nOlá, *${contato.pushname || 'Prezado'}*.`);
      await delay(500);
      await client.sendMessage(chatId, `1️⃣ Soul MV\n2️⃣ Impressora\n3️⃣ Suporte Técnico\n4️⃣ Telefonia / VOIP\n5️⃣ Outras\n6️⃣ Ramais\n\n_Ou envie CANCELAR._`);

      return;
    }

    if (steps[est.step]) {
      await steps[est.step](msg, est, chatId);
    }

  } catch (e) {
    registrarErro(e, "Fluxo principal");
  }
});

// ================= BLOQUEIO DE CHAMADAS =================
client.on('call', async (call) => {
  try {
    console.log(`📞 Chamada recebida de ${call.from}`);
    await call.reject();
    await client.sendMessage(call.from, "🚫 Este número não recebe chamadas. Por favor, envie uma mensagem.");
  } catch (e) {
    registrarErro(e, "Bloqueio de chamada");
  }
});

// ================= MONITORAMENTO =================
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('🚀 BOT ONLINE'));

client.on('disconnected', async () => {
  try { await client.destroy(); } catch {}
  setTimeout(() => client.initialize(), 15000);
});

client.initialize().catch(e => registrarErro(e, "Init"));Q