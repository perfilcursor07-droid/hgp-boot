// ════════════════════════════════════════════════════════════════════
// Dynamic Flow Handler — Bot que segue um fluxo definido em JSON
// ════════════════════════════════════════════════════════════════════
// Ele NÃO substitui o chatbot-handler.js original (instância legada).
// Apenas as instâncias novas (não-legadas) usam este handler.
// ════════════════════════════════════════════════════════════════════

const dayjs = require('dayjs');
const db = require('../config/database');

const ATTACH_FLAG = Symbol.for('hgp.dynamicFlow.attached');

function gerarProtocolo(prefixo = 'HGP') {
    const data = dayjs().format('DDMM');
    const random = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `${prefixo}-${data}-${random}`;
}

// Campos que são "pessoais" e devem ser memorizados entre chamados
const CAMPOS_PESSOAIS = ['nome_completo', 'cpf', 'email', 'telefone'];

function extrairTelefoneDoSession(sessionId) {
    return String(sessionId || '').replace(/@.*$/, '').replace(/\D/g, '');
}

async function buscarPerfilPorTelefone(telefone) {
    if (!telefone) return null;
    try {
        const [rows] = await db.query(
            `SELECT dados_json FROM bot_user_profiles WHERE telefone = ? LIMIT 1`,
            [telefone]
        );
        if (rows.length === 0) return null;
        const d = rows[0].dados_json;
        return typeof d === 'string' ? JSON.parse(d) : d;
    } catch (e) {
        return null;
    }
}

async function salvarPerfilPorTelefone(telefone, dados, unidadeId = null) {
    if (!telefone) return;
    try {
        // Extrair só os campos pessoais
        const perfil = {};
        for (const k of CAMPOS_PESSOAIS) {
            if (dados[k] !== undefined && dados[k] !== null && dados[k] !== '') {
                perfil[k] = dados[k];
            }
        }
        if (Object.keys(perfil).length === 0) return;

        // Mesclar com perfil existente
        const existente = await buscarPerfilPorTelefone(telefone);
        const merged = { ...(existente || {}), ...perfil };

        await db.query(
            `INSERT INTO bot_user_profiles (telefone, dados_json, ultima_unidade_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE dados_json = ?, ultima_unidade_id = ?`,
            [telefone, JSON.stringify(merged), unidadeId, JSON.stringify(merged), unidadeId]
        );
    } catch (e) {
        console.error('Erro salvarPerfilPorTelefone:', e.message);
    }
}

function validarCampo(valor, tipo, opcoes = null) {
    const v = String(valor || '').trim();
    if (!v) return false;
    switch (tipo) {
        case 'cpf': {
            const digits = v.replace(/\D/g, '');
            return digits.length === 11;
        }
        case 'email':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        case 'telefone': {
            const digits = v.replace(/\D/g, '');
            return digits.length >= 10 && digits.length <= 13;
        }
        case 'opcoes': {
            // valida se digitou um número que existe nas opções
            if (!Array.isArray(opcoes)) return false;
            return opcoes.some(o => String(o.id) === v);
        }
        case 'texto_longo':
            return v.length >= 5;
        case 'texto':
        default:
            return v.length >= 1;
    }
}

