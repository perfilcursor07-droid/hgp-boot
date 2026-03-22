const axios = require('axios');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const db = require('./config/database');

const GATILHO_TESTE = 'JOHNTESTE';
const MEU_NUMERO_SIMULACAO = '5563984425197';
const URL_WEBHOOK_HISTORICO = 'https://script.google.com/macros/s/AKfycbyG30F-V52xN773jLyqDYdER0HzBoiYrvSjPc4lijgl2bOD-LnCR0xGtJi6JzhTFRi/exec';
const URL_PLANILHA_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTXqSf5qMNA7Zd7jolV5IeplWYz-beU5-ypZHgmvUSlPxGIisq51hGbhHtlpnMf96OgG-TE4WIrLvKp/pub?gid=0&single=true&output=csv';
const ESCALA_LOCAL_FILE = path.join(__dirname, 'escala.json');
const CHATBOT_ATTACHED_FLAG = Symbol.for('hgp.chatbot.attached');

function registrarErro(erro, contexto = '') {
    const dataHora = dayjs().format('DD/MM/YYYY HH:mm:ss');
    const detalhe = erro.response
        ? `Status: ${erro.response.status} - ${JSON.stringify(erro.response.data)}`
        : (erro.stack || erro);
    const logMsg = `\n[${dataHora}] ❌ ERRO: ${contexto}\n${detalhe}\n${'-'.repeat(50)}`;
    console.error(logMsg);

    try {
        fs.appendFileSync(path.join(__dirname, 'erros_bot.txt'), logMsg);
    } catch (logError) {
        console.error('Erro ao gravar log.', logError.message);
    }
}

function normalizarNumeroBrasil(numeroBruto) {
    let numero = String(numeroBruto || '').replace(/\D/g, '');
    if (!numero) return '';
    if (!numero.startsWith('55')) numero = `55${numero}`;
    return numero;
}

function gerarVariacoesNumero(numeroBruto) {
    const numero = normalizarNumeroBrasil(numeroBruto);
    if (!numero) return [];

    const variacoes = [numero];
    if (numero.length === 13) variacoes.push(numero.slice(0, 4) + numero.slice(5));
    if (numero.length === 12) variacoes.push(numero.slice(0, 4) + '9' + numero.slice(4));

    return [...new Set(variacoes)];
}

function obterIdMensagem(msg) {
    return msg?.id?._serialized || `${msg.from}-${msg.timestamp}-${msg.type || 'msg'}-${msg.body || ''}`;
}

