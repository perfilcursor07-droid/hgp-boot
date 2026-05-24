// ════════════════════════════════════════════════════════════════════
// Instance Manager — gerencia múltiplas instâncias WhatsApp
// ════════════════════════════════════════════════════════════════════
// IMPORTANTE: este manager NÃO toca na instância legada (admin-session).
// A instância legada continua sendo gerenciada pelo server.js como antes.
// ════════════════════════════════════════════════════════════════════

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fsSync = require('fs');
const path = require('path');
const db = require('../config/database');
const { attachDynamicFlow } = require('./dynamic-flow-handler');

// Pool de instâncias ativas em memória: instanciaId -> { client, controller, status, qr, ... }
const pool = new Map();

const candidateBrowserPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
].filter(Boolean);

function resolveBrowserPath() {
    for (const p of candidateBrowserPaths) {
        if (fsSync.existsSync(p)) return p;
    }
    return undefined;
}

function buildPuppeteerConfig() {
    const executablePath = resolveBrowserPath();
    const config = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--no-first-run'
        ]
    };
    if (executablePath) config.executablePath = executablePath;
    return config;
}

async function carregarFlowDefinition(flowId) {
    if (!flowId) return null;
    const [rows] = await db.query('SELECT definicao_json FROM bot_flows_v2 WHERE id = ? AND ativo = TRUE', [flowId]);
    if (rows.length === 0) return null;
    try {
        return JSON.parse(rows[0].definicao_json);
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

    const [rows] = await db.query('SELECT * FROM instancias WHERE id = ?', [instanciaId]);
    if (rows.length === 0) throw new Error('Instância não encontrada');
    const inst = rows[0];

    if (inst.is_legacy) {
        throw new Error('A instância legada é gerenciada pelo sistema antigo. Não pode ser controlada por aqui.');
    }

    if (!inst.flow_id) {
        throw new Error('Instância sem fluxo vinculado. Vincule um fluxo antes de conectar.');
    }

    const flowDefinition = await carregarFlowDefinition(inst.flow_id);
    if (!flowDefinition) throw new Error('Fluxo da instância não encontrado ou inativo');

    const sessionDir = path.join(__dirname, '..', '.wwebjs_auth_multi');
    if (!fsSync.existsSync(sessionDir)) fsSync.mkdirSync(sessionDir, { recursive: true });

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: inst.session_name,
            dataPath: sessionDir
        }),
        puppeteer: buildPuppeteerConfig()
    });

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
            const dataUrl = await qrcode.toDataURL(qr);
            entry.qr = dataUrl;
            entry.status = 'qr_ready';
            await atualizarStatusBanco(instanciaId, { status: 'qr_ready', qr_code: dataUrl });
            console.log(`[Instance:${inst.nome}] QR pronto`);
        } catch (e) {
            console.error(`[Instance:${inst.nome}] Erro QR:`, e);
        }
    });

    client.on('ready', async () => {
        entry.status = 'connected';
        entry.qr = null;
        entry.controller = attachDynamicFlow(client, {
            instanciaId: inst.id,
            instanciaNome: inst.nome,
            unidadeId: inst.unidade_id,
            flowDefinition
        });
        await atualizarStatusBanco(instanciaId, {
            status: 'connected',
            qr_code: null,
            last_connected: new Date(),
            last_error: null
        });
        console.log(`[Instance:${inst.nome}] CONECTADO ✓`);
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

        const sessionDir = path.join(__dirname, '..', '.wwebjs_auth_multi');
        for (const inst of insts) {
            const sessionPath = path.join(sessionDir, `session-${inst.session_name}`);
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
    syncOnStartup
};
