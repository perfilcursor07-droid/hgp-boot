const axios = require('axios');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { MessageMedia } = require('whatsapp-web.js');
const db = require('./config/database');

const GATILHO_TESTE = 'JOHNTESTE';
const MEU_NUMERO_SIMULACAO = '5563984425197';
const URL_WEBHOOK_HISTORICO = 'https://script.google.com/macros/s/AKfycbyG30F-V52xN773jLyqDYdER0HzBoiYrvSjPc4lijgl2bOD-LnCR0xGtJi6JzhTFRi/exec';
const CHATBOT_ATTACHED_FLAG = Symbol.for('hgp.chatbot.attached');
const CHAT_MEDIA_DIR = path.join(__dirname, 'public', 'uploads', 'chat-media');

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

    const menuPrincipal = '1️⃣ Soul MV\n2️⃣ Impressora\n3️⃣ Suporte Técnico\n4️⃣ Telefonia / VOIP\n5️⃣ Outras\n6️⃣ Ramais\n\n_Ou envie CANCELAR._';

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

    async function resolverDestinoSaida(sessionOrChatId) {
        const destino = String(sessionOrChatId || '').trim();

        if (!destino) {
            return null;
        }

        if (destino.endsWith('@c.us') || destino.endsWith('@g.us')) {
            return destino;
        }

        const resolvido = await resolverIdChatPorNumero(destino);
        return resolvido?.chatId || null;
    }

    function liberarSessao(sessionId) {
        if (!sessionId) {
            return;
        }

        estados.delete(sessionId);
        bloqueados.delete(sessionId);
    }

    async function reiniciarFluxoPorEncerramento(sessionId, options = {}) {
        const chatId = await resolverDestinoSaida(sessionId);
        if (!chatId) {
            return false;
        }

        liberarSessao(sessionId);

        const nomeExibicao = options.nomeExibicao || 'Prezado';
        const protocolo = options.protocolo ? `\n\n📌 *Protocolo encerrado:* ${options.protocolo}` : '';
        const atendenteNome = options.atendenteNome ? `\n👤 *Atendido por:* ${options.atendenteNome}` : '';

        await client.sendMessage(
            chatId,
            `✅ *CHAMADO ENCERRADO COM SUCESSO*${protocolo}${atendenteNome}\n\nSeu chamado foi encerrado com sucesso. Obrigado por entrar em contato com a equipe de TI.\n\nSe precisar abrir um novo chamado, o menu já está disponível abaixo.`
        );
        await delay(500);
        await client.sendMessage(chatId, `*🛠️ TI - HGP*\nOlá, *${nomeExibicao}*.`);
        await delay(400);
        await client.sendMessage(chatId, menuPrincipal);

        estados.set(sessionId, {
            step: 0.5,
            nomeWhats: nomeExibicao,
            isTeste: false
        });

        return true;
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
                return {
                    nome: rows[0].nome,
                    telefone: rows[0].telefone
                };
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
                    telefone_whatsapp,
                    setor,
                    ip_maquina,
                    telefone_contato,
                    descricao,
                    status,
                    tecnico_nome,
                    tecnico_telefone,
                    chat_origem,
                    atribuido_em
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    dadosChamado.protocolo,
                    dadosChamado.categoria,
                    dadosChamado.solicitanteNome,
                    dadosChamado.nomeWhats,
                    dadosChamado.telefoneWhats,
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

    async function buscarChamadoAtivo(sessionId) {
        const [chamadosAtivos] = await db.query(
            `SELECT id, protocolo, atendente_nome, status FROM chamados
             WHERE chat_origem = ? AND status IN ('pendente', 'aberto', 'em_atendimento')
             ORDER BY criado_em DESC LIMIT 1`,
            [sessionId]
        );

        return chamadosAtivos[0] || null;
    }

    function resumirMensagemSolicitante(msg) {
        const textoOriginal = typeof msg.body === 'string' ? msg.body.trim() : '';
        if (textoOriginal) {
            return textoOriginal;
        }

        const tiposMidia = {
            image: '📷 Imagem enviada',
            video: '🎥 Vídeo enviado',
            audio: '🎧 Áudio enviado',
            ptt: '🎤 Áudio enviado',
            document: '📄 Documento enviado',
            sticker: '🏷️ Figurinha enviada'
        };

        return tiposMidia[msg.type] || `📎 Arquivo enviado (${msg.type || 'mídia'})`;
    }

    function mensagemEscolhaOpcao() {
        return '⚠️ Antes de enviar áudio, imagem, vídeo ou outra mensagem, por favor escolha uma das opções do menu digitando o número correspondente.';
    }

    function detectarExtensaoMidia(media, msg) {
        const extOriginal = path.extname(media?.filename || '');
        if (extOriginal) {
            return extOriginal;
        }

        const mime = String(media?.mimetype || '').toLowerCase();
        const extPorMime = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp',
            'audio/ogg': '.ogg',
            'audio/mpeg': '.mp3',
            'audio/mp4': '.m4a',
            'video/mp4': '.mp4',
            'application/pdf': '.pdf'
        };

        return extPorMime[mime] || (msg.type ? `.${msg.type}` : '.bin');
    }

    async function salvarMidiaMensagem(msg, chamadoId) {
        if (!msg.hasMedia) {
            return null;
        }

        const media = await msg.downloadMedia();
        if (!media?.data) {
            return null;
        }

        await fsPromises.mkdir(CHAT_MEDIA_DIR, { recursive: true });

        const extensao = detectarExtensaoMidia(media, msg);
        const nomeArquivo = `chamado-${chamadoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extensao}`;
        const caminhoArquivo = path.join(CHAT_MEDIA_DIR, nomeArquivo);

        await fsPromises.writeFile(caminhoArquivo, media.data, 'base64');

        return {
            messageType: String(msg.type || 'media'),
            mediaUrl: `/uploads/chat-media/${nomeArquivo}`,
            mediaMimeType: media.mimetype || null,
            mediaFilename: media.filename || nomeArquivo
        };
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
            let chamadoAtivo = null;

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

            // Verificar se existe chamado em atendimento para este chat e salvar mensagem
            // Não salvar se o usuário está no meio do fluxo de criação de chamado
            try {
                if (!est || est.step === undefined) {
                    chamadoAtivo = await buscarChamadoAtivo(sessionId);

                    if (chamadoAtivo && !texto.startsWith(GATILHO_TESTE) && texto !== 'CANCELAR') {
                        const contactName = contato.pushname || contato.name || 'Solicitante';
                        const resumoMensagem = resumirMensagemSolicitante(msg);
                        const midiaSalva = await salvarMidiaMensagem(msg, chamadoAtivo.id).catch((erro) => {
                            registrarErro(erro, 'Erro ao salvar mídia do solicitante');
                            return null;
                        });
                        
                        // Salvar mensagem do solicitante no chat
                        await db.query(
                            `INSERT INTO chat_messages (
                                chamado_id,
                                remetente_tipo,
                                remetente_nome,
                                mensagem,
                                message_type,
                                media_url,
                                media_mime_type,
                                media_filename
                             ) VALUES (?, 'solicitante', ?, ?, ?, ?, ?, ?)`,
                            [
                                chamadoAtivo.id,
                                contactName,
                                resumoMensagem,
                                midiaSalva?.messageType || 'text',
                                midiaSalva?.mediaUrl || null,
                                midiaSalva?.mediaMimeType || null,
                                midiaSalva?.mediaFilename || null
                            ]
                        );

                        console.log(`💬 Mensagem do solicitante salva no chamado ${chamadoAtivo.protocolo}`);
                    }
                }
            } catch (erro) {
                registrarErro(erro, 'Erro ao salvar mensagem do solicitante no chat');
            }

            if (texto === 'CANCELAR') {
                estados.delete(sessionId);
                await client.sendMessage(chatId, '❌ Atendimento encerrado.');
                return;
            }

            // Verificar se existe chamado não finalizado - bloquear novo chamado
            if (texto === GATILHO_TESTE || !est) {
                try {
                    if (!chamadoAtivo) {
                        chamadoAtivo = await buscarChamadoAtivo(sessionId);
                    }

                    if (chamadoAtivo && texto !== GATILHO_TESTE) {
                        return;
                    }
                } catch (erro) {
                    registrarErro(erro, 'Erro ao verificar chamados ativos');
                }

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
                await client.sendMessage(chatId, menuPrincipal);
                if (msg.hasMedia && texto !== GATILHO_TESTE) {
                    await delay(400);
                    await client.sendMessage(chatId, mensagemEscolhaOpcao());
                }
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

                if (!categoriasMap[texto]) {
                    await client.sendMessage(chatId, mensagemEscolhaOpcao());
                    return;
                }
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
                
                // Obter dados do WhatsApp
                const nomeWhatsApp = contato.pushname || contato.name || 'Não informado';
                const telefoneWhatsApp = contato.number || msg.from.split('@')[0] || 'Não informado';
                
                const relatorio = `🛠️ *CHAMADO TI HGP*\n` +
                    `📌 *Protocolo:* ${protocolo}\n` +
                    `📂 *Categoria:* ${categoriasMap[est.opcao]}\n\n` +
                    `👤 *Solicitante Informado:* ${est.nome}\n` +
                    `📱 *Telefone Informado:* ${est.tel}\n\n` +
                    `📲 *Nome no WhatsApp:* ${nomeWhatsApp}\n` +
                    `📞 *Telefone WhatsApp:* ${telefoneWhatsApp}\n\n` +
                    `🏢 *Setor:* ${est.setor}\n` +
                    `💻 *IP:* ${est.ip}\n` +
                    `📝 *Problema:* ${est.desc}`;

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
                    // Verificar horário de atendimento antes de enviar
                    const agoraHorario = dayjs();
                    const diaSemana = agoraHorario.day();
                    const hora = agoraHorario.hour();
                    let dentroDoHorario = true;

                    // Verificar se está fora do horário de sobreaviso
                    if (diaSemana === 0 || diaSemana === 6) {
                        // Final de semana: sobreaviso até 18:00
                        if (hora >= 18) {
                            dentroDoHorario = false;
                        }
                    }
                    // Dias úteis: horário normal (não precisa verificar, sempre envia)

                    if (dentroDoHorario) {
                        tecnicoResponsavel = await buscarTecnicoEscala();
                        if (tecnicoResponsavel && tecnicoResponsavel.telefone) {
                            const enviadoAoTecnico = await enviarMensagemDireta(tecnicoResponsavel.telefone, `🚨 *NOVO CHAMADO REAL*\n\n${relatorio}`);
                            if (enviadoAoTecnico) {
                                statusChamado = 'aberto';
                                atribuidoEm = dayjs().format('YYYY-MM-DD HH:mm:ss');
                            }
                        }
                    } else {
                        // Fora do horário de sobreaviso - não envia para técnico
                        console.log(`⏰ Chamado ${protocolo} criado fora do horário de sobreaviso - status: pendente`);
                    }
                }

                await salvarChamado({
                    protocolo,
                    categoria: categoriasMap[est.opcao],
                    solicitanteNome: est.nome,
                    nomeWhats: nomeWhatsApp,
                    telefoneWhats: telefoneWhatsApp,
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
        mode: options.managedByServer ? 'shared-session' : 'standalone',
        liberarSessao,
        reiniciarFluxoPorEncerramento
    };

    client[CHATBOT_ATTACHED_FLAG] = controller;
    return controller;
}

module.exports = {
    attachChatbot,
    registrarErro
};