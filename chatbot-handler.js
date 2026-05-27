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
    const lidSessionMap = new Map(); // mapeia @lid -> sessionId estável
    const inactivityTimers = new Map(); // timers de inatividade por sessionId
    const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutos
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

        // Para @lid, verificar se já temos um sessionId mapeado
        if (lidSessionMap.has(origem)) {
            const cachedSessionId = lidSessionMap.get(origem);
            return {
                contato,
                chatId: cachedSessionId,
                sessionId: cachedSessionId
            };
        }

        const numeroContato = contato.number || contato.id?.user || '';
        const resolvido = await resolverIdChatPorNumero(numeroContato);
        const chatId = resolvido?.chatId || origem;
        const sessionId = resolvido?.chatId || normalizarNumeroBrasil(numeroContato) || origem;

        // Cachear o mapeamento para manter consistência
        lidSessionMap.set(origem, sessionId);

        return {
            contato,
            chatId,
            sessionId
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
        clearInactivityTimer(sessionId);
    }

    function clearInactivityTimer(sessionId) {
        const timer = inactivityTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            inactivityTimers.delete(sessionId);
        }
    }

    function resetInactivityTimer(sessionId, chatId) {
        clearInactivityTimer(sessionId);

        const est = estados.get(sessionId);
        // Só ativar timer se o usuário está no meio do fluxo de criação (steps 0.5 a 5)
        if (!est || est.step === undefined) return;

        const timer = setTimeout(async () => {
            const estAtual = estados.get(sessionId);
            if (!estAtual) return; // já foi limpo

            try {
                await client.sendMessage(
                    chatId,
                    '⏰ Sua sessão foi encerrada por inatividade (30 minutos sem resposta). Se precisar, envie uma nova mensagem para iniciar o atendimento.'
                );
            } catch (erro) {
                console.error(`Erro ao enviar mensagem de inatividade para ${sessionId}:`, erro.message);
            }

            estados.delete(sessionId);
            inactivityTimers.delete(sessionId);
            console.log(`⏰ Sessão ${sessionId} encerrada por inatividade`);
        }, INACTIVITY_TIMEOUT);

        inactivityTimers.set(sessionId, timer);
    }

    async function reiniciarFluxoPorEncerramento(sessionId, options = {}) {
        const chatId = await resolverDestinoSaida(sessionId);
        if (!chatId) {
            console.error(`Não foi possível resolver destino para sessionId: ${sessionId}`);
            // Tentar encontrar via lidSessionMap reverso
            let lidFallback = null;
            for (const [lid, sid] of lidSessionMap.entries()) {
                if (sid === sessionId) {
                    lidFallback = lid;
                    break;
                }
            }
            if (!lidFallback) {
                return false;
            }
            // Usar o @lid diretamente como fallback
            return await _enviarFluxoEncerramento(lidFallback, sessionId, options);
        }

        return await _enviarFluxoEncerramento(chatId, sessionId, options);
    }

    async function _enviarFluxoEncerramento(chatId, sessionId, options) {
        liberarSessao(sessionId);

        const nomeExibicao = options.nomeExibicao || 'Prezado';
        const protocolo = options.protocolo || '';
        const protocoloTxt = protocolo ? ` (${protocolo})` : '';

        try {
            await client.sendMessage(
                chatId,
                `✅ Chamado${protocoloTxt} encerrado com sucesso. Obrigado pelo contato!`
            );
            await delay(500);
            await client.sendMessage(
                chatId,
                `⭐ *Avalie nosso atendimento*\n\nDe 1 a 5, como foi o atendimento?\n\n1️⃣ Péssimo\n2️⃣ Ruim\n3️⃣ Regular\n4️⃣ Bom\n5️⃣ Excelente\n\n_Digite o número da sua avaliação._`
            );

            // Setar estado de avaliação pendente
            estados.set(sessionId, {
                step: 'avaliacao',
                protocolo: protocolo,
                chamadoId: options.chamadoId || null,
                atendenteNome: options.atendenteNome || null,
                solicitanteNome: nomeExibicao
            });

            return true;
        } catch (erro) {
            registrarErro(erro, `Erro ao enviar fluxo de encerramento para ${chatId}`);
            return false;
        }
    }

    async function buscarTecnicoEscala() {
        try {
            const hojeISO = dayjs().format('YYYY-MM-DD');

            // Filtrar pela unidade HGP (já que esse handler é do HGP)
            const [legadaRows] = await db.query(
                `SELECT unidade_id FROM instancias WHERE is_legacy = TRUE LIMIT 1`
            );
            const unidadeHgpId = legadaRows[0]?.unidade_id;

            let query = `SELECT
                    COALESCE(NULLIF(a.nome_completo, ''), a.username) AS nome,
                    a.telefone AS telefone
                 FROM escalas e
                 INNER JOIN admins a ON a.id = e.admin_id
                 WHERE e.data_escala = ?
                   AND a.ativo = TRUE`;
            const params = [hojeISO];
            if (unidadeHgpId) {
                query += ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id = ?)`;
                params.push(unidadeHgpId);
            }
            query += ` LIMIT 1`;

            const [rows] = await db.query(query, params);

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
            console.log(`💾 Salvando chamado ${dadosChamado.protocolo} no banco...`);
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
                    (dadosChamado.ipMaquina || '').slice(0, 50) || null,
                    dadosChamado.telefoneContato,
                    dadosChamado.descricao,
                    dadosChamado.status,
                    dadosChamado.tecnicoNome,
                    dadosChamado.tecnicoTelefone,
                    dadosChamado.chatOrigem,
                    dadosChamado.atribuidoEm
                ]
            );
            console.log(`✅ Chamado ${dadosChamado.protocolo} salvo com sucesso no banco`);

            // Salvar/atualizar perfil do usuário pelo telefone para reuso futuro
            try {
                const tel = String(dadosChamado.chatOrigem || '').replace(/@.*$/, '').replace(/\D/g, '');
                if (tel) {
                    const perfil = {};
                    if (dadosChamado.solicitanteNome) perfil.nome_completo = dadosChamado.solicitanteNome;
                    if (dadosChamado.telefoneContato) perfil.telefone = dadosChamado.telefoneContato;
                    if (Object.keys(perfil).length > 0) {
                        // Mesclar com o existente
                        const [existente] = await db.query(
                            'SELECT dados_json FROM bot_user_profiles WHERE telefone = ? LIMIT 1',
                            [tel]
                        );
                        let merged = perfil;
                        if (existente.length > 0) {
                            try {
                                const raw = existente[0].dados_json;
                                const ant = typeof raw === 'string' ? JSON.parse(raw) : raw;
                                merged = { ...(ant || {}), ...perfil };
                            } catch (e) {}
                        }
                        await db.query(
                            `INSERT INTO bot_user_profiles (telefone, dados_json) VALUES (?, ?)
                             ON DUPLICATE KEY UPDATE dados_json = ?`,
                            [tel, JSON.stringify(merged), JSON.stringify(merged)]
                        );
                    }
                }
            } catch (erroPerfil) {
                console.error('Erro ao salvar perfil do usuário (não-crítico):', erroPerfil.message);
            }
        } catch (erro) {
            registrarErro(erro, `Falha ao salvar chamado ${dadosChamado.protocolo}`);
            console.error(`❌ FALHA AO SALVAR CHAMADO ${dadosChamado.protocolo}:`, erro.message);
        }

        // Notificação separada para não afetar o salvamento
        try {
            await notificarUsuariosNovoChamado(dadosChamado);
        } catch (erro) {
            registrarErro(erro, `Falha ao notificar sobre chamado ${dadosChamado.protocolo}`);
        }
    }

    async function notificarUsuariosNovoChamado(dadosChamado) {
        try {
            // Verificar se a funcionalidade está ativa
            const [configRows] = await db.query(
                "SELECT setting_value FROM system_settings WHERE setting_key = 'notificar_usuarios_novo_chamado'"
            );
            const ativo = configRows.length > 0 && configRows[0].setting_value === 'true';
            if (!ativo) return;

            // Descobrir a unidade da instância legada (HGP) para filtrar
            // Como esse handler é exclusivo do HGP, só notifica gestores vinculados à unidade HGP
            const [legadaRows] = await db.query(
                `SELECT unidade_id FROM instancias WHERE is_legacy = TRUE LIMIT 1`
            );
            const unidadeHgpId = legadaRows[0]?.unidade_id;

            const agora = dayjs();
            const diaSemana = agora.day();
            const horaAtual = agora.format('HH:mm:ss');

            // Construir filtro de unidade
            let filtroUnidade = '';
            const params = [diaSemana, horaAtual];
            if (unidadeHgpId) {
                filtroUnidade = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id = ?)`;
                params.push(unidadeHgpId);
            }

            // Buscar usuários que estão em turno agora E pertencem à unidade HGP
            const [usuarios] = await db.query(`
                SELECT DISTINCT a.id, a.nome_completo, a.telefone
                FROM admins a
                INNER JOIN user_turnos t ON t.admin_id = a.id
                WHERE a.ativo = TRUE
                  AND a.nivel_acesso = 'gestor'
                  AND a.telefone IS NOT NULL AND a.telefone <> ''
                  AND t.ativo = TRUE
                  AND t.dia_semana = ?
                  AND ? BETWEEN t.hora_inicio AND t.hora_fim
                  ${filtroUnidade}
            `, params);

            // Se ninguém tem turno configurado, verificar se existem turnos no sistema
            if (usuarios.length === 0) {
                const [totalTurnos] = await db.query('SELECT COUNT(*) as total FROM user_turnos WHERE ativo = TRUE');
                if (totalTurnos[0].total === 0) {
                    // Nenhum turno configurado: enviar para todos os gestores HGP com telefone
                    let queryTodos = `SELECT id, nome_completo, telefone FROM admins
                        WHERE ativo = TRUE AND nivel_acesso = 'gestor'
                          AND telefone IS NOT NULL AND telefone <> ''`;
                    const paramsTodos = [];
                    if (unidadeHgpId) {
                        queryTodos += ` AND id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id = ?)`;
                        paramsTodos.push(unidadeHgpId);
                    }
                    const [todosUsuarios] = await db.query(queryTodos, paramsTodos);
                    if (todosUsuarios.length === 0) return;
                    await _dispararNotificacoes(todosUsuarios, dadosChamado);
                    return;
                }
                console.log(`📢 Nenhum gestor HGP em turno agora (dia ${diaSemana}, ${horaAtual}) - notificação não enviada`);
                return;
            }

            await _dispararNotificacoes(usuarios, dadosChamado);
        } catch (erro) {
            registrarErro(erro, `Erro ao notificar usuários sobre chamado ${dadosChamado.protocolo}`);
        }
    }

    async function _dispararNotificacoes(usuarios, dadosChamado) {
        const mensagem = `🚨 *NOVO CHAMADO*\n\n` +
            `📌 *Protocolo:* ${dadosChamado.protocolo}\n` +
            `👤 *Solicitante:* ${dadosChamado.solicitanteNome}\n` +
            `🏢 *Setor:* ${dadosChamado.setor}\n` +
            `📂 *Categoria:* ${dadosChamado.categoria}\n\n` +
            `🔗 Acesse: https://hgpto.shop/chamados`;

        for (const usuario of usuarios) {
            try {
                await enviarMensagemDireta(usuario.telefone, mensagem);
                await delay(300);
            } catch (erro) {
                console.error(`Erro ao notificar ${usuario.nome_completo}:`, erro.message);
            }
        }

        console.log(`📢 Notificação do chamado ${dadosChamado.protocolo} enviada para ${usuarios.length} usuário(s)`);
    }

    async function buscarChamadoAtivo(sessionId) {
        // Tentar busca exata primeiro
        const [chamadosAtivos] = await db.query(
            `SELECT id, protocolo, atendente_nome, status FROM chamados
             WHERE chat_origem = ? AND status IN ('pendente', 'aberto', 'em_atendimento')
             ORDER BY criado_em DESC LIMIT 1`,
            [sessionId]
        );

        if (chamadosAtivos.length > 0) {
            return chamadosAtivos[0];
        }

        // Tentar variações do número (com e sem @c.us, com e sem 9)
        const numLimpo = String(sessionId).replace(/@.*$/, '').replace(/\D/g, '');
        if (numLimpo.length >= 10) {
            const variacoes = [numLimpo, `${numLimpo}@c.us`];
            if (numLimpo.length === 13) {
                variacoes.push(numLimpo.slice(0, 4) + numLimpo.slice(5));
                variacoes.push(numLimpo.slice(0, 4) + numLimpo.slice(5) + '@c.us');
            }
            if (numLimpo.length === 12) {
                variacoes.push(numLimpo.slice(0, 4) + '9' + numLimpo.slice(4));
                variacoes.push(numLimpo.slice(0, 4) + '9' + numLimpo.slice(4) + '@c.us');
            }

            const placeholders = variacoes.map(() => '?').join(',');
            const [chamadosVariacao] = await db.query(
                `SELECT id, protocolo, atendente_nome, status FROM chamados
                 WHERE chat_origem IN (${placeholders}) AND status IN ('pendente', 'aberto', 'em_atendimento')
                 ORDER BY criado_em DESC LIMIT 1`,
                variacoes
            );

            if (chamadosVariacao.length > 0) {
                return chamadosVariacao[0];
            }
        }

        return null;
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
            if (msg.fromMe || msg.from.endsWith('@g.us') || msg.from === 'status@broadcast' || msg.from.endsWith('@newsletter')) return;
            if (String(msg.type || '').includes('notification')) return;
            if (String(msg.type || '').includes('call_log')) return;
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
                if (hora >= 23 || hora < 7) {
                    mensagemAviso = '⏳ INFORMATIVO: Estamos fora do horário de expediente (23:00 às 07:00). Seu chamado será registrado e atendido no próximo turno.';
                }
            } else if (hora >= 23 || hora < 7) {
                mensagemAviso = '⏳ INFORMATIVO: Estamos fora do horário de expediente (23:00 às 07:00). Seu chamado será registrado e atendido no próximo turno.';
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
                        // Se o chamado NÃO está em atendimento, deletar mídia e avisar
                        const tipoMsg = String(msg.type || '').toLowerCase();
                        const ehMidia = msg.hasMedia || ['audio', 'ptt', 'video', 'image', 'document', 'sticker'].includes(tipoMsg);

                        if (ehMidia && chamadoAtivo.status !== 'em_atendimento') {
                            try {
                                await msg.delete(true);
                                console.log(`🗑️ Mídia deletada - chamado ${chamadoAtivo.protocolo} aguardando atendimento (${sessionId})`);
                            } catch (delErr) {
                                console.log(`⚠️ Não foi possível deletar mídia: ${delErr.message}`);
                            }
                            await client.sendMessage(chatId, '🚫 *Mídia removida automaticamente.* Você só poderá enviar áudios, imagens e arquivos após um atendente iniciar o atendimento do seu chamado. Aguarde.');
                            return;
                        }

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
                clearInactivityTimer(sessionId);
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
                    // Deletar mídia enviada junto com a primeira mensagem
                    try {
                        await msg.delete(true);
                        console.log(`🗑️ Mídia deletada na entrada do menu (${sessionId})`);
                    } catch (delErr) {
                        console.log(`⚠️ Não foi possível deletar mídia na entrada: ${delErr.message}`);
                    }
                    await delay(400);
                    await client.sendMessage(chatId, '🚫 *Mídia removida.* Por favor, escolha uma das opções do menu digitando o número correspondente.');
                }
                estados.set(sessionId, { step: 0.5, nomeWhats: contato.pushname || 'Prezado', isTeste: texto === GATILHO_TESTE });
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // Bloquear qualquer mídia durante o fluxo de preenchimento
            if (est && est.step !== undefined) {
                const tipoMsg = String(msg.type || '').toLowerCase();
                if (msg.hasMedia || ['audio', 'ptt', 'video', 'image', 'document', 'sticker', 'call_log'].includes(tipoMsg)) {
                    // Deletar a mensagem de mídia automaticamente
                    try {
                        await msg.delete(true);
                        console.log(`🗑️ Mídia deletada durante fluxo do bot (${sessionId})`);
                    } catch (delErr) {
                        console.log(`⚠️ Não foi possível deletar mídia: ${delErr.message}`);
                    }
                    await client.sendMessage(chatId, '🚫 *Mídia removida automaticamente.* Durante o preenchimento do chamado, só é possível enviar mensagens de texto. Por favor, *digite* sua resposta.');
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
            }

            // Processar avaliação
            if (est.step === 'avaliacao') {
                const nota = parseInt(texto);
                if (nota >= 1 && nota <= 5) {
                    try {
                        const [r] = await db.query(
                            `INSERT INTO avaliacoes (chamado_id, protocolo, nota, atendente_nome, solicitante_nome, chat_origem)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [est.chamadoId, est.protocolo, nota, est.atendenteNome, est.solicitanteNome, sessionId]
                        );
                        const emojis = ['', '😞', '😕', '😐', '😊', '🤩'];
                        await client.sendMessage(chatId, `${emojis[nota]} Obrigado pela avaliação! Sua nota: *${nota}/5*`);

                        // Se nota baixa (1-3), pedir motivo
                        if (nota <= 3) {
                            estados.set(sessionId, {
                                step: 'avaliacao_motivo',
                                avaliacaoId: r.insertId,
                                protocolo: est.protocolo
                            });
                            await client.sendMessage(
                                chatId,
                                '📝 Lamentamos que sua experiência não tenha sido boa. *Você gostaria de nos dizer o motivo?*\n\nDigite o motivo ou envie *NAO* para finalizar sem informar.'
                            );
                            return;
                        }
                    } catch (erro) {
                        registrarErro(erro, 'Erro ao salvar avaliação');
                        await client.sendMessage(chatId, '✓ Obrigado pelo feedback!');
                    }
                    estados.delete(sessionId);
                    return;
                } else {
                    await client.sendMessage(chatId, '⚠️ Por favor, digite um número de *1 a 5* para avaliar.');
                    return;
                }
            }

            // Processar motivo da avaliação baixa
            if (est.step === 'avaliacao_motivo') {
                const motivo = texto.trim();
                if (motivo.toUpperCase() === 'NAO' || motivo.toUpperCase() === 'NÃO') {
                    await client.sendMessage(chatId, '✓ Tudo bem! Obrigado pelo feedback.');
                    estados.delete(sessionId);
                    return;
                }
                if (motivo.length < 3) {
                    await client.sendMessage(chatId, '⚠️ Por favor, descreva o motivo com mais detalhes ou envie *NAO* para finalizar.');
                    return;
                }
                try {
                    await db.query(
                        `UPDATE avaliacoes SET motivo_usuario = ? WHERE id = ?`,
                        [motivo, est.avaliacaoId]
                    );
                    await client.sendMessage(chatId, '✅ Obrigado! Seu feedback foi registrado e será analisado pela equipe.');
                } catch (erro) {
                    registrarErro(erro, 'Erro ao salvar motivo da avaliação');
                    await client.sendMessage(chatId, '✓ Obrigado pelo feedback!');
                }
                estados.delete(sessionId);
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

                // Verificar se há perfil salvo pelo telefone do usuário
                const telefoneUsuario = String(sessionId || '').replace(/@.*$/, '').replace(/\D/g, '');
                if (telefoneUsuario) {
                    try {
                        const [perfilRows] = await db.query(
                            'SELECT dados_json FROM bot_user_profiles WHERE telefone = ? LIMIT 1',
                            [telefoneUsuario]
                        );
                        if (perfilRows.length > 0) {
                            let perfil;
                            try {
                                const raw = perfilRows[0].dados_json;
                                perfil = typeof raw === 'string' ? JSON.parse(raw) : raw;
                            } catch (e) { perfil = null; }

                            if (perfil && (perfil.nome_completo || perfil.telefone)) {
                                est.step = 'confirmar_perfil';
                                est.perfilSalvo = perfil;
                                const linhas = [
                                    `📋 Categoria: *${categoriasMap[est.opcao]}*`,
                                    '',
                                    '👋 *Olá novamente!* Já tenho seus dados pessoais salvos:',
                                    ''
                                ];
                                if (perfil.nome_completo) linhas.push(`• *NOME COMPLETO:* ${perfil.nome_completo}`);
                                if (perfil.telefone) linhas.push(`• *TELEFONE:* ${perfil.telefone}`);
                                linhas.push('', '*1* - Confirmar e seguir');
                                linhas.push('*2* - Editar meus dados');
                                linhas.push('', '_Digite o número da opção._');
                                await client.sendMessage(chatId, linhas.join('\n'));
                                resetInactivityTimer(sessionId, chatId);
                                return;
                            }
                        }
                    } catch (e) {
                        console.error('Erro ao buscar perfil do usuário:', e.message);
                    }
                }

                await client.sendMessage(chatId, 'Para garantir a precisão e agilidade no seu atendimento, solicitamos o preenchimento detalhado dos campos abaixo de acordo com a sua necessidade.');
                await delay(500);
                await client.sendMessage(chatId, '👤 Seu *Nome Completo*:');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // Confirmação do perfil salvo
            if (est.step === 'confirmar_perfil') {
                if (texto === '1') {
                    // Reaproveitar dados pessoais e pular para o setor
                    est.nome = est.perfilSalvo.nome_completo || '';
                    est.tel = est.perfilSalvo.telefone || '';
                    est.step = 2;
                    await client.sendMessage(chatId, '✅ Dados confirmados!');
                    await delay(400);
                    await client.sendMessage(chatId, '🏢 Seu *Setor e Ala*:');
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
                if (texto === '2') {
                    // Editar — começar do zero
                    est.step = 1;
                    await client.sendMessage(chatId, '✏️ Vamos atualizar seus dados.');
                    await delay(400);
                    await client.sendMessage(chatId, '👤 Seu *Nome Completo*:');
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
                await client.sendMessage(chatId, '❌ Opção inválida. Digite *1* para confirmar ou *2* para editar.');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            if (est.step === 1) {
                est.nome = msg.body;
                est.step = 2;
                await client.sendMessage(chatId, '🏢 Seu *Setor e Ala*:');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            if (est.step === 2) {
                est.setor = msg.body;
                est.step = 3;
                await client.sendMessage(chatId, '🌐 *IP do computador:*\nFica no canto superior direito do seu papel de parede (Ex: 10.75.16.1).');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            if (est.step === 3) {
                est.ip = msg.body;
                // Se categoria for Impressora, pedir código
                if (est.opcao === '2') {
                    est.step = 3.5;
                    await client.sendMessage(chatId, '🖨️ *Código da impressora:*\nFica colado no próprio equipamento (Ex: TC1020).');
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
                est.step = 4;
                await client.sendMessage(chatId, '📱 *Telefone* de contato:');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            if (est.step === 3.5) {
                est.codImpressora = msg.body;
                est.step = 4;
                await client.sendMessage(chatId, '📱 *Telefone* de contato:');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            if (est.step === 4) {
                est.tel = msg.body;
                est.step = 5;
                await client.sendMessage(chatId, '📝 Descreva o *Problema*:');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            if (est.step === 5) {
                clearInactivityTimer(sessionId);
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
                    `🌐 *IP:* ${est.ip}\n` +
                    (est.codImpressora ? `🖨️ *Cód. Impressora:* ${est.codImpressora}\n` : '') +
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

                    // Fora do expediente: 23:00 às 06:59
                    if (hora >= 23 || hora < 7) {
                        dentroDoHorario = false;
                    }

                    // Final de semana: sobreaviso, mas fora do expediente após 23:00
                    if (diaSemana === 0 || diaSemana === 6) {
                        if (hora >= 23 || hora < 7) {
                            dentroDoHorario = false;
                        }
                    }

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