function attachChatbot(client, options = {}) {
    if (client[CHATBOT_ATTACHED_FLAG]) {
        return client[CHATBOT_ATTACHED_FLAG];
    }

    const estados = new Map();
    const bloqueados = new Map();
    const mensagensProcessadas = new Map();
    const categoriasMap = {
        '1': 'Soul MV',
        '2': 'Impressora',
        '3': 'Suporte Técnico',
        '4': 'Telefonia / VOIP',
        '5': 'Outras Solicitações'
    };
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function resolverIdChatPorNumero(numeroBruto) {
        const variacoes = gerarVariacoesNumero(numeroBruto);

        for (const numero of variacoes) {
            try {
                const res = await client.getNumberId(numero);
                if (res?._serialized) {
                    return { chatId: res._serialized, numero };
                }
            } catch (erro) {
                // Continua tentando as próximas variações.
            }
        }

        return null;
    }

    async function resolverDestinoMensagem(msg) {
        const contato = await msg.getContact();
        const origem = msg.from;

        if (!origem.endsWith('@lid')) {
            return {
                contato,
                chatId: origem,
                sessionId: origem
            };
        }

        const numeroContato = contato.number || contato.id?.user || '';
        const resolvido = await resolverIdChatPorNumero(numeroContato);

        return {
            contato,
            chatId: resolvido?.chatId || origem,
            sessionId: resolvido?.chatId || normalizarNumeroBrasil(numeroContato) || origem
        };
    }

    async function enviarMensagemDireta(numeroBruto, mensagem) {
        const resolvido = await resolverIdChatPorNumero(numeroBruto);
        if (!resolvido) {
            registrarErro(new Error(`Nao foi possivel validar/enviar para o numero: ${numeroBruto}`), 'Falha no envio direto');
            return false;
        }

        await client.sendMessage(resolvido.chatId, mensagem);
        return true;
    }

    async function buscarTecnicoEscala() {
        try {
            const hojeISO = dayjs().format('YYYY-MM-DD');

            if (fs.existsSync(ESCALA_LOCAL_FILE)) {
                const escala = JSON.parse(fs.readFileSync(ESCALA_LOCAL_FILE, 'utf8'));
                const tecnicoHoje = escala.find((item) => item.data === hojeISO);
                if (tecnicoHoje) {
                    return { nome: tecnicoHoje.tecnico, telefone: tecnicoHoje.telefone };
                }
            }

            const res = await axios.get(URL_PLANILHA_CSV, { timeout: 15000 });
            const linhas = res.data.split(/\r?\n/).slice(1);
            const hojeBR = dayjs().format('DD/MM/YYYY');

            for (const linha of linhas) {
                const col = linha.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((value) => value.replace(/"/g, '').trim());
                if (col[0] === hojeISO || col[0] === hojeBR) {
                    return { nome: col[1], telefone: col[2] };
                }
            }

            return null;
        } catch (erro) {
            registrarErro(erro, 'Erro ao buscar técnico na escala');
            return null;
        }
    }

    async function salvarChamado(dadosChamado) {
        try {
            await db.query(
                `INSERT INTO chamados (
                    protocolo,
                    categoria,
                    solicitante_nome,
                    nome_whatsapp,
                    setor,
                    ip_maquina,
                    telefone_contato,
                    descricao,
                    status,
                    tecnico_nome,
                    tecnico_telefone,
                    chat_origem,
                    atribuido_em
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    dadosChamado.protocolo,
                    dadosChamado.categoria,
                    dadosChamado.solicitanteNome,
                    dadosChamado.nomeWhats,
                    dadosChamado.setor,
                    dadosChamado.ipMaquina,
                    dadosChamado.telefoneContato,
                    dadosChamado.descricao,
                    dadosChamado.status,
                    dadosChamado.tecnicoNome,
                    dadosChamado.tecnicoTelefone,
                    dadosChamado.chatOrigem,
                    dadosChamado.atribuidoEm
                ]
            );
        } catch (erro) {
            registrarErro(erro, `Falha ao salvar chamado ${dadosChamado.protocolo}`);
        }
    }

    function mensagemJaProcessada(msg) {
        const idMensagem = obterIdMensagem(msg);
        const agora = Date.now();

        for (const [id, expiraEm] of mensagensProcessadas.entries()) {
            if (expiraEm <= agora) {
                mensagensProcessadas.delete(id);
            }
        }

        if (mensagensProcessadas.has(idMensagem)) {
            return true;
        }

        mensagensProcessadas.set(idMensagem, agora + (10 * 60 * 1000));
        return false;
    }

    client.on('message', async (msg) => {
        try {
            if (msg.fromMe || msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;
            if (String(msg.type || '').includes('notification')) return;
            if (mensagemJaProcessada(msg)) return;

            const { contato, chatId, sessionId } = await resolverDestinoMensagem(msg);
            const texto = msg.body ? msg.body.trim().toUpperCase() : '';
            let est = estados.get(sessionId);

            const agora = dayjs();
            const diaSemana = agora.day();
            const hora = agora.hour();
            const tempoEmMinutos = (hora * 60) + agora.minute();

            let mensagemAviso = '';
            if (diaSemana === 0 || diaSemana === 6) {
                mensagemAviso = '🚨 ATENÇÃO: Atendimento em regime de SOBREAVISO para urgências.';
                if (hora >= 18) {
                    mensagemAviso = '⏳ INFORMATIVO: Nosso sobreaviso de final de semana encerrou às 18:00.';
                }
            } else if (tempoEmMinutos >= 720 && tempoEmMinutos < 840) {
                mensagemAviso = '🍽️ PAUSA PARA ALMOÇO: Estamos em intervalo (12:00 às 14:00).';
            }

            console.log(`📩 Mensagem recebida de ${msg.from} -> resposta via ${chatId}: ${msg.body || '(sem texto)'}`);
            if (typeof options.onMessage === 'function') {
                options.onMessage({ from: msg.from, to: chatId, body: msg.body || '', sessionId });
            }

<<<<<<< HEAD
            // Registrar/atualizar contato automaticamente
            try {
                const contactName = contato.pushname || contato.name || null;
                await db.query(`
                    INSERT INTO contacts (phone_number, contact_name, first_message_at, last_message_at, message_count)
                    VALUES (?, ?, NOW(), NOW(), 1)
                    ON DUPLICATE KEY UPDATE
                        contact_name = COALESCE(VALUES(contact_name), contact_name),
                        last_message_at = NOW(),
                        message_count = message_count + 1
                `, [msg.from, contactName]);
            } catch (erro) {
                registrarErro(erro, 'Erro ao registrar contato automaticamente');
            }

=======
>>>>>>> b9304d0859cde428d1d32bc90c169ccd183e542c
            if (texto === 'CANCELAR') {
                estados.delete(sessionId);
                await client.sendMessage(chatId, '❌ Atendimento encerrado.');
                return;
            }

            if (texto === GATILHO_TESTE || !est) {
                if (texto !== GATILHO_TESTE && bloqueados.has(sessionId) && Date.now() < bloqueados.get(sessionId)) return;

                if (mensagemAviso && texto !== GATILHO_TESTE) {
                    await client.sendMessage(chatId, mensagemAviso);
                    await delay(800);
                }

                const saudacao = texto === GATILHO_TESTE
                    ? '🧪 *MODO SIMULAÇÃO*'
                    : `*🛠️ TI - HGP*\nOlá, *${contato.pushname || 'Prezado'}*.`;

                await client.sendMessage(chatId, saudacao);
                await delay(500);
                await client.sendMessage(chatId, '1️⃣ Soul MV\n2️⃣ Impressora\n3️⃣ Suporte Técnico\n4️⃣ Telefonia / VOIP\n5️⃣ Outras\n6️⃣ Ramais\n\n_Ou envie CANCELAR._');
                estados.set(sessionId, { step: 0.5, nomeWhats: contato.pushname || 'Prezado', isTeste: texto === GATILHO_TESTE });
                return;
            }

            if (est.step === 0.5) {
                if (texto === '6') {
                    const pdf = path.join(__dirname, 'RAMAIS TELEFÔNICOS - HGP.pdf');
                    if (fs.existsSync(pdf)) {
                        await client.sendMessage(chatId, MessageMedia.fromFilePath(pdf));
                    }
                    estados.delete(sessionId);
                    return;
                }

                if (!categoriasMap[texto]) return;
                est.opcao = texto;
                est.step = 1;
                await client.sendMessage(chatId, '👤 Seu *Nome Completo*:');
                return;
            }

            if (est.step === 1) {
                est.nome = msg.body;
                est.step = 2;
                await client.sendMessage(chatId, '🏢 Seu *Setor e Ala*:');
                return;
            }

            if (est.step === 2) {
                est.setor = msg.body;
                est.step = 3;
                await client.sendMessage(chatId, '💻 *IP da Máquina*:');
                return;
            }

            if (est.step === 3) {
                est.ip = msg.body;
                est.step = 4;
                await client.sendMessage(chatId, '📱 *Telefone* de contato:');
                return;
            }

            if (est.step === 4) {
                est.tel = msg.body;
                est.step = 5;
                await client.sendMessage(chatId, '📝 Descreva o *Problema*:');
                return;
            }

            if (est.step === 5) {
                est.desc = msg.body;
                const protocolo = `HGP-${dayjs().format('DDMM')}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
                const relatorio = `🛠️ *CHAMADO TI HGP*\n📌 *Protocolo:* ${protocolo}\n📂 *Categoria:* ${categoriasMap[est.opcao]}\n👤 *Solicitante:* ${est.nome}\n🏢 *Setor:* ${est.setor}\n💻 *IP:* ${est.ip}\n📱 *Contato:* ${est.tel}\n📝 *Problema:* ${est.desc}`;

                let tecnicoResponsavel = null;
                let statusChamado = 'pendente';
                let atribuidoEm = null;

                await client.sendMessage(chatId, relatorio);
                await client.sendMessage(chatId, '✅ Registrado e enviado ao técnico.');

                if (est.isTeste) {
                    await enviarMensagemDireta(MEU_NUMERO_SIMULACAO, `🧪 *TESTE DE ENVIO*:\n\n${relatorio}`);
                    tecnicoResponsavel = { nome: 'Simulação', telefone: MEU_NUMERO_SIMULACAO };
                    statusChamado = 'aberto';
                    atribuidoEm = dayjs().format('YYYY-MM-DD HH:mm:ss');
                } else {
                    tecnicoResponsavel = await buscarTecnicoEscala();
                    if (tecnicoResponsavel && tecnicoResponsavel.telefone) {
                        const enviadoAoTecnico = await enviarMensagemDireta(tecnicoResponsavel.telefone, `🚨 *NOVO CHAMADO REAL*\n\n${relatorio}`);
                        if (enviadoAoTecnico) {
                            statusChamado = 'aberto';
                            atribuidoEm = dayjs().format('YYYY-MM-DD HH:mm:ss');
                        }
                    }
                }

                await salvarChamado({
                    protocolo,
                    categoria: categoriasMap[est.opcao],
                    solicitanteNome: est.nome,
                    nomeWhats: est.nomeWhats || contato.pushname || 'Prezado',
                    setor: est.setor,
                    ipMaquina: est.ip,
                    telefoneContato: est.tel,
                    descricao: est.desc,
                    status: statusChamado,
                    tecnicoNome: tecnicoResponsavel?.nome || null,
                    tecnicoTelefone: tecnicoResponsavel?.telefone || null,
                    chatOrigem: sessionId,
                    atribuidoEm
                });

                axios({
                    method: 'post',
                    url: URL_WEBHOOK_HISTORICO,
                    data: JSON.stringify({ ...est, protocolo, categoria: categoriasMap[est.opcao] }),
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    timeout: 30000,
                    maxRedirects: 10
                }).catch((erro) => registrarErro(erro, `Falha Webhook protocolo ${protocolo}`));

                if (!est.isTeste) {
                    bloqueados.set(sessionId, Date.now() + (15 * 60 * 1000));
                }
                estados.delete(sessionId);
            }
        } catch (erro) {
            registrarErro(erro, `Erro no fluxo do usuário ${msg.from}`);
        }
    });

    const controller = {
        categories: categoriasMap,
        mode: options.managedByServer ? 'shared-session' : 'standalone'
    };

    client[CHATBOT_ATTACHED_FLAG] = controller;
    return controller;
}

module.exports = {
    attachChatbot,
    registrarErro
};