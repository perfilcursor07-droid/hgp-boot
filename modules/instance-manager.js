// ════════════════════════════════════════════════════════════════════
// Instance Manager — gerencia múltiplas instâncias WhatsApp
// ════════════════════════════════════════════════════════════════════
// IMPORTANTE: este manager NÃO toca na instância legada (admin-session).
// A instância legada continua sendo gerenciada pelo server.js como antes.
// ════════════════════════════════════════════════════════════════════

const { BaileysClient } = require('./baileys-client');
const fsSync = require('fs');
const path = require('path');
const db = require('../config/database');
const { attachDynamicFlow } = require('./dynamic-flow-handler');
const { normalizarFluxoSesau } = require('./flow-normalizer');

// Pool de instâncias ativas em memória: instanciaId -> { client, controller, status, qr, ... }
const pool = new Map();

async function carregarFlowDefinition(flowId, meta = {}) {
    if (!flowId) return null;
    const [rows] = await db.query('SELECT nome, definicao_json FROM bot_flows_v2 WHERE id = ? AND ativo = TRUE', [flowId]);
    if (rows.length === 0) return null;
    try {
        return normalizarFluxoSesau(JSON.parse(rows[0].definicao_json), {
            ...meta,
            flowNome: rows[0].nome
        });
    } catch (e) {
        console.error('Erro ao parsear definição do flow:', e);
        return null;
    }
}

async function atualizarStatusBanco(instanciaId, dados) {
    const campos = [];
    const valores = [];
    for (const [k, v] of Object.entries(dados)) {
        campos.push(`${k} = ?`);
        valores.push(v);
    }
    if (campos.length === 0) return;
    valores.push(instanciaId);
    await db.query(`UPDATE instancias SET ${campos.join(', ')} WHERE id = ?`, valores);
}

