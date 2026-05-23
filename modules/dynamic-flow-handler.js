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

function validarCampo(valor, tipo) {
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
        return `📝 *${campo.label}*${obrig}`;
    }

    async function salvarChamado(estado, sessionId, contato) {
        const protocolo = gerarProtocolo();
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
                    // Iniciar bloco de campos
                    est.step = 'preenchimento';
                    est.bloco = obterBloco(opcao.camposBloco);
                    est.campoIdx = 0;
                    est.dados = {};
                    const primeiroCampo = est.bloco.campos[0];
                    await client.sendMessage(chatId, `📋 Categoria: *${opcao.label}*\n\nVamos coletar seus dados.\n\n` + montarPromptCampo(primeiroCampo));
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
                est.step = 'preenchimento';
                est.bloco = obterBloco(est.opcaoMenu.camposBloco);
                est.campoIdx = 0;
                est.dados = {};
                const primeiroCampo = est.bloco.campos[0];
                await client.sendMessage(chatId, `📋 Sistema selecionado: *${opcao.label}*\n\nVamos coletar seus dados.\n\n` + montarPromptCampo(primeiroCampo));
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: PREENCHIMENTO DOS CAMPOS ──
            if (est.step === 'preenchimento') {
                const campo = est.bloco.campos[est.campoIdx];
                const respostaPulou = texto === '-' && !campo.obrigatorio;

                if (!respostaPulou) {
                    if (!validarCampo(texto, campo.tipo)) {
                        await client.sendMessage(
                            chatId,
                            `❌ Valor inválido para *${campo.label}*. Por favor, envie novamente.\n\n` + montarPromptCampo(campo)
                        );
                        resetInactivityTimer(sessionId, chatId);
                        return;
                    }
                    est.dados[campo.key] = texto;
                } else {
                    est.dados[campo.key] = null;
                }

                est.campoIdx += 1;

                // Próximo campo
                if (est.campoIdx < est.bloco.campos.length) {
                    const proximo = est.bloco.campos[est.campoIdx];
                    await client.sendMessage(chatId, montarPromptCampo(proximo));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }

                // Fim — criar chamado
                try {
                    const { id, protocolo } = await salvarChamado(est, sessionId, contato);
                    await client.sendMessage(
                        chatId,
                        `✅ *Chamado criado com sucesso!*\n\n📌 Protocolo: *${protocolo}*\n📋 Categoria: ${est.categoria}\n\nNossa equipe entrará em contato em breve. Para acompanhar, guarde seu protocolo.\n\n_Envie CANCELAR a qualquer momento se precisar abrir um novo chamado._`
                    );

                    // Notificar técnicos da unidade
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
                return;
            }

            // ── ETAPA: AVALIAÇÃO ──
            if (est.step === 'avaliacao') {
                const nota = parseInt(texto, 10);
                if (nota >= 1 && nota <= 5) {
                    try {
                        await db.query(
                            `INSERT INTO avaliacoes (chamado_id, protocolo, nota, atendente_nome, solicitante_nome, chat_origem)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [est.chamadoId, est.protocolo, nota, est.atendenteNome, est.solicitanteNome, sessionId]
                        );
                        const emojis = ['', '😞', '😕', '😐', '😊', '🤩'];
                        await client.sendMessage(chatId, `${emojis[nota]} Obrigado pela avaliação! Sua nota: *${nota}/5*`);
                    } catch (e) {
                        await client.sendMessage(chatId, '✓ Obrigado pelo feedback!');
                    }
                    estados.delete(sessionId);
                } else {
                    await client.sendMessage(chatId, '❌ Envie um número de 1 a 5.');
                }
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
                if (flowDefinition.avaliacao?.habilitada) {
                    estados.set(chatId, {
                        step: 'avaliacao',
                        chamadoId: dadosChamado.chamadoId,
                        protocolo: dadosChamado.protocolo,
                        atendenteNome: dadosChamado.atendenteNome,
                        solicitanteNome: dadosChamado.nomeExibicao
                    });
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