function attachDynamicFlow(client, options = {}) {
    if (client[ATTACH_FLAG]) return client[ATTACH_FLAG];

    const {
        instanciaId,
        instanciaNome = 'Instância',
        unidadeId = null,
        flowDefinition,
        registrarEvento = () => {}
    } = options;

    if (!flowDefinition) {
        console.error(`[DynamicFlow:${instanciaNome}] flowDefinition não fornecida`);
        return null;
    }

    const estados = new Map();
    const bloqueados = new Map();
    const mensagensProcessadas = new Map();
    const inactivityTimers = new Map();
    const INACTIVITY_TIMEOUT = (flowDefinition.inatividadeMinutos || 10) * 60 * 1000;
    const COOLDOWN_POS_TICKET = 60 * 1000; // 1 min após criar chamado

    const log = (msg) => console.log(`[DynamicFlow:${instanciaNome}] ${msg}`);

    // Cria chamado final + notifica + salva perfil + limpa estado
    async function criarChamadoFinal(est, sessionId, contato, chatId) {
        try {
            const { id, protocolo } = await salvarChamado(est, sessionId, contato);
            await client.sendMessage(
                chatId,
                `✅ *Chamado criado com sucesso!*\n\n📌 Protocolo: *${protocolo}*\n📋 Categoria: ${est.categoria}\n\nNossa equipe entrará em contato em breve. Para acompanhar, guarde seu protocolo.\n\n_Envie CANCELAR a qualquer momento se precisar abrir um novo chamado._`
            );

            // Salvar/atualizar perfil do usuário
            const telefone = extrairTelefoneDoSession(sessionId);
            await salvarPerfilPorTelefone(telefone, est.dados, unidadeId);

            // Notificar técnicos
            notificarTecnicosDaUnidade({ id, protocolo, categoria: est.categoria }, est.dados).catch(() => {});

            estados.delete(sessionId);
            bloquearSessao(sessionId);
            clearTimeout(inactivityTimers.get(sessionId));
            inactivityTimers.delete(sessionId);
        } catch (e) {
            console.error('Erro ao criar chamado:', e);
            await client.sendMessage(chatId, '❌ Ocorreu um erro ao criar o chamado. Tente novamente mais tarde.');
            estados.delete(sessionId);
        }
    }

    function resetInactivityTimer(sessionId, chatId) {
        const existing = inactivityTimers.get(sessionId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
            try {
                await client.sendMessage(chatId, '⏰ Sessão encerrada por inatividade. Envie qualquer mensagem para começar de novo.');
            } catch (e) {}
            estados.delete(sessionId);
            inactivityTimers.delete(sessionId);
        }, INACTIVITY_TIMEOUT);

        inactivityTimers.set(sessionId, timer);
    }

    function bloquearSessao(sessionId) {
        bloqueados.set(sessionId, Date.now() + COOLDOWN_POS_TICKET);
        setTimeout(() => bloqueados.delete(sessionId), COOLDOWN_POS_TICKET);
    }

    function montarMenuPrincipal() {
        const menu = flowDefinition.menuPrincipal;
        const linhas = [menu.titulo, ''];
        for (const opc of menu.opcoes) {
            linhas.push(`*${opc.id}* - ${opc.label}`);
        }
        linhas.push('', '_Digite o número da opção desejada ou CANCELAR para sair._');
        return linhas.join('\n');
    }

    function montarSubmenu(submenuKey) {
        const sm = flowDefinition.submenus?.[submenuKey];
        if (!sm) return null;
        const linhas = [sm.titulo, ''];
        for (const opc of sm.opcoes) {
            linhas.push(`*${opc.id}* - ${opc.label}`);
        }
        linhas.push('', '_Digite o número da opção desejada._');
        return linhas.join('\n');
    }

    function obterBloco(blocoKey) {
        return flowDefinition.blocos?.[blocoKey] || flowDefinition.blocos?.padrao;
    }

    function montarPromptCampo(campo) {
        const obrig = campo.obrigatorio ? '' : ' _(opcional, envie - para pular)_';
        let prompt = `📝 *${campo.label}*${obrig}`;

        // Tipo "opcoes": listar as opções e pedir o número
        if (campo.tipo === 'opcoes' && Array.isArray(campo.opcoes)) {
            prompt += '\n';
            for (const opc of campo.opcoes) {
                prompt += `\n*${opc.id}* - ${opc.label}`;
            }
            prompt += '\n\n_Digite o número da opção._';
        }

        return prompt;
    }

    // Tem campos pessoais no bloco?
    function blocoTemCamposPessoais(bloco) {
        return bloco.campos.some(c => CAMPOS_PESSOAIS.includes(c.key));
    }

    // Resumo de dados pessoais salvos
    function montarResumoPerfil(perfil, bloco) {
        const linhas = ['👋 *Olá novamente!* Já tenho seus dados pessoais salvos:', ''];
        for (const c of bloco.campos) {
            if (CAMPOS_PESSOAIS.includes(c.key) && perfil[c.key]) {
                linhas.push(`• *${c.label}:* ${perfil[c.key]}`);
            }
        }
        linhas.push('', '*1* - Confirmar e seguir');
        linhas.push('*2* - Editar meus dados');
        linhas.push('', '_Digite o número da opção._');
        return linhas.join('\n');
    }

    // Próximo passo após confirmação do perfil: pular campos pessoais e ir direto pros contextuais
    function proximoCampoApolsConfirmacao(estado) {
        const bloco = estado.bloco;
        // Procurar o primeiro campo NÃO pessoal (ou que não tenha valor preenchido)
        for (let i = 0; i < bloco.campos.length; i++) {
            const c = bloco.campos[i];
            if (estado.dados[c.key] === undefined) {
                estado.campoIdx = i;
                return c;
            }
        }
        return null; // todos preenchidos — finalizar
    }

    async function salvarChamado(estado, sessionId, contato) {
        // Buscar código da unidade para usar como prefixo do protocolo
        let prefixo = 'HGP';
        if (unidadeId) {
            try {
                const [r] = await db.query('SELECT codigo FROM unidades WHERE id = ? LIMIT 1', [unidadeId]);
                if (r.length > 0 && r[0].codigo) {
                    prefixo = String(r[0].codigo).toUpperCase();
                }
            } catch (e) {}
        }
        const protocolo = gerarProtocolo(prefixo);
        const dados = estado.dados || {};
        const categoria = estado.categoria || 'Outros';
        const subcategoria = estado.subcategoria || null;

        const descricaoFinal = subcategoria
            ? `[${subcategoria}] ${dados.descricao || ''}`
            : (dados.descricao || '');

        const [result] = await db.query(
            `INSERT INTO chamados (
                protocolo, categoria, solicitante_nome, nome_whatsapp, telefone_whatsapp,
                setor, ip_maquina, telefone_contato, descricao, status, chat_origem,
                unidade_id, instancia_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`,
            [
                protocolo,
                categoria,
                dados.nome_completo || dados.nome || 'Não informado',
                contato?.pushname || dados.nome_completo || null,
                contato?.number || sessionId.replace(/@.*$/, ''),
                `${dados.unidade || ''} - ${dados.setor || ''}`.trim().replace(/^- |-$/, ''),
                dados.ip || null,
                dados.telefone || null,
                descricaoFinal,
                sessionId,
                unidadeId,
                instanciaId
            ]
        );

        return { id: result.insertId, protocolo };
    }

    async function notificarTecnicosDaUnidade(chamado, dadosForm) {
        if (!unidadeId) return;
        try {
            // Buscar técnicos vinculados à unidade
            const [tecnicos] = await db.query(
                `SELECT a.id, a.username, a.nome_completo, a.telefone
                 FROM admins a
                 JOIN admin_unidades au ON au.admin_id = a.id
                 WHERE au.unidade_id = ? AND a.ativo = TRUE
                   AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
                   AND a.telefone IS NOT NULL AND a.telefone != ''`,
                [unidadeId]
            );

            if (tecnicos.length === 0) {
                log(`Nenhum técnico vinculado à unidade ${unidadeId}`);
                return;
            }

            const mensagem = [
                `🆕 *NOVO CHAMADO — ${chamado.protocolo}*`,
                ``,
                `📋 *Categoria:* ${chamado.categoria}`,
                `👤 *Solicitante:* ${dadosForm.nome_completo || 'N/I'}`,
                `🏢 *Unidade/Setor:* ${dadosForm.unidade || ''} - ${dadosForm.setor || ''}`,
                `📞 *Contato:* ${dadosForm.telefone || 'N/I'}`,
                dadosForm.email ? `📧 *E-mail:* ${dadosForm.email}` : null,
                dadosForm.cpf ? `🆔 *CPF:* ${dadosForm.cpf}` : null,
                dadosForm.ip ? `💻 *IP:* ${dadosForm.ip}` : null,
                dadosForm.codigo_impressora ? `🖨️ *Código:* ${dadosForm.codigo_impressora}` : null,
                dadosForm.numero_serie ? `🔢 *Nº Série:* ${dadosForm.numero_serie}` : null,
                ``,
                `📝 *Descrição:*`,
                dadosForm.descricao || 'Sem descrição',
                ``,
                `_Acesse o sistema para atender._`
            ].filter(Boolean).join('\n');

            for (const tec of tecnicos) {
                const tel = String(tec.telefone || '').replace(/\D/g, '');
                if (!tel) continue;
                const numero = tel.startsWith('55') ? tel : `55${tel}`;
                try {
                    await client.sendMessage(`${numero}@c.us`, mensagem);
                    log(`Notificação enviada para ${tec.nome_completo || tec.username}`);
                } catch (e) {
                    log(`Falha ao notificar ${tec.username}: ${e.message}`);
                }
            }
        } catch (e) {
            log(`Erro ao notificar técnicos: ${e.message}`);
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // HANDLER PRINCIPAL DE MENSAGENS
    // ──────────────────────────────────────────────────────────────────
    const onMessage = async (msg) => {
        try {
            const sessionId = msg.from;
            if (!sessionId || sessionId === 'status@broadcast') return;
            if (sessionId.endsWith('@g.us')) return; // ignorar grupos

            // Dedup
            const msgId = msg.id?._serialized || `${msg.from}-${msg.timestamp}`;
            if (mensagensProcessadas.has(msgId)) return;
            mensagensProcessadas.set(msgId, Date.now() + 60_000);
            setTimeout(() => mensagensProcessadas.delete(msgId), 60_000);

            // Bloqueado pós-ticket
            const bloqEat = bloqueados.get(sessionId);
            if (bloqEat && Date.now() < bloqEat) return;

            const texto = String(msg.body || '').trim();
            if (!texto && !msg.hasMedia) return;

            const contato = await msg.getContact().catch(() => ({}));
            const chatId = sessionId;

            // CANCELAR
            if (texto.toUpperCase() === 'CANCELAR') {
                estados.delete(sessionId);
                clearTimeout(inactivityTimers.get(sessionId));
                inactivityTimers.delete(sessionId);
                await client.sendMessage(chatId, '✅ Atendimento cancelado. Envie qualquer mensagem para começar de novo.');
                return;
            }

            const est = estados.get(sessionId);

            // ── Verificar chamado ativo (em atendimento) e salvar mensagem no chat ──
            // Só verifica se NÃO está dentro de um fluxo (sem estado ou estado terminal)
            if (!est || est.step === undefined) {
                try {
                    const [chamadosAtivos] = await db.query(
                        `SELECT id, protocolo, status FROM chamados
                         WHERE chat_origem = ? AND status IN ('aberto', 'em_atendimento')
                         ORDER BY criado_em DESC LIMIT 1`,
                        [sessionId]
                    );

                    const chamadoAtivo = chamadosAtivos[0];

                    if (chamadoAtivo) {
                        const tipoMsg = String(msg.type || '').toLowerCase();
                        const ehMidia = msg.hasMedia || ['audio','ptt','video','image','document','sticker'].includes(tipoMsg);

                        // Se for mídia e chamado ainda não está em atendimento, deletar
                        if (ehMidia && chamadoAtivo.status !== 'em_atendimento') {
                            try { await msg.delete(true); } catch (e) {}
                            await client.sendMessage(chatId, '🚫 *Mídia removida.* Você só poderá enviar mídia após um atendente iniciar seu chamado. Aguarde.');
                            return;
                        }

                        // Salvar a mensagem do solicitante no chat_messages
                        const contactName = contato?.pushname || contato?.name || 'Solicitante';
                        let messageType = 'text';
                        let mediaUrl = null, mediaMimeType = null, mediaFilename = null;
                        let mensagemTexto = texto;

                        if (ehMidia) {
                            messageType = ['audio','ptt'].includes(tipoMsg) ? 'audio' : tipoMsg;
                            mensagemTexto = msg.body || `[${messageType}]`;
                            // Salvar mídia em disco (best-effort)
                            try {
                                const media = await msg.downloadMedia();
                                if (media) {
                                    const fs = require('fs');
                                    const path = require('path');
                                    const dir = path.join(__dirname, '..', 'public', 'uploads', 'chat-media');
                                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                                    const ext = (media.mimetype || '').split('/').pop().split(';')[0] || 'bin';
                                    const filename = `chamado-${chamadoAtivo.id}-${Date.now()}.${ext}`;
                                    fs.writeFileSync(path.join(dir, filename), Buffer.from(media.data, 'base64'));
                                    mediaUrl = `/uploads/chat-media/${filename}`;
                                    mediaMimeType = media.mimetype;
                                    mediaFilename = media.filename || filename;
                                }
                            } catch (e) {
                                console.error('Erro ao salvar mídia do solicitante:', e.message);
                            }
                        }

                        await db.query(
                            `INSERT INTO chat_messages (
                                chamado_id, remetente_tipo, remetente_nome,
                                mensagem, message_type, media_url, media_mime_type, media_filename
                             ) VALUES (?, 'solicitante', ?, ?, ?, ?, ?, ?)`,
                            [chamadoAtivo.id, contactName, mensagemTexto, messageType, mediaUrl, mediaMimeType, mediaFilename]
                        );

                        console.log(`[DynamicFlow:${instanciaNome}] Mensagem do solicitante salva no chamado ${chamadoAtivo.protocolo}`);
                        return; // não processa como menu/fluxo
                    }
                } catch (e) {
                    console.error(`[DynamicFlow:${instanciaNome}] Erro ao processar mensagem para chamado ativo:`, e.message);
                }
            }

            // Sem estado: enviar menu
            if (!est) {
                estados.set(sessionId, { step: 'menu' });
                resetInactivityTimer(sessionId, chatId);
                await client.sendMessage(chatId, montarMenuPrincipal());
                return;
            }

            // Bloquear mídia durante fluxo
            if (msg.hasMedia || ['audio','ptt','video','image','document','sticker'].includes(String(msg.type).toLowerCase())) {
                try { await msg.delete(true); } catch (e) {}
                await client.sendMessage(chatId, '🚫 Durante o atendimento, envie somente *texto*.');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: MENU PRINCIPAL ──
            if (est.step === 'menu') {
                const opcao = flowDefinition.menuPrincipal.opcoes.find(o => o.id === texto);
                if (!opcao) {
                    await client.sendMessage(chatId, '❌ Opção inválida.\n\n' + montarMenuPrincipal());
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }

                est.opcaoMenu = opcao;
                est.categoria = opcao.categoria;

                // Tem submenu?
                if (opcao.submenu) {
                    est.step = 'submenu';
                    est.submenuKey = opcao.submenu;
                    await client.sendMessage(chatId, montarSubmenu(opcao.submenu));
                } else {
                    // Verificar se há perfil salvo antes de iniciar preenchimento
                    const bloco = obterBloco(opcao.camposBloco);
                    est.bloco = bloco;
                    est.dados = {};

                    const telefone = extrairTelefoneDoSession(sessionId);
                    const perfil = blocoTemCamposPessoais(bloco) ? await buscarPerfilPorTelefone(telefone) : null;

                    if (perfil && Object.keys(perfil).length > 0) {
                        est.step = 'confirmar_perfil';
                        est.perfilSalvo = perfil;
                        await client.sendMessage(chatId, `📋 Categoria: *${opcao.label}*\n\n` + montarResumoPerfil(perfil, bloco));
                    } else {
                        est.step = 'preenchimento';
                        est.campoIdx = 0;
                        const primeiroCampo = bloco.campos[0];
                        await client.sendMessage(chatId, `📋 Categoria: *${opcao.label}*\n\nVamos coletar seus dados.\n\n` + montarPromptCampo(primeiroCampo));
                    }
                }
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: SUBMENU ──
            if (est.step === 'submenu') {
                const sm = flowDefinition.submenus[est.submenuKey];
                const opcao = sm.opcoes.find(o => o.id === texto);
                if (!opcao) {
                    await client.sendMessage(chatId, '❌ Opção inválida.\n\n' + montarSubmenu(est.submenuKey));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }

                est.subcategoria = opcao.label;
                const bloco = obterBloco(est.opcaoMenu.camposBloco);
                est.bloco = bloco;
                est.dados = {};

                const telefone = extrairTelefoneDoSession(sessionId);
                const perfil = blocoTemCamposPessoais(bloco) ? await buscarPerfilPorTelefone(telefone) : null;

                if (perfil && Object.keys(perfil).length > 0) {
                    est.step = 'confirmar_perfil';
                    est.perfilSalvo = perfil;
                    await client.sendMessage(chatId, `📋 Sistema: *${opcao.label}*\n\n` + montarResumoPerfil(perfil, bloco));
                } else {
                    est.step = 'preenchimento';
                    est.campoIdx = 0;
                    const primeiroCampo = bloco.campos[0];
                    await client.sendMessage(chatId, `📋 Sistema selecionado: *${opcao.label}*\n\nVamos coletar seus dados.\n\n` + montarPromptCampo(primeiroCampo));
                }
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: CONFIRMAR PERFIL SALVO ──
            if (est.step === 'confirmar_perfil') {
                if (texto === '1') {
                    // Reaproveitar dados do perfil
                    est.dados = { ...est.perfilSalvo };
                    est.step = 'preenchimento';
                    const proximo = proximoCampoApolsConfirmacao(est);
                    if (!proximo) {
                        // Não tem campo contextual — finalizar direto
                        await criarChamadoFinal(est, sessionId, contato, chatId);
                        return;
                    }
                    await client.sendMessage(chatId, `✅ Dados confirmados!\n\nAgora preciso só dos dados específicos do chamado.\n\n` + montarPromptCampo(proximo));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
                if (texto === '2') {
                    // Editar — começar do zero
                    est.dados = {};
                    est.step = 'preenchimento';
                    est.campoIdx = 0;
                    const primeiro = est.bloco.campos[0];
                    await client.sendMessage(chatId, `✏️ Vamos editar seus dados.\n\n` + montarPromptCampo(primeiro));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
                await client.sendMessage(chatId, '❌ Opção inválida. Digite *1* para confirmar ou *2* para editar.');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: PREENCHIMENTO DOS CAMPOS ──
            if (est.step === 'preenchimento') {
                const campo = est.bloco.campos[est.campoIdx];
                const respostaPulou = texto === '-' && !campo.obrigatorio;

                if (!respostaPulou) {
                    if (!validarCampo(texto, campo.tipo, campo.opcoes)) {
                        await client.sendMessage(
                            chatId,
                            `❌ Valor inválido para *${campo.label}*. Por favor, envie novamente.\n\n` + montarPromptCampo(campo)
                        );
                        resetInactivityTimer(sessionId, chatId);
                        return;
                    }
                    // Para tipo "opcoes", salvar o label da opção escolhida ao invés do número
                    if (campo.tipo === 'opcoes' && Array.isArray(campo.opcoes)) {
                        const escolhida = campo.opcoes.find(o => String(o.id) === texto);
                        est.dados[campo.key] = escolhida ? escolhida.label : texto;
                    } else {
                        est.dados[campo.key] = texto;
                    }
                } else {
                    est.dados[campo.key] = null;
                }

                // Avançar para o próximo campo que ainda não tem valor
                let proximoIdx = est.campoIdx + 1;
                while (proximoIdx < est.bloco.campos.length && est.dados[est.bloco.campos[proximoIdx].key] !== undefined) {
                    proximoIdx += 1;
                }
                est.campoIdx = proximoIdx;

                // Próximo campo
                if (est.campoIdx < est.bloco.campos.length) {
                    const proximo = est.bloco.campos[est.campoIdx];
                    await client.sendMessage(chatId, montarPromptCampo(proximo));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }

                // Fim — criar chamado
                await criarChamadoFinal(est, sessionId, contato, chatId);
                return;
            }

            // ── ETAPA: AVALIAÇÃO ──
            if (est.step === 'avaliacao') {
                const nota = parseInt(texto, 10);
                if (nota >= 1 && nota <= 5) {
                    try {
                        const [r] = await db.query(
                            `INSERT INTO avaliacoes (chamado_id, protocolo, nota, atendente_nome, solicitante_nome, chat_origem)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [est.chamadoId, est.protocolo, nota, est.atendenteNome, est.solicitanteNome, sessionId]
                        );
                        const emojis = ['', '😞', '😕', '😐', '😊', '🤩'];
                        await client.sendMessage(chatId, `${emojis[nota]} Obrigado pela avaliação! Sua nota: *${nota}/5*`);

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
                    } catch (e) {
                        await client.sendMessage(chatId, '✓ Obrigado pelo feedback!');
                    }
                    estados.delete(sessionId);
                } else {
                    await client.sendMessage(chatId, '❌ Envie um número de 1 a 5.');
                }
                return;
            }

            // ── ETAPA: MOTIVO DA AVALIAÇÃO BAIXA ──
            if (est.step === 'avaliacao_motivo') {
                const motivo = texto.trim();
                if (motivo.toUpperCase() === 'NAO' || motivo.toUpperCase() === 'NÃO') {
                    await client.sendMessage(chatId, '✓ Tudo bem! Obrigado pelo feedback.');
                    estados.delete(sessionId);
                    return;
                }
                if (motivo.length < 3) {
                    await client.sendMessage(chatId, '⚠️ Descreva o motivo com mais detalhes ou envie *NAO* para finalizar.');
                    return;
                }
                try {
                    await db.query(`UPDATE avaliacoes SET motivo_usuario = ? WHERE id = ?`, [motivo, est.avaliacaoId]);
                    await client.sendMessage(chatId, '✅ Obrigado! Seu feedback foi registrado e será analisado pela equipe.');
                } catch (e) {
                    await client.sendMessage(chatId, '✓ Obrigado pelo feedback!');
                }
                estados.delete(sessionId);
                return;
            }
        } catch (e) {
            console.error(`[DynamicFlow:${instanciaNome}] Erro no handler:`, e);
        }
    };

    client.on('message', onMessage);

    const controller = {
        instanciaId,
        instanciaNome,
        // Reabrir fluxo após encerramento (chamado pela rota /encerrar)
        async reiniciarFluxoPorEncerramento(chatOrigem, dadosChamado) {
            try {
                const chatId = chatOrigem;
                if (!chatId) return false;

                // Mensagem de encerramento
                const msgEnc = `✅ *Chamado encerrado.*\n📌 Protocolo: *${dadosChamado.protocolo}*\n👤 Atendente: ${dadosChamado.atendenteNome}\n\nObrigado por utilizar nosso atendimento.`;
                await client.sendMessage(chatId, msgEnc);

                // Se avaliação habilitada, perguntar nota
                if (flowDefinition.avaliacao?.habilitada) {
                    estados.set(chatId, {
                        step: 'avaliacao',
                        chamadoId: dadosChamado.chamadoId,
                        protocolo: dadosChamado.protocolo,
                        atendenteNome: dadosChamado.atendenteNome,
                        solicitanteNome: dadosChamado.nomeExibicao
                    });
                    // pequeno delay
                    await new Promise(r => setTimeout(r, 600));
                    await client.sendMessage(chatId, flowDefinition.avaliacao.texto);
                }
                return true;
            } catch (e) {
                console.error('Erro reiniciarFluxoPorEncerramento:', e);
                return false;
            }
        }
    };

    client[ATTACH_FLAG] = controller;
    return controller;
}

module.exports = { attachDynamicFlow };