async function iniciarInstancia(instanciaId) {
    if (pool.has(instanciaId)) {
        const ent = pool.get(instanciaId);
        if (ent.status === 'connected' || ent.status === 'connecting' || ent.status === 'qr_ready') {
            return ent;
        }
    }

    const [rows] = await db.query(`
        SELECT i.*, u.codigo AS unidade_codigo, u.nome AS unidade_nome
        FROM instancias i
        LEFT JOIN unidades u ON u.id = i.unidade_id
        WHERE i.id = ?
    `, [instanciaId]);
    if (rows.length === 0) throw new Error('Instância não encontrada');
    const inst = rows[0];

    if (inst.is_legacy) {
        throw new Error('A instância legada é gerenciada pelo sistema antigo. Não pode ser controlada por aqui.');
    }

    if (!inst.flow_id) {
        throw new Error('Instância sem fluxo vinculado. Vincule um fluxo antes de conectar.');
    }

    const flowDefinition = await carregarFlowDefinition(inst.flow_id, {
        unidadeCodigo: inst.unidade_codigo,
        unidadeNome: inst.unidade_nome
    });
    if (!flowDefinition) throw new Error('Fluxo da instância não encontrado ou inativo');

    const client = new BaileysClient({ clientId: inst.session_name });

    const entry = {
        instanciaId: inst.id,
        instanciaNome: inst.nome,
        sessionName: inst.session_name,
        unidadeId: inst.unidade_id,
        flowId: inst.flow_id,
        client,
        controller: null,
        status: 'connecting',
        qr: null,
        lastError: null
    };
    pool.set(instanciaId, entry);

    await atualizarStatusBanco(instanciaId, { status: 'connecting', last_error: null, qr_code: null });

    client.on('qr', async (qr) => {
        try {
            // BaileysClient já emite como dataURL
            entry.qr = qr;
            entry.status = 'qr_ready';
            await atualizarStatusBanco(instanciaId, { status: 'qr_ready', qr_code: qr });
            console.log(`[Instance:${inst.nome}] QR pronto`);
        } catch (e) {
            console.error(`[Instance:${inst.nome}] Erro QR:`, e);
        }
    });

    client.on('ready', async () => {
        entry.status = 'connected';
        entry.qr = null;
        // Attach o flow handler apenas uma vez (evita duplicação na reconexão)
        if (!entry.controller) {
            entry.controller = attachDynamicFlow(client, {
                instanciaId: inst.id,
                instanciaNome: inst.nome,
                unidadeId: inst.unidade_id,
                flowDefinition
            });
        }
        await atualizarStatusBanco(instanciaId, {
            status: 'connected',
            qr_code: null,
            last_connected: new Date(),
            last_error: null
        });

        // Garantir que existe registro em whatsapp_sessions para esta instância
        // (necessário para a tabela messages — chave estrangeira)
        try {
            await db.query(
                `INSERT INTO whatsapp_sessions (session_name, is_connected, last_connected)
                 VALUES (?, TRUE, NOW())
                 ON DUPLICATE KEY UPDATE is_connected = TRUE, last_connected = NOW()`,
                [inst.session_name]
            );
        } catch (e) {
            console.error(`[Instance:${inst.nome}] Erro ao registrar whatsapp_session:`, e.message);
        }

        console.log(`[Instance:${inst.nome}] CONECTADO ✓`);
    });

    // Listener de mensagens para salvar em `messages` (igual HGP)
    client.on('message', async (message) => {
        console.log(`[Instance:${inst.nome}] msg recebida de ${message.from} id=${message.id?._serialized} pid=${process.pid}`);
        try {
            const [sessions] = await db.query(
                'SELECT id FROM whatsapp_sessions WHERE session_name = ?',
                [inst.session_name]
            );
            if (sessions.length > 0) {
                await db.query(
                    'INSERT INTO messages (session_id, from_number, to_number, message_body, message_type, is_from_me) VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        sessions[0].id,
                        message.from,
                        message.to,
                        message.body || '',
                        String(message.type || 'text').slice(0, 100),
                        message.fromMe
                    ]
                );
            }
        } catch (error) {
            console.error(`[Instance:${inst.nome}] Erro ao registrar mensagem:`, error.message);
        }
    });

    client.on('authenticated', () => {
        console.log(`[Instance:${inst.nome}] Autenticado`);
    });

    client.on('auth_failure', async (msg) => {
        entry.status = 'error';
        entry.lastError = String(msg);
        await atualizarStatusBanco(instanciaId, { status: 'error', last_error: String(msg) });
        console.error(`[Instance:${inst.nome}] Auth falhou:`, msg);
    });

    client.on('disconnected', async (reason) => {
        entry.status = 'disconnected';
        entry.qr = null;
        entry.controller = null;
        await atualizarStatusBanco(instanciaId, { status: 'disconnected', qr_code: null, last_error: String(reason || '') });
        console.log(`[Instance:${inst.nome}] Desconectado: ${reason}`);
        try { await client.destroy(); } catch (e) {}
        pool.delete(instanciaId);

        const motivo = String(reason || '');
        const precisaQr = /LOGOUT|BANIDO|UNPAIRED|logged out/i.test(motivo);
        if (!precisaQr) {
            console.log(`[Instance:${inst.nome}] Auto-reativando em 6s...`);
            setTimeout(() => {
                if (pool.has(instanciaId)) return;
                iniciarInstancia(instanciaId).catch(err => {
                    console.error(`[Instance:${inst.nome}] Falha ao auto-reativar:`, err.message);
                });
            }, 6000);
        }
    });

    client.initialize().catch(async (e) => {
        entry.status = 'error';
        entry.lastError = e.message;
        await atualizarStatusBanco(instanciaId, { status: 'error', last_error: e.message });
        console.error(`[Instance:${inst.nome}] Erro initialize:`, e);
    });

    return entry;
}

async function pararInstancia(instanciaId) {
    const entry = pool.get(instanciaId);
    if (entry) {
        try {
            if (entry.client) {
                await entry.client.destroy();
            }
        } catch (e) {
            console.error('Erro destroy:', e);
        }
        pool.delete(instanciaId);
    }
    await atualizarStatusBanco(instanciaId, {
        status: 'disconnected',
        qr_code: null
    });
}

function obterStatus(instanciaId) {
    const entry = pool.get(instanciaId);
    if (!entry) return { status: 'disconnected', qr: null };
    return { status: entry.status, qr: entry.qr, lastError: entry.lastError };
}

function obterCliente(instanciaId) {
    const entry = pool.get(instanciaId);
    if (!entry) return null;
    if (entry.status !== 'connected') return null;
    return entry.client;
}

function obterController(instanciaId) {
    const entry = pool.get(instanciaId);
    if (!entry) return null;
    return entry.controller;
}

function listarInstanciasAtivas() {
    return Array.from(pool.values()).map(e => ({
        instanciaId: e.instanciaId,
        instanciaNome: e.instanciaNome,
        status: e.status
    }));
}

// Sincroniza ao iniciar — reconecta automaticamente instâncias ativas
async function reconectarInstanciasCaiadas() {
    try {
        const [insts] = await db.query(
            `SELECT id, session_name, nome FROM instancias WHERE is_legacy = FALSE AND ativo = TRUE`
        );
        const sessionDir = path.join(__dirname, '..', '.baileys_auth');
        for (const inst of insts) {
            const sessionPath = path.join(sessionDir, inst.session_name);
            if (!fsSync.existsSync(sessionPath)) continue;

            const entry = pool.get(inst.id);
            if (!entry) {
                console.log(`[InstanceManager] Watchdog: ${inst.nome} fora do pool — reconectando`);
                iniciarInstancia(inst.id).catch(err => {
                    console.error(`[InstanceManager] Falha watchdog ${inst.nome}:`, err.message);
                });
                continue;
            }

            const caiuHa = entry.client?._disconnectedAt ? (Date.now() - entry.client._disconnectedAt) : 0;
            const clienteCaiu = entry.client && entry.client.isConnected === false
                && (entry.status === 'connected' || entry.status === 'error' || entry.status === 'disconnected')
                && caiuHa > 90000;
            if (clienteCaiu) {
                console.log(`[InstanceManager] Watchdog: ${inst.nome} zumbi — reiniciando`);
                try { await pararInstancia(inst.id); } catch (e) {}
                iniciarInstancia(inst.id).catch(err => {
                    console.error(`[InstanceManager] Falha watchdog ${inst.nome}:`, err.message);
                });
            }
        }
    } catch (e) {
        console.error('[InstanceManager] Erro reconectarInstanciasCaiadas:', e.message);
    }
}

async function syncOnStartup() {
    try {
        // Marcar todas como disconnected primeiro
        await db.query(`
            UPDATE instancias 
            SET status = 'disconnected', qr_code = NULL 
            WHERE is_legacy = FALSE
        `);
        console.log('[InstanceManager] Status das instâncias resetado no startup.');

        // Buscar instâncias ativas com sessão WhatsApp já autenticada (pasta existe)
        const [insts] = await db.query(
            `SELECT id, session_name, nome FROM instancias WHERE is_legacy = FALSE AND ativo = TRUE`
        );

        const sessionDir = path.join(__dirname, '..', '.baileys_auth');
        for (const inst of insts) {
            const sessionPath = path.join(sessionDir, inst.session_name);
            if (fsSync.existsSync(sessionPath)) {
                console.log(`[InstanceManager] Auto-reconectando: ${inst.nome}`);
                iniciarInstancia(inst.id).catch(err => {
                    console.error(`[InstanceManager] Falha ao auto-reconectar ${inst.nome}:`, err.message);
                });
            }
        }
    } catch (e) {
        console.error('[InstanceManager] Erro syncOnStartup:', e);
    }
}

module.exports = {
    iniciarInstancia,
    pararInstancia,
    obterStatus,
    obterCliente,
    obterController,
    listarInstanciasAtivas,
    syncOnStartup,
    reconectarInstanciasCaiadas
};
