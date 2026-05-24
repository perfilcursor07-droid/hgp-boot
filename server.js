require('dotenv').config();
require('./config/timezone');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const bcrypt = require('bcrypt');
const dayjs = require('dayjs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const db = require('./config/database');
const { ensureSchema } = require('./config/ensureSchema');
const { attachChatbot } = require('./chatbot-handler');
const instanceManager = require('./modules/instance-manager');

const uploadChatMedia = multer({
    storage: multer.diskStorage({
        destination: path.join(__dirname, 'public', 'uploads', 'chat-media'),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `chamado-${req.params.id}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        }
    }),
    limits: { fileSize: 20 * 1024 * 1024 }
});

const app = express();
const PORT = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);
const CHATBOT_FILE_PATH = path.join(__dirname, 'chatbot.js');

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(async (req, res, next) => {
    res.locals.pendingChamadosCount = 0;

    if (!req.session?.userId) {
        return next();
    }

    // Disponibilizar nivelAcesso em todas as views
    res.locals.nivelAcesso = req.session.nivelAcesso || 'administrador';

    // Garantir que unidadeIds esteja na sessão (sessões antigas não tinham)
    if (req.session.unidadeIds === undefined) {
        try {
            if (req.session.nivelAcesso === 'administrador') {
                req.session.unidadeIds = null; // null = todas
            } else {
                const [unids] = await db.query(
                    'SELECT unidade_id FROM admin_unidades WHERE admin_id = ?',
                    [req.session.userId]
                );
                req.session.unidadeIds = unids.map(u => u.unidade_id);
            }
        } catch (e) {
            console.error('Erro ao carregar unidades do usuário:', e.message);
            req.session.unidadeIds = null;
        }
    }

    try {
        // Filtrar por unidades do usuário (admin = null = todas)
        const ids = req.session.unidadeIds;
        let whereClause = `WHERE status IN ('pendente', 'aberto')`;
        const params = [];

        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                whereClause += ` AND unidade_id IS NULL`;
            } else {
                whereClause += ` AND (unidade_id IS NULL OR unidade_id IN (${ids.map(() => '?').join(',')}))`;
                params.push(...ids);
            }
        }

        const [rows] = await db.query(
            `SELECT COUNT(*) AS total FROM chamados ${whereClause}`,
            params
        );
        res.locals.pendingChamadosCount = Number(rows[0]?.total || 0);
    } catch (error) {
        console.error('Erro ao carregar contagem pendente para o menu:', error);
    }

    next();
});

// WhatsApp client
let whatsappClient = null;
let whatsappChatbotController = null;
let currentQR = null;
let whatsappState = 'disconnected';
let whatsappLastError = null;

const candidateBrowserPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
].filter(Boolean);

const resolveBrowserExecutablePath = () => {
    for (const browserPath of candidateBrowserPaths) {
        if (fsSync.existsSync(browserPath)) {
            return browserPath;
        }
    }

    return undefined;
};

const buildPuppeteerConfig = () => {
    const executablePath = resolveBrowserExecutablePath();
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

    if (executablePath) {
        config.executablePath = executablePath;
    }

    return config;
};

const formatWhatsAppError = (error) => {
    const rawMessage = error?.message || String(error || 'Erro desconhecido ao iniciar o WhatsApp');

    if (/executable|chrome|chromium|browser/i.test(rawMessage)) {
        return `Falha ao iniciar o navegador do WhatsApp. Configure CHROME_BIN ou PUPPETEER_EXECUTABLE_PATH no servidor. Detalhe: ${rawMessage}`;
    }

    return rawMessage;
};

const isIgnorableWhatsAppRuntimeError = (error) => {
    const rawMessage = error?.message || String(error || '');

    return /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Most likely the page has been closed/i.test(rawMessage);
};

const logRuntimeError = (label, error) => {
    console.error(`${label}:`, error);
};

const isApiRequest = (req) => req.path.startsWith('/api/') || req.path.startsWith('/whatsapp/');

const syncDisconnectedSession = async () => {
    try {
        await db.query(
            'UPDATE whatsapp_sessions SET is_connected = ?, qr_code = NULL WHERE session_name = ?',
            [false, 'admin-session']
        );
        // Espelhar status na tabela instancias (legacy)
        await db.query(
            `UPDATE instancias SET status = 'disconnected', qr_code = NULL WHERE session_name = 'admin-session'`
        );
    } catch (error) {
        console.error('Erro ao sincronizar sessão desconectada:', error);
    }
};

const syncLegacyInstanciaStatus = async (status, qrCode = null) => {
    try {
        const dados = { status };
        if (qrCode !== null) dados.qr_code = qrCode;
        if (status === 'connected') dados.last_connected = new Date();
        const fields = Object.keys(dados).map(k => `${k} = ?`).join(', ');
        const values = Object.values(dados);
        values.push('admin-session');
        await db.query(`UPDATE instancias SET ${fields} WHERE session_name = ?`, values);
    } catch (e) {
        console.error('Erro syncLegacyInstanciaStatus:', e.message);
    }
};

const resetWhatsAppRuntime = async () => {
    currentQR = null;
    whatsappClient = null;
    whatsappChatbotController = null;
    whatsappState = 'disconnected';
    await syncDisconnectedSession();
};

const readChatbotFile = async () => fs.readFile(CHATBOT_FILE_PATH, 'utf8');

const validateChatbotSource = async (source) => {
    const tempFile = path.join(
        os.tmpdir(),
        `chatbot-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
    );

    await fs.writeFile(tempFile, source, 'utf8');

    try {
        await execFileAsync(process.execPath, ['--check', tempFile]);
        return null;
    } catch (error) {
        return (error.stderr || error.stdout || error.message || 'Erro de sintaxe desconhecido').trim();
    } finally {
        await fs.unlink(tempFile).catch(() => null);
    }
};

const isValidIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const buildWhatsAppNumberVariations = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) {
        return [];
    }

    const normalized = digits.startsWith('55') ? digits : `55${digits}`;
    const variations = new Set([digits, normalized]);

    if (normalized.length === 13) {
        variations.add(normalized.slice(0, 4) + normalized.slice(5));
    }

    if (normalized.length === 12) {
        variations.add(normalized.slice(0, 4) + '9' + normalized.slice(4));
    }

    return Array.from(variations).filter(Boolean);
};

const resolveWhatsAppDestination = async (...candidates) => {
    return resolveWhatsAppDestinationWith(whatsappClient, whatsappState === 'connected', ...candidates);
};

const resolveWhatsAppDestinationWith = async (clientArg, isConnected, ...candidates) => {
    if (!clientArg || !isConnected) {
        return null;
    }

    for (const candidate of candidates) {
        const rawValue = String(candidate || '').trim();
        if (!rawValue) {
            continue;
        }

        if (rawValue.endsWith('@c.us') || rawValue.endsWith('@g.us') || rawValue.endsWith('@lid')) {
            return rawValue;
        }

        for (const number of buildWhatsAppNumberVariations(rawValue)) {
            try {
                const numberId = await clientArg.getNumberId(number);
                if (numberId?._serialized) {
                    return numberId._serialized;
                }
            } catch (error) {
                console.log(`Nao foi possivel resolver o destino ${number} no WhatsApp:`, error.message || error);
            }
        }
    }

    return null;
};

const listEscalaUsers = async (req = null) => {
    // Filtro por unidades (admin = null = todos)
    const ids = req?.session?.unidadeIds;
    let extraSql = '';
    const extraParams = [];
    if (Array.isArray(ids)) {
        if (ids.length === 0) {
            extraSql = ' AND a.id = ?';
            extraParams.push(req.session.userId);
        } else {
            const ph = ids.map(() => '?').join(',');
            extraSql = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
            extraParams.push(...ids);
        }
    }

    const [users] = await db.query(`
        SELECT
            a.id,
            a.username,
            COALESCE(NULLIF(a.nome_completo, ''), a.username) AS nome_exibicao,
            a.telefone,
            a.nivel_acesso
        FROM admins a
        WHERE a.ativo = TRUE
          AND a.telefone IS NOT NULL
          AND a.telefone <> ''
          ${extraSql}
        ORDER BY nome_exibicao ASC
    `, extraParams);

    return users;
};

const listEscalas = async (req = null) => {
    const ids = req?.session?.unidadeIds;
    let extraSql = '';
    const extraParams = [];
    if (Array.isArray(ids)) {
        if (ids.length === 0) {
            extraSql = ' AND a.id = ?';
            extraParams.push(req.session.userId);
        } else {
            const ph = ids.map(() => '?').join(',');
            extraSql = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
            extraParams.push(...ids);
        }
    }

    const [rows] = await db.query(`
        SELECT
            e.id,
            DATE_FORMAT(e.data_escala, '%Y-%m-%d') AS data_escala,
            e.admin_id,
            a.username,
            COALESCE(NULLIF(a.nome_completo, ''), a.username) AS tecnico_nome,
            a.telefone,
            a.nivel_acesso,
            e.created_at,
            e.updated_at
        FROM escalas e
        INNER JOIN admins a ON a.id = e.admin_id
        WHERE 1=1 ${extraSql}
        ORDER BY e.data_escala DESC, tecnico_nome ASC
    `, extraParams);

    return rows;
};

const buildEscalaStats = (escalas) => {
    const hoje = dayjs().format('YYYY-MM-DD');

    return {
        total: escalas.length,
        hoje: escalas.filter((item) => item.data_escala === hoje).length,
        futuras: escalas.filter((item) => item.data_escala >= hoje).length,
        tecnicos: new Set(escalas.map((item) => item.admin_id)).size
    };
};

const buildSlug = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);

const listChatbotFlows = async () => {
    const [rows] = await db.query(`
        SELECT
            f.id,
            f.name,
            f.slug,
            f.description,
            f.is_default,
            f.is_active,
            f.source_file,
            f.created_at,
            f.updated_at,
            COUNT(s.id) AS total_steps
        FROM chatbot_flows f
        LEFT JOIN chatbot_flow_steps s ON s.flow_id = f.id
        GROUP BY f.id, f.name, f.slug, f.description, f.is_default, f.is_active, f.source_file, f.created_at, f.updated_at
        ORDER BY f.is_default DESC, f.updated_at DESC, f.name ASC
    `);

    return rows;
};

const getChatbotFlowById = async (flowId) => {
    const [flows] = await db.query(
        `SELECT id, name, slug, description, is_default, is_active, source_file, created_at, updated_at
         FROM chatbot_flows
         WHERE id = ?`,
        [flowId]
    );

    if (flows.length === 0) {
        return null;
    }

    const [steps] = await db.query(
        `SELECT
            id,
            flow_id,
            step_key,
            title,
            prompt_text,
            field_key,
            validation_type,
            next_step,
            error_message,
            conditions_text,
            action_summary,
            sort_order,
            is_terminal,
            created_at,
            updated_at
         FROM chatbot_flow_steps
         WHERE flow_id = ?
         ORDER BY sort_order ASC, step_key ASC`,
        [flowId]
    );

    return {
        flow: flows[0],
        steps
    };
};

const buildFluxoStats = (flows, selectedFlowData) => ({
    totalFlows: flows.length,
    ativos: flows.filter((flow) => flow.is_active).length,
    padroes: flows.filter((flow) => flow.is_default).length,
    etapas: selectedFlowData?.steps?.length || 0
});

// ─── Helpers para filtrar por unidades do usuário ──────────────────
// Retorna { sql, params } para usar como cláusula adicional em queries
// Exemplo: WHERE 1=1 ${unidadeWhere.sql}  → adiciona AND ...
function buildUnidadeWhere(req, alias = '', columnName = 'unidade_id') {
    const ids = req?.session?.unidadeIds;
    // null = administrador, vê tudo
    if (!Array.isArray(ids)) {
        return { sql: '', params: [] };
    }
    const col = alias ? `${alias}.${columnName}` : columnName;
    if (ids.length === 0) {
        // Sem unidade vinculada: ver só registros sem unidade (legado)
        return { sql: ` AND ${col} IS NULL`, params: [] };
    }
    const placeholders = ids.map(() => '?').join(',');
    return {
        sql: ` AND (${col} IS NULL OR ${col} IN (${placeholders}))`,
        params: [...ids]
    };
}

// Filtrar admins por unidade (via admin_unidades). Admin sempre vê todos.
// Retorna { sql, params } para colocar no WHERE da query de admins.
function buildAdminUnidadeWhere(req, adminAlias = 'a') {
    const ids = req?.session?.unidadeIds;
    if (!Array.isArray(ids)) {
        return { sql: '', params: [] };
    }
    if (ids.length === 0) {
        // Sem unidade vinculada: ver só si mesmo
        return { sql: ` AND ${adminAlias}.id = ?`, params: [req.session.userId] };
    }
    const placeholders = ids.map(() => '?').join(',');
    return {
        sql: ` AND ${adminAlias}.id IN (
            SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${placeholders})
        )`,
        params: [...ids]
    };
}

// Retorna o cliente WhatsApp adequado para enviar mensagem a partir de um chamado
async function obterClienteWhatsAppParaChamado(chamado) {
    if (chamado.instancia_id) {
        const [insts] = await db.query(
            'SELECT is_legacy, nome, session_name FROM instancias WHERE id = ? LIMIT 1',
            [chamado.instancia_id]
        );
        if (insts.length > 0 && !insts[0].is_legacy) {
            const cli = instanceManager.obterCliente(chamado.instancia_id);
            if (!cli) {
                console.warn(`[obterCliente] Instância "${insts[0].nome}" (id=${chamado.instancia_id}) não está no pool em memória. Tentando reconectar...`);
                // Tentar reconectar agora
                try {
                    await instanceManager.iniciarInstancia(chamado.instancia_id);
                    // Aguardar até 8 segundos para conectar
                    for (let i = 0; i < 16; i++) {
                        await new Promise(r => setTimeout(r, 500));
                        const cli2 = instanceManager.obterCliente(chamado.instancia_id);
                        if (cli2) return { client: cli2, isConnected: true };
                    }
                } catch (e) {
                    console.error('[obterCliente] Erro ao tentar reconectar:', e.message);
                }
                return { client: null, isConnected: false };
            }
            return { client: cli, isConnected: true };
        }
    }
    // Default: legacy (HGP)
    return {
        client: whatsappClient,
        isConnected: whatsappClient && whatsappState === 'connected'
    };
}

const listChamadosOverview = async (req = null) => {
    // Filtrar por unidades do usuário (administrador vê tudo)
    let where = '';
    const params = [];
    if (req && req.session && Array.isArray(req.session.unidadeIds)) {
        // null/undefined = administrador, vê tudo
        if (req.session.unidadeIds.length === 0) {
            // Usuário sem unidade vinculada e não-admin: vê só chamados sem unidade (legado)
            where = 'WHERE unidade_id IS NULL';
        } else {
            const placeholders = req.session.unidadeIds.map(() => '?').join(',');
            where = `WHERE unidade_id IS NULL OR unidade_id IN (${placeholders})`;
            params.push(...req.session.unidadeIds);
        }
    }

    const [chamados] = await db.query(`
        SELECT *
        FROM chamados
        ${where}
        ORDER BY criado_em DESC
        LIMIT 200
    `, params);

    const contagem = chamados.reduce((acc, chamado) => {
        const status = chamado.status || 'pendente';
        acc.total += 1;
        acc[status] = (acc[status] || 0) + 1;
        return acc;
    }, { total: 0, aberto: 0, pendente: 0, em_atendimento: 0, finalizado: 0 });

    return { chamados, contagem };
};

// Middleware de autenticação
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        return next();
    }

    if (isApiRequest(req)) {
        return res.status(401).json({ success: false, message: 'Sessão expirada' });
    }

    res.redirect('/');
};

// Middleware de verificação de nível de acesso
const isAdmin = (req, res, next) => {
    if (req.session.nivelAcesso === 'administrador' || req.session.nivelAcesso === 'gerenciador') {
        return next();
    }

    if (isApiRequest(req)) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Apenas administradores e gerenciadores.' });
    }

    res.redirect('/chamados');
};

// Middleware para funcionalidades exclusivas do administrador (fluxo bot, configurações)
const isAdminOnly = (req, res, next) => {
    if (req.session.nivelAcesso === 'administrador') {
        return next();
    }

    if (isApiRequest(req)) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Apenas administradores.' });
    }

    res.redirect('/chamados');
};

// Rotas
app.get('/', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        // Aceitar login por username OU CPF
        const cpfLimpo = String(username || '').replace(/\D/g, '');
        const [users] = await db.query(
            `SELECT * FROM admins 
             WHERE ativo = TRUE 
               AND (username = ? OR REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') = ?)
             LIMIT 1`,
            [username, cpfLimpo]
        );
        
        if (users.length === 0) {
            return res.render('login', { error: 'Usuário ou senha inválidos' });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.render('login', { error: 'Usuário ou senha inválidos' });
        }
        
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.nivelAcesso = user.nivel_acesso;
        req.session.nomeCompleto = user.nome_completo;

        // Carregar unidades vinculadas (admin sempre vê todas)
        if (user.nivel_acesso === 'administrador') {
            req.session.unidadeIds = null; // null = todas
        } else {
            const [unids] = await db.query(
                'SELECT unidade_id FROM admin_unidades WHERE admin_id = ?',
                [user.id]
            );
            req.session.unidadeIds = unids.map(u => u.unidade_id);
        }
        
        // Redirecionar baseado no nível de acesso
        if (user.nivel_acesso === 'gestor' || user.nivel_acesso === 'visualizador') {
            res.redirect('/chamados');
        } else {
            res.redirect('/dashboard');
        }
    } catch (error) {
        console.error('Erro no login:', error);
        res.render('login', { error: 'Erro ao fazer login' });
    }
});

app.get('/dashboard', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const ids = req.session.unidadeIds;
        const isAdminFull = !Array.isArray(ids); // null = administrador

        let session = null;
        let qrCode = null;
        let isLegacy = true;

        if (isAdminFull) {
            // Administrador: mostra a instância legada (HGP) como antes
            const [sessions] = await db.query('SELECT * FROM whatsapp_sessions ORDER BY id DESC LIMIT 1');
            session = sessions[0]
                ? { ...sessions[0], is_connected: whatsappState === 'connected' }
                : null;
            qrCode = currentQR;
        } else if (ids.length > 0) {
            // Buscar instância(s) das unidades do usuário
            const ph = ids.map(() => '?').join(',');
            const [insts] = await db.query(
                `SELECT i.*, u.nome AS unidade_nome
                 FROM instancias i
                 LEFT JOIN unidades u ON u.id = i.unidade_id
                 WHERE i.unidade_id IN (${ph}) AND i.ativo = TRUE
                 ORDER BY i.is_legacy DESC, i.atualizado_em DESC
                 LIMIT 1`,
                ids
            );
            if (insts.length > 0) {
                const inst = insts[0];
                isLegacy = !!inst.is_legacy;

                // Sincronizar status real da legada com o whatsappState antes de exibir
                if (isLegacy) {
                    inst.status = whatsappState || 'disconnected';
                }

                session = {
                    session_name: inst.session_name,
                    is_connected: inst.status === 'connected',
                    last_connected: inst.last_connected,
                    nome: inst.nome,
                    unidade_nome: inst.unidade_nome,
                    instancia_id: inst.id,
                    is_legacy: isLegacy
                };
                qrCode = isLegacy ? currentQR : inst.qr_code;
            }
        }

        res.render('dashboard', {
            username: req.session.username,
            session,
            qrCode,
            isLegacyInstance: isLegacy
        });
    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
        res.render('dashboard', { username: req.session.username, session: null, qrCode: null, isLegacyInstance: true });
    }
});

// Função reutilizável de iniciar WhatsApp legado (HGP)
async function iniciarWhatsAppLegacy() {
    if (whatsappState === 'connected') return { ok: true, alreadyConnected: true };
    if (whatsappState === 'connecting' && whatsappClient) return { ok: true, connecting: true };

    if (whatsappClient) {
        try { await whatsappClient.destroy(); } catch (e) {}
        whatsappClient = null;
    }

    whatsappState = 'connecting';
    currentQR = null;
    whatsappLastError = null;

    whatsappClient = new Client({
        authStrategy: new LocalAuth({ clientId: 'admin-session' }),
        puppeteer: buildPuppeteerConfig()
    });

    whatsappChatbotController = attachChatbot(whatsappClient, { managedByServer: true });

    whatsappClient.on('qr', async (qr) => {
        whatsappState = 'connecting';
        whatsappLastError = null;
        currentQR = await qrcode.toDataURL(qr);
        await db.query(
            'INSERT INTO whatsapp_sessions (session_name, qr_code, is_connected) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE qr_code = ?, is_connected = ?',
            ['admin-session', currentQR, false, currentQR, false]
        );
        await syncLegacyInstanciaStatus('qr_ready', currentQR);
    });

    whatsappClient.on('ready', async () => {
        console.log('WhatsApp HGP conectado!');
        whatsappState = 'connected';
        whatsappLastError = null;
        currentQR = null;
        await db.query(
            'UPDATE whatsapp_sessions SET is_connected = ?, last_connected = NOW(), qr_code = NULL WHERE session_name = ?',
            [true, 'admin-session']
        );
        await syncLegacyInstanciaStatus('connected', null);
    });

    whatsappClient.on('auth_failure', async (message) => {
        console.error('Falha de autenticação do WhatsApp:', message);
        whatsappLastError = `Falha de autenticação do WhatsApp: ${message}`;
        await resetWhatsAppRuntime();
    });

    whatsappClient.on('disconnected', async (reason) => {
        console.log('WhatsApp HGP desconectado:', reason);
        whatsappLastError = `WhatsApp desconectado: ${reason}`;
        if (whatsappClient) {
            try { await whatsappClient.destroy(); } catch (e) {}
        }
        await resetWhatsAppRuntime();
    });

    whatsappClient.on('message', async (message) => {
        try {
            const [sessions] = await db.query('SELECT id FROM whatsapp_sessions WHERE session_name = ?', ['admin-session']);
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
            console.error('Erro ao registrar mensagem do WhatsApp:', error);
        }
    });

    whatsappClient.initialize().catch(async (error) => {
        console.error('Erro ao inicializar cliente WhatsApp:', error);
        whatsappLastError = formatWhatsAppError(error);
        await resetWhatsAppRuntime();
    });

    return { ok: true, started: true };
}

app.post('/whatsapp/connect', isAuthenticated, async (req, res) => {
    try {
        if (whatsappState === 'connected') {
            return res.json({ success: true, connected: true, message: 'WhatsApp já está conectado' });
        }
        if (whatsappState === 'connecting' && whatsappClient) {
            return res.json({ success: true, connected: false, message: 'Conexão com WhatsApp em andamento' });
        }
        await iniciarWhatsAppLegacy();
        res.json({ success: true, connected: false, message: 'Conectando ao WhatsApp...' });
    } catch (error) {
        console.error('Erro ao conectar:', error);
        await resetWhatsAppRuntime();
        res.status(500).json({ success: false, message: 'Erro ao conectar' });
    }
});

app.get('/whatsapp/status', isAuthenticated, async (req, res) => {
    try {
        // Para gerenciador/gestor com unidade vinculada não-HGP: usar o status da instância da unidade
        const ids = req.session.unidadeIds;
        if (Array.isArray(ids) && ids.length > 0) {
            const ph = ids.map(() => '?').join(',');
            const [insts] = await db.query(
                `SELECT * FROM instancias WHERE unidade_id IN (${ph}) AND ativo = TRUE
                 ORDER BY is_legacy DESC, atualizado_em DESC LIMIT 1`,
                ids
            );
            if (insts.length > 0) {
                const inst = insts[0];
                if (inst.is_legacy) {
                    // Legada: usa estado em memória
                    return res.json({
                        connected: whatsappState === 'connected',
                        state: whatsappState,
                        error: whatsappLastError,
                        qrCode: whatsappState !== 'connected' ? currentQR : null,
                        session: { session_name: 'admin-session', is_connected: whatsappState === 'connected' }
                    });
                }
                // Nova instância: usa status do banco
                return res.json({
                    connected: inst.status === 'connected',
                    state: inst.status,
                    error: inst.last_error,
                    qrCode: inst.status !== 'connected' ? inst.qr_code : null,
                    session: { session_name: inst.session_name, is_connected: inst.status === 'connected', last_connected: inst.last_connected }
                });
            }
        }

        // Administrador (sem unidade definida) ou sem instância: cai no comportamento padrão (legada)
        const [sessions] = await db.query('SELECT * FROM whatsapp_sessions WHERE session_name = ?', ['admin-session']);
        res.json({
            connected: whatsappState === 'connected',
            state: whatsappState,
            error: whatsappLastError,
            qrCode: whatsappState === 'connecting' ? currentQR : null,
            session: sessions[0]
                ? {
                    ...sessions[0],
                    is_connected: whatsappState === 'connected'
                }
                : null
        });
    } catch (error) {
        res.status(500).json({ connected: false, state: 'disconnected', error: 'Erro ao consultar status do WhatsApp', qrCode: null, session: null });
    }
});

app.post('/whatsapp/disconnect', isAuthenticated, async (req, res) => {
    try {
        if (whatsappClient) {
            try {
                await whatsappClient.logout();
            } catch (error) {
                console.error('Erro ao fazer logout do WhatsApp:', error);
            }

            try {
                await whatsappClient.destroy();
            } catch (error) {
                console.error('Erro ao destruir cliente WhatsApp:', error);
            }
        }

        await resetWhatsAppRuntime();

        res.json({ success: true, message: 'WhatsApp desconectado com sucesso' });
    } catch (error) {
        console.error('Erro ao desconectar WhatsApp:', error);
        res.status(500).json({ success: false, message: 'Erro ao desconectar WhatsApp' });
    }
});

app.get('/messages', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Filtrar mensagens pelas instâncias das unidades do usuário
        const ids = req.session.unidadeIds;
        let extraSql = '';
        const extraParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                // Sem unidade: ver só mensagens da instância legada (admin-session)
                extraSql = ` AND ws.session_name = 'admin-session'`;
            } else {
                const ph = ids.map(() => '?').join(',');
                extraSql = ` AND ws.session_name IN (
                    SELECT i.session_name FROM instancias i WHERE i.unidade_id IN (${ph})
                    UNION
                    SELECT 'admin-session' WHERE EXISTS (SELECT 1 FROM instancias WHERE is_legacy = TRUE AND unidade_id IN (${ph}))
                )`;
                extraParams.push(...ids, ...ids);
            }
        }

        const [messages] = await db.query(`
            SELECT m.*, ws.session_name 
            FROM messages m
            JOIN whatsapp_sessions ws ON m.session_id = ws.id
            WHERE 1=1 ${extraSql}
            ORDER BY m.timestamp DESC
            LIMIT 100
        `, extraParams);
        res.render('messages', { username: req.session.username, messages });
    } catch (error) {
        console.error('Erro ao carregar mensagens:', error);
        res.render('messages', { username: req.session.username, messages: [] });
    }
});

// ─── TV Dashboard (sem autenticação — para exibir na TV) ───────────────────
app.get('/tv', (req, res) => {
    res.render('tv');
});

app.get('/api/tv/chamados', async (req, res) => {
    try {
        const [abertos] = await db.query(`
            SELECT
                c.id,
                c.protocolo,
                c.categoria,
                c.solicitante_nome,
                c.setor,
                c.status,
                c.atendente_nome,
                c.tecnico_nome,
                DATE_FORMAT(c.criado_em,   '%d/%m/%Y %H:%i') AS criado_fmt,
                DATE_FORMAT(c.iniciado_em, '%d/%m/%Y %H:%i') AS iniciado_fmt,
                DATE_FORMAT(c.encerrado_em,'%d/%m/%Y %H:%i') AS encerrado_fmt,
                TIMESTAMPDIFF(MINUTE, c.criado_em, NOW()) AS minutos_total
            FROM chamados c
            WHERE c.status IN ('pendente', 'aberto', 'em_atendimento')
            ORDER BY c.criado_em DESC
            LIMIT 50
        `);

        const [finalizados] = await db.query(`
            SELECT
                c.id,
                c.protocolo,
                c.categoria,
                c.solicitante_nome,
                c.setor,
                c.status,
                c.atendente_nome,
                c.tecnico_nome,
                DATE_FORMAT(c.criado_em,   '%d/%m/%Y %H:%i') AS criado_fmt,
                DATE_FORMAT(c.iniciado_em, '%d/%m/%Y %H:%i') AS iniciado_fmt,
                DATE_FORMAT(c.encerrado_em,'%d/%m/%Y %H:%i') AS encerrado_fmt,
                TIMESTAMPDIFF(MINUTE, c.criado_em, c.encerrado_em) AS minutos_total
            FROM chamados c
            WHERE c.status = 'finalizado'
              AND c.encerrado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            ORDER BY c.encerrado_em DESC
            LIMIT 50
        `);

        const [stats] = await db.query(`
            SELECT
                SUM(status IN ('pendente','aberto','em_atendimento'))                                                        AS em_aberto,
                SUM(status = 'finalizado' AND encerrado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR))                             AS finalizados_24h,
                SUM(status = 'em_atendimento')                                                                               AS em_atendimento,
                SUM(status = 'pendente')                                                                                     AS pendentes,
                ROUND(AVG(CASE WHEN status = 'finalizado' AND encerrado_em IS NOT NULL
                    THEN TIMESTAMPDIFF(MINUTE, criado_em, encerrado_em) END), 0)                                             AS media_minutos_geral,
                ROUND(AVG(CASE WHEN status = 'finalizado' AND encerrado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                    THEN TIMESTAMPDIFF(MINUTE, criado_em, encerrado_em) END), 0)                                             AS media_minutos_24h
            FROM chamados
        `);

        res.json({
            success: true,
            abertos,
            finalizados,
            stats: stats[0],
            timestamp: new Date()
        });
    } catch (error) {
        console.error('Erro TV API:', error);
        res.json({ success: false, abertos: [], finalizados: [], stats: {}, timestamp: new Date() });
    }
});

// ════════════════════════════════════════════════════════════════════
// MULTI-INSTÂNCIA — Unidades, Fluxos, Instâncias
// ════════════════════════════════════════════════════════════════════

// ─── UNIDADES ────────────────────────────────────────────────────
app.get('/unidades', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [unidades] = await db.query(`
            SELECT u.*, 
                   (SELECT COUNT(*) FROM admin_unidades au WHERE au.unidade_id = u.id) AS total_admins,
                   (SELECT COUNT(*) FROM instancias i WHERE i.unidade_id = u.id) AS total_instancias
            FROM unidades u
            ORDER BY u.nome
        `);
        res.render('unidades', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso,
            unidades
        });
    } catch (e) {
        console.error('Erro /unidades:', e);
        res.render('unidades', { username: req.session.username, nivelAcesso: req.session.nivelAcesso, unidades: [] });
    }
});

app.post('/api/unidades', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, codigo, descricao, cor } = req.body;
        if (!nome || !codigo) return res.json({ success: false, message: 'Nome e código são obrigatórios' });
        const [r] = await db.query(
            `INSERT INTO unidades (nome, codigo, descricao, cor, ativo) VALUES (?, ?, ?, ?, TRUE)`,
            [nome.trim(), codigo.trim().toUpperCase(), descricao || null, cor || '#25d366']
        );
        res.json({ success: true, id: r.insertId });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.json({ success: false, message: 'Código já existe' });
        res.json({ success: false, message: e.message });
    }
});

app.put('/api/unidades/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, codigo, descricao, cor, ativo } = req.body;
        await db.query(
            `UPDATE unidades SET nome = ?, codigo = ?, descricao = ?, cor = ?, ativo = ? WHERE id = ?`,
            [nome, codigo, descricao || null, cor || '#25d366', ativo ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.delete('/api/unidades/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        await db.query('DELETE FROM unidades WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Vincular admins a unidades
app.get('/api/unidades/:id/admins', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [vinc] = await db.query(
            `SELECT a.id, a.username, a.nome_completo, a.nivel_acesso
             FROM admins a
             JOIN admin_unidades au ON au.admin_id = a.id
             WHERE au.unidade_id = ? AND a.ativo = TRUE
             ORDER BY a.nome_completo, a.username`,
            [req.params.id]
        );
        const [todos] = await db.query(`
            SELECT id, username, nome_completo, nivel_acesso
            FROM admins
            WHERE ativo = TRUE
            ORDER BY nome_completo, username
        `);
        res.json({ success: true, vinculados: vinc, todos });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/unidades/:id/admins', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { admin_ids } = req.body; // array de ids
        const unidadeId = req.params.id;
        await db.query('DELETE FROM admin_unidades WHERE unidade_id = ?', [unidadeId]);
        if (Array.isArray(admin_ids) && admin_ids.length > 0) {
            const values = admin_ids.map(id => [Number(id), Number(unidadeId)]);
            await db.query('INSERT INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ─── FLOWS V2 ─────────────────────────────────────────────────────
app.get('/flows', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [flows] = await db.query(`
            SELECT id, nome, descricao, is_default, ativo, criado_em, atualizado_em
            FROM bot_flows_v2
            ORDER BY is_default DESC, nome
        `);
        res.render('flows', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso,
            flows
        });
    } catch (e) {
        res.render('flows', { username: req.session.username, nivelAcesso: req.session.nivelAcesso, flows: [] });
    }
});

app.get('/api/flows/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM bot_flows_v2 WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.json({ success: false, message: 'Não encontrado' });
        const flow = rows[0];
        try { flow.definicao = JSON.parse(flow.definicao_json); } catch (e) { flow.definicao = null; }
        delete flow.definicao_json;
        res.json({ success: true, flow });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/flows', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, descricao, definicao } = req.body;
        if (!nome || !definicao) return res.json({ success: false, message: 'Nome e definição são obrigatórios' });
        const json = typeof definicao === 'string' ? definicao : JSON.stringify(definicao);
        // Validar se é JSON válido
        try { JSON.parse(json); } catch (e) { return res.json({ success: false, message: 'Definição não é JSON válido' }); }
        const [r] = await db.query(
            `INSERT INTO bot_flows_v2 (nome, descricao, definicao_json, ativo) VALUES (?, ?, ?, TRUE)`,
            [nome.trim(), descricao || null, json]
        );
        res.json({ success: true, id: r.insertId });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.put('/api/flows/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, descricao, definicao, ativo } = req.body;
        const json = typeof definicao === 'string' ? definicao : JSON.stringify(definicao);
        try { JSON.parse(json); } catch (e) { return res.json({ success: false, message: 'Definição não é JSON válido' }); }
        await db.query(
            `UPDATE bot_flows_v2 SET nome = ?, descricao = ?, definicao_json = ?, ativo = ? WHERE id = ?`,
            [nome, descricao || null, json, ativo ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.delete('/api/flows/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [used] = await db.query('SELECT COUNT(*) AS c FROM instancias WHERE flow_id = ?', [req.params.id]);
        if (used[0].c > 0) return res.json({ success: false, message: 'Fluxo está vinculado a instâncias' });
        await db.query('DELETE FROM bot_flows_v2 WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ─── INSTÂNCIAS ───────────────────────────────────────────────────
app.get('/instancias', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        // Sincronizar status da instância legada com o estado real do whatsappState
        await db.query(
            `UPDATE instancias SET status = ? WHERE session_name = 'admin-session'`,
            [whatsappState || 'disconnected']
        );

        const [instancias] = await db.query(`
            SELECT i.*, u.nome AS unidade_nome, u.cor AS unidade_cor, f.nome AS flow_nome
            FROM instancias i
            LEFT JOIN unidades u ON u.id = i.unidade_id
            LEFT JOIN bot_flows_v2 f ON f.id = i.flow_id
            ORDER BY i.is_legacy DESC, i.nome
        `);
        const [unidades] = await db.query('SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE ORDER BY nome');
        const [flows] = await db.query('SELECT id, nome FROM bot_flows_v2 WHERE ativo = TRUE ORDER BY nome');
        res.render('instancias', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso,
            instancias, unidades, flows
        });
    } catch (e) {
        console.error('Erro /instancias:', e);
        res.render('instancias', { username: req.session.username, nivelAcesso: req.session.nivelAcesso, instancias: [], unidades: [], flows: [] });
    }
});

app.post('/api/instancias', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, session_name, unidade_id, flow_id } = req.body;
        if (!nome || !session_name) return res.json({ success: false, message: 'Nome e session_name são obrigatórios' });
        if (session_name === 'admin-session') return res.json({ success: false, message: 'session_name "admin-session" é reservado' });

        const sessionSafe = String(session_name).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const [r] = await db.query(
            `INSERT INTO instancias (nome, session_name, unidade_id, flow_id, status, is_legacy, ativo)
             VALUES (?, ?, ?, ?, 'disconnected', FALSE, TRUE)`,
            [nome.trim(), sessionSafe, unidade_id || null, flow_id || null]
        );
        res.json({ success: true, id: r.insertId });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.json({ success: false, message: 'session_name já existe' });
        res.json({ success: false, message: e.message });
    }
});

app.put('/api/instancias/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [chk] = await db.query('SELECT is_legacy, status FROM instancias WHERE id = ?', [req.params.id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });
        if (chk[0].is_legacy) return res.json({ success: false, message: 'Não é possível editar a instância legada' });
        if (chk[0].status === 'connected' || chk[0].status === 'connecting') {
            return res.json({ success: false, message: 'Pare a instância antes de editar' });
        }

        const { nome, unidade_id, flow_id, ativo } = req.body;
        await db.query(
            `UPDATE instancias SET nome = ?, unidade_id = ?, flow_id = ?, ativo = ? WHERE id = ?`,
            [nome, unidade_id || null, flow_id || null, ativo ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.delete('/api/instancias/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [chk] = await db.query('SELECT is_legacy FROM instancias WHERE id = ?', [req.params.id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });
        if (chk[0].is_legacy) return res.json({ success: false, message: 'Não é possível remover a instância legada' });

        await instanceManager.pararInstancia(Number(req.params.id)).catch(() => {});
        await db.query('DELETE FROM instancias WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/instancias/:id/iniciar', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [chk] = await db.query('SELECT is_legacy FROM instancias WHERE id = ?', [id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });

        if (chk[0].is_legacy) {
            // Iniciar a instância legada usando a função local
            if (whatsappState === 'connected') {
                return res.json({ success: true, message: 'HGP já está conectado' });
            }
            await iniciarWhatsAppLegacy();
            return res.json({ success: true, message: 'Conectando HGP — aguarde o QR Code' });
        }

        await instanceManager.iniciarInstancia(id);
        res.json({ success: true, message: 'Instância iniciada — aguarde o QR Code' });
    } catch (e) {
        console.error('Erro iniciar instância:', e);
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/instancias/:id/parar', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [chk] = await db.query('SELECT is_legacy FROM instancias WHERE id = ?', [id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });

        if (chk[0].is_legacy) {
            // Desconectar a instância legada
            if (whatsappClient) {
                try { await whatsappClient.logout(); } catch (e) {}
                try { await whatsappClient.destroy(); } catch (e) {}
            }
            await resetWhatsAppRuntime();
            return res.json({ success: true });
        }

        await instanceManager.pararInstancia(id);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Conectar TODAS as instâncias ativas que estão desconectadas
app.post('/api/instancias/conectar-todas', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [insts] = await db.query(
            `SELECT id, is_legacy, session_name FROM instancias 
             WHERE ativo = TRUE AND status NOT IN ('connected', 'connecting', 'qr_ready')`
        );

        let iniciadas = 0;
        for (const inst of insts) {
            try {
                if (inst.is_legacy) {
                    if (whatsappState !== 'connected' && whatsappState !== 'connecting') {
                        iniciarWhatsAppLegacy().catch(() => {});
                        iniciadas++;
                    }
                } else {
                    instanceManager.iniciarInstancia(inst.id).catch(() => {});
                    iniciadas++;
                }
            } catch (e) {}
        }
        res.json({ success: true, message: `${iniciadas} instância(s) sendo conectada(s). Aguarde alguns segundos.` });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.get('/api/instancias/:id/status', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query('SELECT id, nome, session_name, status, qr_code, last_error, last_connected, is_legacy FROM instancias WHERE id = ?', [id]);
        if (rows.length === 0) return res.json({ success: false, message: 'Não encontrada' });

        let live;
        if (rows[0].is_legacy) {
            // Status real da legacy vem da memória
            live = {
                status: whatsappState || 'disconnected',
                qr: whatsappState !== 'connected' ? currentQR : null,
                lastError: whatsappLastError
            };
            rows[0].status = live.status;
            rows[0].qr_code = live.qr;
        } else {
            live = instanceManager.obterStatus(id);
        }

        res.json({
            success: true,
            instancia: rows[0],
            runtime: live
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════
// FIM Multi-Instância
// ════════════════════════════════════════════════════════════════════


app.get('/meus-chamados', isAuthenticated, async (req, res) => {
    try {
        res.render('meus-chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador'
        });
    } catch (error) {
        console.error('Erro ao carregar meus chamados:', error);
        res.render('meus-chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador'
        });
    }
});

app.get('/chamados', isAuthenticated, async (req, res) => {
    try {
        // Garantir que nivelAcesso existe na sessão
        if (!req.session.nivelAcesso) {
            req.session.nivelAcesso = 'administrador';
        }

        const { chamados, contagem } = await listChamadosOverview(req);

        res.render('chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            chamados,
            contagem
        });
    } catch (error) {
        console.error('Erro ao carregar chamados:', error);
        res.render('chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            chamados: [],
            contagem: { total: 0, aberto: 0, pendente: 0, em_atendimento: 0, finalizado: 0 }
        });
    }
});

app.get('/api/chamados/overview', isAuthenticated, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        const overview = await listChamadosOverview(req);
        res.json({ success: true, ...overview });
    } catch (error) {
        console.error('Erro ao carregar overview de chamados:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar chamados em tempo real' });
    }
});

app.get('/api/chamados/pending-count', isAuthenticated, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        const ids = req.session.unidadeIds;
        let where = `WHERE status IN ('pendente', 'aberto')`;
        const params = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                where += ` AND unidade_id IS NULL`;
            } else {
                where += ` AND (unidade_id IS NULL OR unidade_id IN (${ids.map(() => '?').join(',')}))`;
                params.push(...ids);
            }
        }

        const [rows] = await db.query(
            `SELECT COUNT(*) AS total FROM chamados ${where}`,
            params
        );

        res.json({ success: true, total: Number(rows[0]?.total || 0) });
    } catch (error) {
        console.error('Erro ao carregar pendências de chamados:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar pendências' });
    }
});

app.get('/api/stats', isAuthenticated, async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const [messagesToday] = await db.query(
            'SELECT COUNT(*) as count FROM messages WHERE timestamp >= ?',
            [today]
        );
        
        const [activeContacts] = await db.query(
            'SELECT COUNT(DISTINCT from_number) as count FROM messages WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
        );

        // Dados das últimas 24h para o dashboard
        const [chamados24h] = await db.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) as pendentes,
                SUM(CASE WHEN status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados
            FROM chamados
            WHERE criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        `);

        const [chamadosHoje] = await db.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados
            FROM chamados
            WHERE criado_em >= ?
        `, [today]);

        // Mensagens por hora (últimas 12h) para gráfico
        const [msgsPorHora] = await db.query(`
            SELECT HOUR(timestamp) as hora, COUNT(*) as total
            FROM messages
            WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 12 HOUR)
            GROUP BY HOUR(timestamp)
            ORDER BY hora
        `);

        // Chamados por categoria (últimas 24h)
        const [chamadosPorCategoria] = await db.query(`
            SELECT categoria, COUNT(*) as total
            FROM chamados
            WHERE criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY categoria
            ORDER BY total DESC
            LIMIT 5
        `);

        // Atendentes mais ativos (últimas 24h)
        const [atendentesAtivos] = await db.query(`
            SELECT atendente_nome, COUNT(*) as total
            FROM chamados
            WHERE atendente_nome IS NOT NULL
              AND criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY atendente_nome
            ORDER BY total DESC
            LIMIT 5
        `);

        res.json({
            messagesToday: messagesToday[0].count,
            activeContacts: activeContacts[0].count,
            chamados24h: chamados24h[0],
            chamadosHoje: chamadosHoje[0],
            msgsPorHora,
            chamadosPorCategoria,
            atendentesAtivos
        });
    } catch (error) {
        res.json({ messagesToday: 0, activeContacts: 0, chamados24h: {}, chamadosHoje: {}, msgsPorHora: [], chamadosPorCategoria: [], atendentesAtivos: [] });
    }
});

app.get('/api/messages/recent', isAuthenticated, async (req, res) => {
    try {
        const [messages] = await db.query(`
            SELECT from_number, to_number, message_body, message_type, is_from_me, timestamp
            FROM messages
            ORDER BY timestamp DESC
            LIMIT 30
        `);
        res.json({ success: true, messages: messages.reverse() });
    } catch (error) {
        res.json({ success: false, messages: [] });
    }
});

app.get('/contacts', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [contacts] = await db.query(`
            SELECT * FROM contacts
            ORDER BY last_message_at DESC
        `);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const [statsToday] = await db.query(
            'SELECT COUNT(*) as count FROM contacts WHERE created_at >= ?',
            [today]
        );

        const [statsWeek] = await db.query(
            'SELECT COUNT(*) as count FROM contacts WHERE last_message_at >= ?',
            [weekAgo]
        );

        const stats = {
            total: contacts.length,
            today: statsToday[0].count,
            week: statsWeek[0].count
        };

        res.render('contacts', { 
            username: req.session.username, 
            contacts,
            stats
        });
    } catch (error) {
        console.error('Erro ao carregar contatos:', error);
        res.render('contacts', { 
            username: req.session.username, 
            contacts: [],
            stats: { total: 0, today: 0, week: 0 }
        });
    }
});

app.post('/api/contacts/sync', isAuthenticated, async (req, res) => {
    try {
        // Buscar todos os números únicos das mensagens (excluindo mensagens enviadas por nós)
        const [messages] = await db.query(`
            SELECT 
                from_number as phone_number,
                MIN(timestamp) as first_message,
                MAX(timestamp) as last_message,
                COUNT(*) as msg_count
            FROM messages
            WHERE is_from_me = FALSE
            GROUP BY from_number
        `);

        let synced = 0;

        for (const msg of messages) {
            // Tentar obter o nome do contato do WhatsApp se o cliente estiver conectado
            let contactName = null;
            
            if (whatsappClient && whatsappState === 'connected') {
                try {
                    const contact = await whatsappClient.getContactById(msg.phone_number);
                    contactName = contact.pushname || contact.name || null;
                } catch (error) {
                    // Ignorar erros ao buscar contato individual
                }
            }

            // Inserir ou atualizar contato
            const cleanNumber = msg.phone_number.replace(/@.*$/, '');
            await db.query(`
                INSERT INTO contacts (phone_number, contact_name, first_message_at, last_message_at, message_count)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    contact_name = COALESCE(VALUES(contact_name), contact_name),
                    first_message_at = LEAST(first_message_at, VALUES(first_message_at)),
                    last_message_at = GREATEST(last_message_at, VALUES(last_message_at)),
                    message_count = VALUES(message_count)
            `, [cleanNumber, contactName, msg.first_message, msg.last_message, msg.msg_count]);

            synced++;
        }

        res.json({ 
            success: true, 
            message: 'Contatos sincronizados com sucesso',
            synced
        });
    } catch (error) {
        console.error('Erro ao sincronizar contatos:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro ao sincronizar contatos' 
        });
    }
});

app.get('/escala', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [escalas, usuariosEscala] = await Promise.all([
            listEscalas(req),
            listEscalaUsers(req)
        ]);

        res.render('escala', {
            username: req.session.username,
            escalas,
            usuariosEscala,
            stats: buildEscalaStats(escalas),
            hoje: dayjs().format('YYYY-MM-DD')
        });
    } catch (error) {
        console.error('Erro ao carregar página de escala:', error);
        res.status(500).render('escala', {
            username: req.session.username,
            escalas: [],
            usuariosEscala: [],
            stats: { total: 0, hoje: 0, futuras: 0, tecnicos: 0 },
            hoje: dayjs().format('YYYY-MM-DD')
        });
    }
});

app.get('/fluxo', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const flows = await listChatbotFlows();
        const selectedFlowId = req.query.flowId ? Number(req.query.flowId) : flows[0]?.id;
        const selectedFlowData = selectedFlowId ? await getChatbotFlowById(selectedFlowId) : null;

        res.render('fluxo', {
            username: req.session.username,
            flows,
            selectedFlowData,
            stats: buildFluxoStats(flows, selectedFlowData)
        });
    } catch (error) {
        console.error('Erro ao carregar módulo de fluxo:', error);
        res.status(500).render('fluxo', {
            username: req.session.username,
            flows: [],
            selectedFlowData: null,
            stats: { totalFlows: 0, ativos: 0, padroes: 0, etapas: 0 }
        });
    }
});

app.get('/avaliacoes', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Filtrar avaliações pelos chamados da unidade do usuário
        const ids = req.session.unidadeIds;
        let extraSql = '';
        const extraParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                extraSql = ' AND c.unidade_id IS NULL';
            } else {
                const ph = ids.map(() => '?').join(',');
                extraSql = ` AND (c.unidade_id IS NULL OR c.unidade_id IN (${ph}))`;
                extraParams.push(...ids);
            }
        }

        const [avaliacoes] = await db.query(`
            SELECT a.*, c.categoria, c.setor, c.unidade_id
            FROM avaliacoes a
            LEFT JOIN chamados c ON c.id = a.chamado_id
            WHERE 1=1 ${extraSql}
            ORDER BY a.criado_em DESC
            LIMIT 100
        `, extraParams);

        const [stats] = await db.query(`
            SELECT 
                COUNT(*) as total,
                ROUND(AVG(a.nota), 1) as media,
                SUM(CASE WHEN a.nota >= 4 THEN 1 ELSE 0 END) as positivas,
                SUM(CASE WHEN a.nota <= 2 THEN 1 ELSE 0 END) as negativas
            FROM avaliacoes a
            LEFT JOIN chamados c ON c.id = a.chamado_id
            WHERE 1=1 ${extraSql}
        `, extraParams);

        res.render('avaliacoes', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            avaliacoes,
            stats: stats[0]
        });
    } catch (error) {
        console.error('Erro ao carregar avaliações:', error);
        res.render('avaliacoes', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            avaliacoes: [],
            stats: { total: 0, media: 0, positivas: 0, negativas: 0 }
        });
    }
});

// API - Responder avaliação (justificativa do técnico)
app.post('/api/avaliacoes/:id/responder', isAuthenticated, async (req, res) => {
    try {
        const avaliacaoId = req.params.id;
        const { resposta } = req.body;

        if (!resposta || resposta.trim().length < 3) {
            return res.status(400).json({ success: false, message: 'A resposta deve ter pelo menos 3 caracteres' });
        }

        const [avaliacao] = await db.query('SELECT * FROM avaliacoes WHERE id = ?', [avaliacaoId]);
        if (avaliacao.length === 0) {
            return res.status(404).json({ success: false, message: 'Avaliação não encontrada' });
        }

        await db.query(
            `UPDATE avaliacoes 
             SET resposta_tecnico = ?, respondido_por = ?, respondido_em = NOW()
             WHERE id = ?`,
            [resposta.trim(), req.session.username, avaliacaoId]
        );

        res.json({ success: true, message: 'Resposta registrada com sucesso' });
    } catch (error) {
        console.error('Erro ao responder avaliação:', error);
        res.status(500).json({ success: false, message: 'Erro ao registrar resposta' });
    }
});

app.get('/relatorios', isAuthenticated, isAdmin, async (req, res) => {
    try {
        res.render('relatorios', { username: req.session.username });
    } catch (error) {
        console.error('Erro ao carregar relatórios:', error);
        res.render('relatorios', { username: req.session.username });
    }
});

app.get('/api/relatorios/chamados', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { dataInicio, dataFim } = req.query;

        if (!dataInicio || !dataFim) {
            return res.status(400).json({ success: false, message: 'Informe dataInicio e dataFim' });
        }

        // Filtro de unidade do usuário
        const ids = req.session.unidadeIds;
        let unidWhere = '';
        const unidParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                unidWhere = ' AND unidade_id IS NULL';
            } else {
                const ph = ids.map(() => '?').join(',');
                unidWhere = ` AND (unidade_id IS NULL OR unidade_id IN (${ph}))`;
                unidParams.push(...ids);
            }
        }

        // Total por período
        const [totalPeriodo] = await db.query(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'aberto' THEN 1 ELSE 0 END) as abertos,
                   SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) as pendentes,
                   SUM(CASE WHEN status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ? ${unidWhere}
        `, [dataInicio, dataFim, ...unidParams]);

        const [porSetor] = await db.query(`
            SELECT setor, COUNT(*) as total,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN status != 'finalizado' THEN 1 ELSE 0 END) as abertos
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ? ${unidWhere}
            GROUP BY setor
            ORDER BY total DESC
        `, [dataInicio, dataFim, ...unidParams]);

        const [porCategoria] = await db.query(`
            SELECT categoria, COUNT(*) as total,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN status != 'finalizado' THEN 1 ELSE 0 END) as abertos
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ? ${unidWhere}
            GROUP BY categoria
            ORDER BY total DESC
        `, [dataInicio, dataFim, ...unidParams]);

        const [porAtendente] = await db.query(`
            SELECT COALESCE(atendente_nome, tecnico_nome, 'Sem atendente') as atendente,
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                   SUM(CASE WHEN status NOT IN ('finalizado','em_atendimento') THEN 1 ELSE 0 END) as pendentes
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ? ${unidWhere}
            GROUP BY atendente
            ORDER BY total DESC
        `, [dataInicio, dataFim, ...unidParams]);

        const [porDia] = await db.query(`
            SELECT DATE_FORMAT(criado_em, '%Y-%m-%d') as dia, COUNT(*) as total
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ? ${unidWhere}
            GROUP BY dia
            ORDER BY dia ASC
        `, [dataInicio, dataFim, ...unidParams]);

        const [porSetorCategoria] = await db.query(`
            SELECT setor, categoria, COUNT(*) as total
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ? ${unidWhere}
            GROUP BY setor, categoria
            ORDER BY setor, total DESC
        `, [dataInicio, dataFim, ...unidParams]);

        res.json({
            success: true,
            resumo: totalPeriodo[0],
            porSetor,
            porCategoria,
            porAtendente,
            porDia,
            porSetorCategoria
        });
    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
    }
});

app.get('/settings', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const chatbotCode = await readChatbotFile();
        const [settings] = await db.query('SELECT setting_key, setting_value FROM system_settings');
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });

        res.render('settings', {
            username: req.session.username,
            chatbotCode,
            chatbotFileName: 'chatbot.js',
            systemSettings: settingsMap
        });
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
        res.status(500).render('settings', {
            username: req.session.username,
            chatbotCode: '',
            chatbotFileName: 'chatbot.js',
            systemSettings: {}
        });
    }
});

app.get('/api/settings/system', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [settings] = await db.query('SELECT setting_key, setting_value FROM system_settings');
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });
        res.json({ success: true, settings: settingsMap });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao carregar configurações' });
    }
});

app.post('/api/settings/system', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ success: false, message: 'Chave obrigatória' });

        await db.query(
            'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            [key, String(value), String(value)]
        );
        res.json({ success: true, message: 'Configuração salva' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao salvar configuração' });
    }
});

app.get('/api/settings/chatbot-file', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const content = await readChatbotFile();
        res.json({ success: true, content, fileName: 'chatbot.js' });
    } catch (error) {
        console.error('Erro ao ler chatbot.js:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar chatbot.js' });
    }
});

app.post('/api/settings/chatbot-file', isAuthenticated, isAdminOnly, async (req, res) => {
    const { content } = req.body;

    if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ success: false, message: 'O conteúdo do arquivo não pode ficar vazio' });
    }

    try {
        const validationError = await validateChatbotSource(content);

        if (validationError) {
            return res.status(400).json({
                success: false,
                message: 'O arquivo não foi salvo porque há erro de sintaxe',
                details: validationError
            });
        }

        await fs.writeFile(CHATBOT_FILE_PATH, content, 'utf8');

        res.json({
            success: true,
            message: 'chatbot.js atualizado no projeto com sucesso'
        });
    } catch (error) {
        console.error('Erro ao salvar chatbot.js:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar chatbot.js' });
    }
});

app.get('/api/escala', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const escalas = await listEscalas(req);
        res.json({ success: true, escalas });
    } catch (error) {
        console.error('Erro ao listar escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar escala' });
    }
});

app.get('/api/escala/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, DATE_FORMAT(data_escala, '%Y-%m-%d') AS data_escala, admin_id
             FROM escalas
             WHERE id = ?`,
            [req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Registro de escala não encontrado' });
        }

        res.json({ success: true, escala: rows[0] });
    } catch (error) {
        console.error('Erro ao buscar registro de escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar registro de escala' });
    }
});

app.get('/api/fluxos', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const flows = await listChatbotFlows();
        res.json({ success: true, flows });
    } catch (error) {
        console.error('Erro ao listar fluxos:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar fluxos' });
    }
});

app.get('/api/fluxos/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const flowData = await getChatbotFlowById(req.params.id);

        if (!flowData) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        res.json({ success: true, ...flowData });
    } catch (error) {
        console.error('Erro ao buscar fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar fluxo' });
    }
});

app.post('/api/fluxos', isAuthenticated, isAdminOnly, async (req, res) => {
    const { name, description, is_active } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o nome do fluxo' });
    }

    try {
        const baseSlug = buildSlug(name);
        const slug = baseSlug || `fluxo-${Date.now()}`;
        const [existing] = await db.query('SELECT id FROM chatbot_flows WHERE slug = ?', [slug]);
        const finalSlug = existing.length > 0 ? `${slug}-${Date.now()}` : slug;

        const [result] = await db.query(
            `INSERT INTO chatbot_flows (name, slug, description, is_default, is_active, source_file)
             VALUES (?, ?, ?, FALSE, ?, NULL)`,
            [name.trim(), finalSlug, description || null, Boolean(is_active)]
        );

        res.json({ success: true, message: 'Fluxo criado com sucesso', id: result.insertId });
    } catch (error) {
        console.error('Erro ao criar fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar fluxo' });
    }
});

app.put('/api/fluxos/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    const { name, description, is_active } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o nome do fluxo' });
    }

    try {
        const [flows] = await db.query('SELECT id, slug FROM chatbot_flows WHERE id = ?', [req.params.id]);
        if (flows.length === 0) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        await db.query(
            `UPDATE chatbot_flows
             SET name = ?, description = ?, is_active = ?
             WHERE id = ?`,
            [name.trim(), description || null, Boolean(is_active), req.params.id]
        );

        res.json({ success: true, message: 'Fluxo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar fluxo' });
    }
});

app.delete('/api/fluxos/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [flows] = await db.query('SELECT id, is_default FROM chatbot_flows WHERE id = ?', [req.params.id]);
        if (flows.length === 0) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        if (flows[0].is_default) {
            return res.status(400).json({ success: false, message: 'O fluxo padrão não pode ser excluído' });
        }

        await db.query('DELETE FROM chatbot_flows WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Fluxo excluído com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir fluxo' });
    }
});

app.post('/api/fluxos/:id/steps', isAuthenticated, isAdminOnly, async (req, res) => {
    const {
        step_key,
        title,
        prompt_text,
        field_key,
        validation_type,
        next_step,
        error_message,
        conditions_text,
        action_summary,
        sort_order,
        is_terminal
    } = req.body;

    if (typeof step_key !== 'string' || !step_key.trim()) {
        return res.status(400).json({ success: false, message: 'Informe a chave da etapa' });
    }

    if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o título da etapa' });
    }

    try {
        const [flows] = await db.query('SELECT id FROM chatbot_flows WHERE id = ?', [req.params.id]);
        if (flows.length === 0) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        const [existing] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE flow_id = ? AND step_key = ?',
            [req.params.id, step_key.trim()]
        );

        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Já existe uma etapa com essa chave neste fluxo' });
        }

        await db.query(
            `INSERT INTO chatbot_flow_steps (
                flow_id, step_key, title, prompt_text, field_key, validation_type, next_step,
                error_message, conditions_text, action_summary, sort_order, is_terminal
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.params.id,
                step_key.trim(),
                title.trim(),
                prompt_text || null,
                field_key || null,
                validation_type || null,
                next_step || null,
                error_message || null,
                conditions_text || null,
                action_summary || null,
                Number(sort_order) || 0,
                Boolean(is_terminal)
            ]
        );

        res.json({ success: true, message: 'Etapa criada com sucesso' });
    } catch (error) {
        console.error('Erro ao criar etapa:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar etapa' });
    }
});

app.put('/api/fluxos/:flowId/steps/:stepId', isAuthenticated, isAdminOnly, async (req, res) => {
    const {
        step_key,
        title,
        prompt_text,
        field_key,
        validation_type,
        next_step,
        error_message,
        conditions_text,
        action_summary,
        sort_order,
        is_terminal
    } = req.body;

    if (typeof step_key !== 'string' || !step_key.trim()) {
        return res.status(400).json({ success: false, message: 'Informe a chave da etapa' });
    }

    if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o título da etapa' });
    }

    try {
        const [steps] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE id = ? AND flow_id = ?',
            [req.params.stepId, req.params.flowId]
        );

        if (steps.length === 0) {
            return res.status(404).json({ success: false, message: 'Etapa não encontrada' });
        }

        const [existing] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE flow_id = ? AND step_key = ? AND id <> ?',
            [req.params.flowId, step_key.trim(), req.params.stepId]
        );

        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Já existe outra etapa com essa chave neste fluxo' });
        }

        await db.query(
            `UPDATE chatbot_flow_steps
             SET step_key = ?, title = ?, prompt_text = ?, field_key = ?, validation_type = ?, next_step = ?,
                 error_message = ?, conditions_text = ?, action_summary = ?, sort_order = ?, is_terminal = ?
             WHERE id = ? AND flow_id = ?`,
            [
                step_key.trim(),
                title.trim(),
                prompt_text || null,
                field_key || null,
                validation_type || null,
                next_step || null,
                error_message || null,
                conditions_text || null,
                action_summary || null,
                Number(sort_order) || 0,
                Boolean(is_terminal),
                req.params.stepId,
                req.params.flowId
            ]
        );

        res.json({ success: true, message: 'Etapa atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar etapa:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar etapa' });
    }
});

app.delete('/api/fluxos/:flowId/steps/:stepId', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [steps] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE id = ? AND flow_id = ?',
            [req.params.stepId, req.params.flowId]
        );

        if (steps.length === 0) {
            return res.status(404).json({ success: false, message: 'Etapa não encontrada' });
        }

        await db.query('DELETE FROM chatbot_flow_steps WHERE id = ? AND flow_id = ?', [req.params.stepId, req.params.flowId]);
        res.json({ success: true, message: 'Etapa excluída com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir etapa:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir etapa' });
    }
});

app.post('/api/escala', isAuthenticated, isAdmin, async (req, res) => {
    const { data_escala, admin_id } = req.body;

    if (!isValidIsoDate(data_escala)) {
        return res.status(400).json({ success: false, message: 'Informe uma data válida no formato YYYY-MM-DD' });
    }

    if (!admin_id) {
        return res.status(400).json({ success: false, message: 'Selecione um técnico para a escala' });
    }

    try {
        const [usuarios] = await db.query(
            `SELECT id
             FROM admins
             WHERE id = ? AND ativo = TRUE AND telefone IS NOT NULL AND telefone <> ''`,
            [admin_id]
        );

        if (usuarios.length === 0) {
            return res.status(400).json({ success: false, message: 'O técnico selecionado precisa estar ativo e ter telefone cadastrado' });
        }

        const [existente] = await db.query('SELECT id FROM escalas WHERE data_escala = ?', [data_escala]);
        if (existente.length > 0) {
            return res.status(400).json({ success: false, message: 'Já existe uma escala cadastrada para esta data' });
        }

        await db.query(
            'INSERT INTO escalas (data_escala, admin_id) VALUES (?, ?)',
            [data_escala, admin_id]
        );

        res.json({ success: true, message: 'Escala cadastrada com sucesso' });
    } catch (error) {
        console.error('Erro ao cadastrar escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao cadastrar escala' });
    }
});

app.put('/api/escala/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { data_escala, admin_id } = req.body;

    if (!isValidIsoDate(data_escala)) {
        return res.status(400).json({ success: false, message: 'Informe uma data válida no formato YYYY-MM-DD' });
    }

    if (!admin_id) {
        return res.status(400).json({ success: false, message: 'Selecione um técnico para a escala' });
    }

    try {
        const [registro] = await db.query('SELECT id FROM escalas WHERE id = ?', [req.params.id]);
        if (registro.length === 0) {
            return res.status(404).json({ success: false, message: 'Registro de escala não encontrado' });
        }

        const [usuarios] = await db.query(
            `SELECT id
             FROM admins
             WHERE id = ? AND ativo = TRUE AND telefone IS NOT NULL AND telefone <> ''`,
            [admin_id]
        );

        if (usuarios.length === 0) {
            return res.status(400).json({ success: false, message: 'O técnico selecionado precisa estar ativo e ter telefone cadastrado' });
        }

        const [existente] = await db.query(
            'SELECT id FROM escalas WHERE data_escala = ? AND id <> ?',
            [data_escala, req.params.id]
        );

        if (existente.length > 0) {
            return res.status(400).json({ success: false, message: 'Já existe uma escala cadastrada para esta data' });
        }

        await db.query(
            'UPDATE escalas SET data_escala = ?, admin_id = ? WHERE id = ?',
            [data_escala, admin_id, req.params.id]
        );

        res.json({ success: true, message: 'Escala atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar escala' });
    }
});

app.delete('/api/escala/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [registro] = await db.query('SELECT id FROM escalas WHERE id = ?', [req.params.id]);
        if (registro.length === 0) {
            return res.status(404).json({ success: false, message: 'Registro de escala não encontrado' });
        }

        await db.query('DELETE FROM escalas WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Escala removida com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir escala' });
    }
});

app.get('/usuarios', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const filtro = buildAdminUnidadeWhere(req, 'a');

        const [usuarios] = await db.query(`
            SELECT a.id, a.username, a.nome_completo, a.cpf, a.telefone, a.nivel_acesso, a.ativo, a.created_at,
                   GROUP_CONCAT(u.nome ORDER BY u.nome SEPARATOR ', ') AS unidades_nomes,
                   GROUP_CONCAT(u.id) AS unidades_ids
            FROM admins a
            LEFT JOIN admin_unidades au ON au.admin_id = a.id
            LEFT JOIN unidades u ON u.id = au.unidade_id
            WHERE 1=1 ${filtro.sql}
            GROUP BY a.id
            ORDER BY a.created_at DESC
        `, filtro.params);

        // Listar só unidades às quais o usuário tem acesso (admin = todas)
        let unidades;
        if (Array.isArray(req.session.unidadeIds) && req.session.unidadeIds.length > 0) {
            const ph = req.session.unidadeIds.map(() => '?').join(',');
            [unidades] = await db.query(`SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE AND id IN (${ph}) ORDER BY nome`, req.session.unidadeIds);
        } else if (Array.isArray(req.session.unidadeIds) && req.session.unidadeIds.length === 0) {
            unidades = [];
        } else {
            [unidades] = await db.query(`SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE ORDER BY nome`);
        }

        const stats = {
            total: usuarios.length,
            administradores: usuarios.filter(u => u.nivel_acesso === 'administrador').length,
            gerenciadores: usuarios.filter(u => u.nivel_acesso === 'gerenciador').length,
            gestores: usuarios.filter(u => u.nivel_acesso === 'gestor').length,
            ativos: usuarios.filter(u => u.ativo).length
        };

        res.render('usuarios', { 
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            usuarios,
            unidades,
            stats
        });
    } catch (error) {
        console.error('Erro ao carregar usuários:', error);
        res.render('usuarios', { 
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            usuarios: [],
            unidades: [],
            stats: { total: 0, administradores: 0, gerenciadores: 0, gestores: 0, ativos: 0 }
        });
    }
});

// API - Listar gestores disponíveis para encaminhar (apenas quem está no turno ATUAL)
app.get('/api/usuarios/gestores', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Sem permissão.' });
        }

        const agora = new Date();
        const diaSemana = agora.getDay();
        const horaAtual = agora.toTimeString().slice(0, 5);

        // Filtro por unidade
        const ids = req.session.unidadeIds;
        let unidWhere = '';
        const unidParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                unidWhere = ' AND a.id = ?';
                unidParams.push(req.session.userId);
            } else {
                const ph = ids.map(() => '?').join(',');
                unidWhere = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
                unidParams.push(...ids);
            }
        }

        const [gestores] = await db.query(`
            SELECT DISTINCT a.id, a.username, a.nome_completo, a.telefone
            FROM admins a
            INNER JOIN user_turnos t ON t.admin_id = a.id
            WHERE a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
              AND a.ativo = TRUE
              AND a.id != ?
              AND t.ativo = TRUE
              AND t.dia_semana = ?
              AND t.hora_inicio <= ?
              AND t.hora_fim >= ?
              ${unidWhere}
            ORDER BY a.nome_completo
        `, [req.session.userId, diaSemana, horaAtual, horaAtual, ...unidParams]);

        res.json({ success: true, gestores });
    } catch (error) {
        console.error('Erro ao buscar gestores:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar gestores' });
    }
});

// API - Listar atendentes disponíveis para transferência (quem NÃO está no turno atual, mas tem turno configurado)
app.get('/api/usuarios/atendentes', isAuthenticated, async (req, res) => {
    try {
        const agora = new Date();
        const diaSemana = agora.getDay();
        const horaAtual = agora.toTimeString().slice(0, 5);

        // Filtro por unidade
        const ids = req.session.unidadeIds;
        let unidWhere = '';
        const unidParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                unidWhere = ' AND a.id = ?';
                unidParams.push(req.session.userId);
            } else {
                const ph = ids.map(() => '?').join(',');
                unidWhere = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
                unidParams.push(...ids);
            }
        }

        const [atendentes] = await db.query(`
            SELECT DISTINCT a.id, a.username, a.nome_completo, a.telefone, a.nivel_acesso
            FROM admins a
            INNER JOIN user_turnos t ON t.admin_id = a.id AND t.ativo = TRUE
            WHERE a.ativo = TRUE
              AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
              AND a.id != ?
              AND a.id NOT IN (
                  SELECT t2.admin_id FROM user_turnos t2
                  WHERE t2.ativo = TRUE
                    AND t2.dia_semana = ?
                    AND t2.hora_inicio <= ?
                    AND t2.hora_fim >= ?
              )
              ${unidWhere}
            ORDER BY a.nome_completo
        `, [req.session.userId, diaSemana, horaAtual, horaAtual, ...unidParams]);

        // Buscar os turnos de cada atendente para mostrar horários disponíveis
        for (const atendente of atendentes) {
            const [turnos] = await db.query(`
                SELECT dia_semana, hora_inicio, hora_fim
                FROM user_turnos
                WHERE admin_id = ? AND ativo = TRUE
                ORDER BY dia_semana, hora_inicio
            `, [atendente.id]);
            atendente.turnos = turnos;
        }

        res.json({ success: true, atendentes });
    } catch (error) {
        console.error('Erro ao buscar atendentes:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar atendentes' });
    }
});

// API - Listar usuário específico
app.get('/api/usuarios/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [usuarios] = await db.query(
            'SELECT id, username, nome_completo, cpf, telefone, nivel_acesso, ativo FROM admins WHERE id = ?',
            [req.params.id]
        );

        if (usuarios.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        const [unids] = await db.query('SELECT unidade_id FROM admin_unidades WHERE admin_id = ?', [req.params.id]);
        usuarios[0].unidade_ids = unids.map(u => u.unidade_id);

        res.json({ success: true, usuario: usuarios[0] });
    } catch (error) {
        console.error('Erro ao buscar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar usuário' });
    }
});

// API - Criar usuário
app.post('/api/usuarios', isAuthenticated, isAdmin, async (req, res) => {
    const { nome_completo, username, cpf, telefone, nivel_acesso, password, ativo, unidade_ids } = req.body;

    // Gerenciador não pode criar administrador
    if (req.session.nivelAcesso === 'gerenciador' && nivel_acesso === 'administrador') {
        return res.status(403).json({ success: false, message: 'Você não tem permissão para criar administradores.' });
    }

    // Gerenciador só pode atribuir unidades que ele mesmo tem
    if (req.session.nivelAcesso !== 'administrador' && Array.isArray(unidade_ids)) {
        const minhasUnidades = new Set((req.session.unidadeIds || []).map(Number));
        const invalidas = unidade_ids.map(Number).filter(uid => !minhasUnidades.has(uid));
        if (invalidas.length > 0) {
            return res.status(403).json({ success: false, message: 'Você só pode atribuir unidades às quais está vinculado.' });
        }
    }

    try {
        // Verificar se o usuário já existe
        const [existing] = await db.query('SELECT id FROM admins WHERE username = ? OR cpf = ?', [username, cpf]);
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Usuário ou CPF já cadastrado' });
        }

        // Criptografar senha
        const hashedPassword = await bcrypt.hash(password, 10);

        const [result] = await db.query(
            `INSERT INTO admins (username, nome_completo, cpf, telefone, nivel_acesso, password, ativo)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [username, String(nome_completo || '').toUpperCase(), cpf, telefone, nivel_acesso, hashedPassword, ativo]
        );

        // Vincular unidades
        if (Array.isArray(unidade_ids) && unidade_ids.length > 0) {
            const values = unidade_ids.map(uid => [result.insertId, Number(uid)]);
            await db.query('INSERT INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
        }

        res.json({ success: true, message: 'Usuário criado com sucesso' });
    } catch (error) {
        console.error('Erro ao criar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar usuário' });
    }
});

// API - Atualizar usuário
app.put('/api/usuarios/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { nome_completo, username, cpf, telefone, nivel_acesso, password, ativo, unidade_ids } = req.body;
    const userId = req.params.id;

    // Gerenciador não pode promover a administrador
    if (req.session.nivelAcesso === 'gerenciador' && nivel_acesso === 'administrador') {
        return res.status(403).json({ success: false, message: 'Você não tem permissão para definir nível administrador.' });
    }

    // Gerenciador só pode atribuir unidades que ele mesmo tem
    if (req.session.nivelAcesso !== 'administrador' && Array.isArray(unidade_ids)) {
        const minhasUnidades = new Set((req.session.unidadeIds || []).map(Number));
        const invalidas = unidade_ids.map(Number).filter(uid => !minhasUnidades.has(uid));
        if (invalidas.length > 0) {
            return res.status(403).json({ success: false, message: 'Você só pode atribuir unidades às quais está vinculado.' });
        }
    }

    try {
        // Verificar se outro usuário já usa o username ou CPF
        const [existing] = await db.query(
            'SELECT id FROM admins WHERE (username = ? OR cpf = ?) AND id != ?',
            [username, cpf, userId]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Usuário ou CPF já cadastrado por outro usuário' });
        }

        // Se a senha foi fornecida, atualizar com ela
        const nomeUpper = String(nome_completo || '').toUpperCase();
        if (password && password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(password, 10);
            await db.query(
                `UPDATE admins 
                 SET username = ?, nome_completo = ?, cpf = ?, telefone = ?, nivel_acesso = ?, password = ?, ativo = ?
                 WHERE id = ?`,
                [username, nomeUpper, cpf, telefone, nivel_acesso, hashedPassword, ativo, userId]
            );
        } else {
            // Atualizar sem modificar a senha
            await db.query(
                `UPDATE admins 
                 SET username = ?, nome_completo = ?, cpf = ?, telefone = ?, nivel_acesso = ?, ativo = ?
                 WHERE id = ?`,
                [username, nomeUpper, cpf, telefone, nivel_acesso, ativo, userId]
            );
        }

        // Sincronizar unidades vinculadas
        if (Array.isArray(unidade_ids)) {
            if (req.session.nivelAcesso === 'administrador') {
                // Admin pode resetar tudo livremente
                await db.query('DELETE FROM admin_unidades WHERE admin_id = ?', [userId]);
                if (unidade_ids.length > 0) {
                    const values = unidade_ids.map(uid => [Number(userId), Number(uid)]);
                    await db.query('INSERT INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
                }
            } else {
                // Gerenciador: só mexe nas unidades que ele tem
                const minhas = (req.session.unidadeIds || []).map(Number);
                if (minhas.length > 0) {
                    const ph = minhas.map(() => '?').join(',');
                    await db.query(
                        `DELETE FROM admin_unidades WHERE admin_id = ? AND unidade_id IN (${ph})`,
                        [userId, ...minhas]
                    );
                }
                if (unidade_ids.length > 0) {
                    const values = unidade_ids.map(uid => [Number(userId), Number(uid)]);
                    await db.query('INSERT IGNORE INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
                }
            }
        }

        res.json({ success: true, message: 'Usuário atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar usuário' });
    }
});

app.post('/api/usuarios/:id/reset-password', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const [usuarios] = await db.query('SELECT id, username FROM admins WHERE id = ?', [userId]);

        if (usuarios.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        const senhaTemporaria = `${Math.random().toString(36).slice(-8)}A1`;
        const hashedPassword = await bcrypt.hash(senhaTemporaria, 10);

        await db.query('UPDATE admins SET password = ? WHERE id = ?', [hashedPassword, userId]);

        res.json({
            success: true,
            message: `Senha redefinida para ${usuarios[0].username}`,
            temporaryPassword: senhaTemporaria
        });
    } catch (error) {
        console.error('Erro ao resetar senha do usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao resetar senha do usuário' });
    }
});

// API - Toggle status do usuário
app.patch('/api/usuarios/:id/toggle', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [usuario] = await db.query('SELECT ativo FROM admins WHERE id = ?', [req.params.id]);
        
        if (usuario.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        const novoStatus = !usuario[0].ativo;
        await db.query('UPDATE admins SET ativo = ? WHERE id = ?', [novoStatus, req.params.id]);

        res.json({ 
            success: true, 
            message: `Usuário ${novoStatus ? 'ativado' : 'desativado'} com sucesso` 
        });
    } catch (error) {
        console.error('Erro ao alterar status:', error);
        res.status(500).json({ success: false, message: 'Erro ao alterar status do usuário' });
    }
});

// API - Turnos de trabalho
app.get('/api/usuarios/:id/turnos', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [turnos] = await db.query(
            'SELECT * FROM user_turnos WHERE admin_id = ? ORDER BY dia_semana',
            [req.params.id]
        );
        res.json({ success: true, turnos });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao buscar turnos' });
    }
});

app.post('/api/usuarios/:id/turnos', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const adminId = req.params.id;
        const { turnos } = req.body; // array de { dia_semana, hora_inicio, hora_fim, ativo }

        if (!Array.isArray(turnos)) {
            return res.status(400).json({ success: false, message: 'Formato inválido' });
        }

        // Remover turnos antigos e inserir novos
        await db.query('DELETE FROM user_turnos WHERE admin_id = ?', [adminId]);

        for (const turno of turnos) {
            if (turno.ativo) {
                await db.query(
                    'INSERT INTO user_turnos (admin_id, dia_semana, hora_inicio, hora_fim, ativo) VALUES (?, ?, ?, ?, TRUE)',
                    [adminId, turno.dia_semana, turno.hora_inicio || '07:00', turno.hora_fim || '19:00']
                );
            }
        }

        res.json({ success: true, message: 'Turnos salvos com sucesso' });
    } catch (error) {
        console.error('Erro ao salvar turnos:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar turnos' });
    }
});

// Página de turnos
app.get('/turnos', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const filtro = buildAdminUnidadeWhere(req, 'a');

        const [usuarios] = await db.query(`
            SELECT a.id, a.username, a.nome_completo, a.telefone, a.nivel_acesso, a.ativo
            FROM admins a
            WHERE a.ativo = TRUE AND a.telefone IS NOT NULL AND a.telefone <> '' AND a.nivel_acesso = 'gestor'
              ${filtro.sql}
            ORDER BY a.nome_completo
        `, filtro.params);

        const filtroTurnos = buildAdminUnidadeWhere(req, 'a');
        const [todosTurnos] = await db.query(`
            SELECT t.*, COALESCE(NULLIF(a.nome_completo,''), a.username) as nome_usuario
            FROM user_turnos t
            JOIN admins a ON a.id = t.admin_id
            WHERE t.ativo = TRUE ${filtroTurnos.sql}
            ORDER BY t.admin_id, t.dia_semana
        `, filtroTurnos.params);

        // Agrupar turnos por usuário
        const turnosPorUsuario = {};
        todosTurnos.forEach(t => {
            if (!turnosPorUsuario[t.admin_id]) turnosPorUsuario[t.admin_id] = [];
            turnosPorUsuario[t.admin_id].push(t);
        });

        res.render('turnos', {
            username: req.session.username,
            usuarios,
            turnosPorUsuario
        });
    } catch (error) {
        console.error('Erro ao carregar turnos:', error);
        res.render('turnos', { username: req.session.username, usuarios: [], turnosPorUsuario: {} });
    }
});

// API - Excluir usuário
app.delete('/api/usuarios/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [usuario] = await db.query('SELECT username FROM admins WHERE id = ?', [req.params.id]);
        
        if (usuario.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        // Não permitir excluir o admin padrão
        if (usuario[0].username === 'admin') {
            return res.status(403).json({ success: false, message: 'Não é possível excluir o usuário admin padrão' });
        }

        await db.query('DELETE FROM admins WHERE id = ?', [req.params.id]);

        res.json({ success: true, message: 'Usuário excluído com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir usuário' });
    }
});

// API - Encaminhar chamado para técnico no mesmo turno (DEVE VIR ANTES DE :id/atender)
app.post('/api/chamados/:id/encaminhar', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Sem permissão para encaminhar chamados.' });
        }

        const chamadoId = req.params.id;
        const { gestorId } = req.body;

        // Buscar dados do técnico destino
        const [gestor] = await db.query(
            'SELECT id, nome_completo, telefone FROM admins WHERE id = ? AND nivel_acesso IN ("administrador", "gerenciador", "gestor") AND ativo = TRUE',
            [gestorId]
        );

        if (gestor.length === 0) {
            return res.status(404).json({ success: false, message: 'Gestor não encontrado' });
        }

        // Buscar dados do chamado
        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);

        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        // Atualizar chamado
        await db.query(
            `UPDATE chamados 
             SET status = 'em_atendimento',
                 atendente_id = ?,
                 atendente_nome = ?,
                 iniciado_em = NOW()
             WHERE id = ?`,
            [gestor[0].id, gestor[0].nome_completo, chamadoId]
        );

        // Enviar WhatsApp para o gestor (usar cliente da instância do chamado)
        const wppGes = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppGes.isConnected && wppGes.client && gestor[0].telefone) {
            try {
                const mensagemGestor = `🔔 *NOVO CHAMADO ATRIBUÍDO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *Solicitante:* ${chamado[0].solicitante_nome}\n` +
                    `🏢 *Setor:* ${chamado[0].setor}\n` +
                    `📂 *Categoria:* ${chamado[0].categoria}\n` +
                    `📝 *Descrição:* ${chamado[0].descricao}\n` +
                    `📱 *Contato:* ${chamado[0].telefone_contato}\n\n` +
                    `Este chamado foi encaminhado para você. Por favor, entre em contato com o solicitante.`;

                // Normalizar número do gestor
                let numeroGestor = gestor[0].telefone.replace(/\D/g, '');
                if (!numeroGestor.startsWith('55')) {
                    numeroGestor = '55' + numeroGestor;
                }

                console.log('Tentando enviar para gestor:', numeroGestor);

                // Gerar variações do número (com e sem 9º dígito)
                const variacoes = [numeroGestor];
                if (numeroGestor.length === 13) {
                    variacoes.push(numeroGestor.slice(0, 4) + numeroGestor.slice(5));
                }
                if (numeroGestor.length === 12) {
                    variacoes.push(numeroGestor.slice(0, 4) + '9' + numeroGestor.slice(4));
                }

                let enviado = false;
                for (const numero of variacoes) {
                    try {
                        const numberId = await wppGes.client.getNumberId(numero);
                        if (numberId && numberId._serialized) {
                            console.log('ID do gestor encontrado:', numberId._serialized);
                            await wppGes.client.sendMessage(numberId._serialized, mensagemGestor);
                            console.log('Mensagem enviada com sucesso para o gestor');
                            enviado = true;
                            break;
                        }
                    } catch (err) {
                        console.log(`Tentativa com ${numero} falhou, tentando próxima variação...`);
                    }
                }

                if (!enviado) {
                    console.error('Número do gestor não encontrado no WhatsApp após todas as tentativas');
                }
            } catch (error) {
                console.error('Erro ao enviar WhatsApp para gestor:', error.message);
            }
        }

        // Enviar WhatsApp para o solicitante
        const wppEnc = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppEnc.isConnected && wppEnc.client && chamado[0].chat_origem) {
            try {
                const mensagemSolicitante = `🔔 *ATUALIZAÇÃO DO CHAMADO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *Atendente:* ${gestor[0].nome_completo}\n` +
                    `📊 *Status:* Em Atendimento\n\n` +
                    `Seu chamado foi encaminhado e está sendo atendido.`;

                await wppEnc.client.sendMessage(chamado[0].chat_origem, mensagemSolicitante);
            } catch (error) {
                console.error('Erro ao enviar WhatsApp para solicitante:', error);
            }
        }

        res.json({ 
            success: true, 
            message: `Chamado encaminhado para ${gestor[0].nome_completo} com sucesso` 
        });
    } catch (error) {
        console.error('Erro ao encaminhar chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao encaminhar chamado' });
    }
});

// API - Transferir chamado para outro atendente (com observação obrigatória)
app.post('/api/chamados/:id/transferir', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Sem permissão para transferir chamados.' });
        }

        const chamadoId = req.params.id;
        const { novoAtendenteId, observacao } = req.body;

        if (!novoAtendenteId) {
            return res.status(400).json({ success: false, message: 'Selecione o atendente destino' });
        }

        if (!observacao || observacao.trim().length < 5) {
            return res.status(400).json({ success: false, message: 'A observação é obrigatória (mínimo 5 caracteres). Informe o status do caso e motivo da transferência.' });
        }

        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);
        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        const [novoAtendente] = await db.query(
            'SELECT id, nome_completo, username, telefone FROM admins WHERE id = ? AND ativo = TRUE',
            [novoAtendenteId]
        );
        if (novoAtendente.length === 0) {
            return res.status(404).json({ success: false, message: 'Atendente destino não encontrado' });
        }

        const nomeAnterior = req.session.nomeCompleto || req.session.username;
        const nomeNovo = novoAtendente[0].nome_completo || novoAtendente[0].username;

        // Atualizar chamado
        await db.query(
            `UPDATE chamados 
             SET atendente_id = ?,
                 atendente_nome = ?,
                 observacoes = CONCAT(COALESCE(observacoes, ''), ?)
             WHERE id = ?`,
            [novoAtendente[0].id, nomeNovo, `\n[Transferido de ${nomeAnterior} para ${nomeNovo} em ${new Date().toLocaleString('pt-BR')}]\nMotivo: ${observacao.trim()}\n`, chamadoId]
        );

        // Registrar no chat do chamado
        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem)
             VALUES (?, 'sistema', 'Sistema', ?)`,
            [chamadoId, `📤 Chamado transferido de ${nomeAnterior} para ${nomeNovo}.\nMotivo: ${observacao.trim()}`]
        );

        // Notificar novo atendente via WhatsApp (usar cliente correto da instância do chamado)
        const wppTr = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppTr.isConnected && wppTr.client && novoAtendente[0].telefone) {
            try {
                const destino = await resolveWhatsAppDestinationWith(wppTr.client, wppTr.isConnected, novoAtendente[0].telefone);
                if (destino) {
                    await wppTr.client.sendMessage(destino,
                        `📤 *CHAMADO TRANSFERIDO PARA VOCÊ*\n\n` +
                        `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                        `👤 *Solicitante:* ${chamado[0].solicitante_nome}\n` +
                        `🏢 *Setor:* ${chamado[0].setor}\n` +
                        `📂 *Categoria:* ${chamado[0].categoria}\n` +
                        `📝 *Obs:* ${observacao.trim()}\n\n` +
                        `Transferido por: ${nomeAnterior}\n` +
                        `🔗 https://hgpto.shop/chamados`
                    );
                }
            } catch (error) {
                console.error('Erro ao notificar novo atendente:', error.message);
            }
        }

        res.json({ success: true, message: `Chamado transferido para ${nomeNovo}` });
    } catch (error) {
        console.error('Erro ao transferir chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao transferir chamado' });
    }
});

// API - Iniciar atendimento de chamado
app.post('/api/chamados/:id/atender', isAuthenticated, async (req, res) => {
    try {
        // Bloquear usuários com nível "visualizador"
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Seu perfil não tem permissão para atender chamados. Apenas visualização.' });
        }

        const chamadoId = req.params.id;
        const atendenteId = req.session.userId;
        const atendenteNome = req.session.nomeCompleto || req.session.username;

        // Verificar se o chamado existe e não está sendo atendido
        const [chamado] = await db.query(
            'SELECT * FROM chamados WHERE id = ?',
            [chamadoId]
        );

        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        if (chamado[0].status === 'em_atendimento' && chamado[0].atendente_id !== atendenteId) {
            return res.status(400).json({ 
                success: false, 
                message: `Este chamado já está sendo atendido por ${chamado[0].atendente_nome}` 
            });
        }

        // Atualizar chamado para em atendimento
        await db.query(
            `UPDATE chamados 
             SET status = 'em_atendimento', 
                 atendente_id = ?, 
                 atendente_nome = ?,
                 iniciado_em = NOW()
             WHERE id = ?`,
            [atendenteId, atendenteNome, chamadoId]
        );

        // Enviar mensagem pelo WhatsApp
        const wppAt = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppAt.isConnected && wppAt.client && chamado[0].chat_origem) {
            try {
                const mensagem = `🔔 *ATUALIZAÇÃO DO CHAMADO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *Atendente:* ${atendenteNome}\n` +
                    `📊 *Status:* Em Atendimento\n\n` +
                    `Seu chamado está sendo atendido. Em breve entraremos em contato.`;
                
                await wppAt.client.sendMessage(chamado[0].chat_origem, mensagem);
            } catch (error) {
                console.error('Erro ao enviar mensagem WhatsApp:', error);
            }
        }

        res.json({ success: true, message: 'Atendimento iniciado com sucesso' });
    } catch (error) {
        console.error('Erro ao iniciar atendimento:', error);
        res.status(500).json({ success: false, message: 'Erro ao iniciar atendimento' });
    }
});

// API - Encerrar chamado
app.post('/api/chamados/:id/encerrar', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Seu perfil não tem permissão para encerrar chamados.' });
        }

        const chamadoId = req.params.id;
        const { observacoes } = req.body;

        // Verificar se o chamado existe
        const [chamado] = await db.query(
            'SELECT * FROM chamados WHERE id = ?',
            [chamadoId]
        );

        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        // Atualizar chamado para finalizado
        await db.query(
            `UPDATE chamados 
             SET status = 'finalizado', 
                 encerrado_em = NOW(),
                 observacoes = ?
             WHERE id = ?`,
            [observacoes || null, chamadoId]
        );

        const mensagemEncerramento = `✅ Chamado encerrado.\n📌 Protocolo: ${chamado[0].protocolo}`;

        // Enviar mensagem pelo WhatsApp e reabrir o fluxo para o usuário
        const wppEnc2 = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppEnc2.isConnected && wppEnc2.client) {
            try {
                let notificacaoEnviada = false;

                // Reabertura de fluxo (avaliação): HGP usa controller legacy, instâncias novas usam o controller do instance-manager
                let controllerParaReabrir = null;
                if (wppEnc2.client === whatsappClient) {
                    controllerParaReabrir = whatsappChatbotController;
                } else if (chamado[0].instancia_id) {
                    controllerParaReabrir = instanceManager.obterController(chamado[0].instancia_id);
                }

                if (controllerParaReabrir?.reiniciarFluxoPorEncerramento) {
                    notificacaoEnviada = await controllerParaReabrir.reiniciarFluxoPorEncerramento(chamado[0].chat_origem, {
                        protocolo: chamado[0].protocolo,
                        chamadoId: chamado[0].id,
                        atendenteNome: chamado[0].atendente_nome || 'Equipe TI',
                        nomeExibicao: chamado[0].solicitante_nome || 'Prezado'
                    });
                }

                if (!notificacaoEnviada) {
                    const destinoSolicitante = await resolveWhatsAppDestinationWith(
                        wppEnc2.client,
                        wppEnc2.isConnected,
                        chamado[0].chat_origem,
                        chamado[0].telefone_whatsapp,
                        chamado[0].telefone_contato
                    );

                    if (destinoSolicitante) {
                        await wppEnc2.client.sendMessage(destinoSolicitante, mensagemEncerramento);
                        notificacaoEnviada = true;
                    }
                }

                if (!notificacaoEnviada) {
                    console.error(`Nao foi possivel enviar a mensagem de encerramento do chamado ${chamado[0].protocolo}`);
                }
            } catch (error) {
                console.error('Erro ao enviar mensagem WhatsApp:', error);
            }
        }

        res.json({ success: true, message: 'Chamado encerrado com sucesso' });
    } catch (error) {
        console.error('Erro ao encerrar chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao encerrar chamado' });
    }
});

// API - Reabrir chamado finalizado
app.post('/api/chamados/:id/reabrir', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Seu perfil não tem permissão para reabrir chamados.' });
        }

        const chamadoId = req.params.id;
        const { motivo } = req.body;

        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);
        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }
        if (chamado[0].status !== 'finalizado') {
            return res.status(400).json({ success: false, message: 'Somente chamados finalizados podem ser reabertos' });
        }

        // Reabrir como "em_atendimento" mantendo o atendente
        await db.query(
            `UPDATE chamados 
             SET status = 'em_atendimento', 
                 encerrado_em = NULL,
                 observacoes = CONCAT(IFNULL(observacoes,''), '\n[Reaberto em ', NOW(), ' por ', ?, ': ', ?, ']')
             WHERE id = ?`,
            [req.session.username, motivo || 'Sem motivo informado', chamadoId]
        );

        // Registrar no chat como mensagem de sistema
        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem) VALUES (?, 'sistema', 'Sistema', ?)`,
            [chamadoId, `🔄 Chamado reaberto por ${req.session.username}${motivo ? ': ' + motivo : ''}`]
        );

        res.json({ success: true, message: 'Chamado reaberto com sucesso' });
    } catch (error) {
        console.error('Erro ao reabrir chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao reabrir chamado' });
    }
});

// API - Buscar mensagens do chat de um chamado
app.get('/api/chamados/:id/chat', isAuthenticated, async (req, res) => {
    try {
        const chamadoId = req.params.id;

        // Buscar mensagens do chat
        const [mensagens] = await db.query(
            `SELECT * FROM chat_messages 
             WHERE chamado_id = ? 
             ORDER BY enviada_em ASC`,
            [chamadoId]
        );

        // Marcar mensagens como lidas
        await db.query(
            `UPDATE chat_messages 
             SET lida = TRUE 
             WHERE chamado_id = ? AND remetente_tipo = 'solicitante'`,
            [chamadoId]
        );

        res.json({ success: true, mensagens });
    } catch (error) {
        console.error('Erro ao buscar mensagens:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar mensagens' });
    }
});

// API - Enviar mensagem do técnico para o solicitante
app.post('/api/chamados/:id/chat/enviar', isAuthenticated, async (req, res) => {
    try {
        const chamadoId = req.params.id;
        const { mensagem } = req.body;
        const remetenteNome = req.session.nomeCompleto || req.session.username;

        if (!mensagem || !mensagem.trim()) {
            return res.status(400).json({ success: false, message: 'Mensagem não pode estar vazia' });
        }

        // Buscar dados do chamado
        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);

        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        // Salvar mensagem no banco
        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem) 
             VALUES (?, 'tecnico', ?, ?)`,
            [chamadoId, remetenteNome, mensagem.trim()]
        );

        // Enviar mensagem pelo WhatsApp (escolhendo cliente correto da instância)
        const wpp = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wpp.isConnected && wpp.client && chamado[0].chat_origem) {
            try {
                const mensagemWhatsApp = `💬 *MENSAGEM DO ATENDIMENTO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *${remetenteNome}:*\n\n` +
                    `${mensagem.trim()}`;
                
                await wpp.client.sendMessage(chamado[0].chat_origem, mensagemWhatsApp);
                
                res.json({ success: true, message: 'Mensagem enviada com sucesso' });
            } catch (error) {
                console.error('Erro ao enviar mensagem WhatsApp:', error);
                res.status(500).json({ success: false, message: 'Erro ao enviar mensagem pelo WhatsApp: ' + error.message });
            }
        } else if (!chamado[0].chat_origem) {
            res.status(400).json({ success: false, message: 'Chamado sem chat_origem definido (não é possível enviar via WhatsApp)' });
        } else {
            res.status(400).json({ success: false, message: 'WhatsApp da instância deste chamado não está conectado. Verifique em /instancias' });
        }
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ success: false, message: 'Erro ao enviar mensagem' });
    }
});

// API - Contar mensagens não lidas por chamado
app.get('/api/chamados/:id/chat/nao-lidas', isAuthenticated, async (req, res) => {
    try {
        const chamadoId = req.params.id;

        const [result] = await db.query(
            `SELECT COUNT(*) as total FROM chat_messages 
             WHERE chamado_id = ? AND remetente_tipo = 'solicitante' AND lida = FALSE`,
            [chamadoId]
        );

        res.json({ success: true, total: result[0].total });
    } catch (error) {
        console.error('Erro ao contar mensagens não lidas:', error);
        res.status(500).json({ success: false, message: 'Erro ao contar mensagens' });
    }
});

// API - Enviar mídia (imagem, vídeo, áudio) no chat
app.post('/api/chamados/:id/chat/enviar-midia', isAuthenticated, uploadChatMedia.single('midia'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        }

        const chamadoId = req.params.id;
        const remetenteNome = req.session.nomeCompleto || req.session.username;
        const legenda = req.body.mensagem?.trim() || '';
        const mediaUrl = `/uploads/chat-media/${req.file.filename}`;
        const mimeType = req.file.mimetype;

        let messageType = 'document';
        if (mimeType.startsWith('image/')) messageType = 'image';
        else if (mimeType.startsWith('video/')) messageType = 'video';
        else if (mimeType.startsWith('audio/')) messageType = 'audio';

        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);
        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem, message_type, media_url, media_mime_type, media_filename)
             VALUES (?, 'tecnico', ?, ?, ?, ?, ?, ?)`,
            [chamadoId, remetenteNome, legenda || null, messageType, mediaUrl, mimeType, req.file.originalname]
        );

        const wppMd = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppMd.isConnected && wppMd.client && chamado[0].chat_origem) {
            try {
                const filePath = path.join(__dirname, 'public', 'uploads', 'chat-media', req.file.filename);
                const fileData = await fs.readFile(filePath);
                const base64 = fileData.toString('base64');
                const media = new MessageMedia(mimeType, base64, req.file.originalname);
                const caption = legenda ? `📌 ${chamado[0].protocolo}\n\n${legenda}` : `📌 ${chamado[0].protocolo}`;
                await wppMd.client.sendMessage(chamado[0].chat_origem, media, { caption });
            } catch (waError) {
                console.error('Erro ao enviar mídia pelo WhatsApp:', waError.message);
            }
        }

        res.json({ success: true, message: 'Mídia enviada com sucesso' });
    } catch (error) {
        console.error('Erro ao enviar mídia:', error);
        res.status(500).json({ success: false, message: 'Erro ao enviar mídia' });
    }
});

// API - Contar meus chamados em andamento
app.get('/api/chamados/meus-em-andamento', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS total FROM chamados WHERE atendente_id = ? AND status = 'em_atendimento'`,
            [req.session.userId]
        );
        res.json({ success: true, total: Number(rows[0]?.total || 0) });
    } catch (error) {
        res.status(500).json({ success: false, total: 0 });
    }
});

// API - Listar meus atendimentos
app.get('/api/chamados/meus-atendimentos', isAuthenticated, async (req, res) => {
    try {
        const atendenteId = req.session.userId;

        const [chamados] = await db.query(`
            SELECT *
            FROM chamados
            WHERE atendente_id = ? AND status IN ('em_atendimento', 'finalizado')
            ORDER BY 
                CASE 
                    WHEN status = 'em_atendimento' THEN 1
                    ELSE 2
                END,
                criado_em DESC
            LIMIT 50
        `, [atendenteId]);

        res.json({ success: true, chamados });
    } catch (error) {
        console.error('Erro ao buscar atendimentos:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar atendimentos' });
    }
});

// API - Obter dados do perfil do usuário logado
app.get('/api/perfil', isAuthenticated, async (req, res) => {
    try {
        const [users] = await db.query(
            'SELECT id, username, nome_completo, telefone, nivel_acesso FROM admins WHERE id = ?',
            [req.session.userId]
        );
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }
        res.json({ success: true, usuario: users[0] });
    } catch (error) {
        console.error('Erro ao buscar perfil:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar perfil' });
    }
});

// API - Atualizar perfil do usuário logado (nome, telefone, senha)
app.put('/api/perfil', isAuthenticated, async (req, res) => {
    try {
        const { nome_completo, telefone, senha_atual, nova_senha } = req.body;
        const userId = req.session.userId;

        // Se está tentando alterar a senha, validar a senha atual
        if (nova_senha) {
            if (!senha_atual) {
                return res.status(400).json({ success: false, message: 'Informe a senha atual para alterar a senha' });
            }

            const [users] = await db.query('SELECT password FROM admins WHERE id = ?', [userId]);
            if (users.length === 0) {
                return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
            }

            const senhaValida = await bcrypt.compare(senha_atual, users[0].password);
            if (!senhaValida) {
                return res.status(400).json({ success: false, message: 'Senha atual incorreta' });
            }

            if (nova_senha.length < 4) {
                return res.status(400).json({ success: false, message: 'A nova senha deve ter pelo menos 4 caracteres' });
            }

            const hashedPassword = await bcrypt.hash(nova_senha, 10);
            await db.query('UPDATE admins SET password = ? WHERE id = ?', [hashedPassword, userId]);
        }

        // Atualizar nome e telefone
        await db.query(
            'UPDATE admins SET nome_completo = ?, telefone = ? WHERE id = ?',
            [nome_completo || '', telefone || '', userId]
        );

        // Atualizar sessão
        if (nome_completo) {
            req.session.nomeCompleto = nome_completo;
        }

        res.json({ success: true, message: 'Perfil atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar perfil:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar perfil' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

process.on('uncaughtException', (error) => {
    if (isIgnorableWhatsAppRuntimeError(error)) {
        logRuntimeError('Erro transitório ignorado do WhatsApp', error);
        return;
    }

    logRuntimeError('Exceção não capturada no servidor', error);
});

process.on('unhandledRejection', (reason) => {
    if (isIgnorableWhatsAppRuntimeError(reason)) {
        logRuntimeError('Promessa rejeitada transitória do WhatsApp', reason);
        return;
    }

    logRuntimeError('Promessa rejeitada não tratada no servidor', reason);
});

async function startServer() {
    try {
        const schemaChanges = await ensureSchema(db);
        if (schemaChanges.length > 0) {
            console.log(`Schema sincronizado automaticamente: ${schemaChanges.join(', ')}`);
        }

        await syncDisconnectedSession();
        await instanceManager.syncOnStartup();

        // Auto-reconectar HGP (legacy) se já existe sessão salva
        try {
            const legacySessionPath = path.join(__dirname, '.wwebjs_auth', 'session-admin-session');
            if (fsSync.existsSync(legacySessionPath)) {
                console.log('[HGP] Auto-reconectando WhatsApp legado...');
                iniciarWhatsAppLegacy().catch(err => {
                    console.error('[HGP] Erro auto-reconnect:', err.message);
                });
            }
        } catch (e) {
            console.error('[HGP] Erro check auto-reconnect:', e.message);
        }

        app.listen(PORT, () => {
            console.log(`Servidor rodando em http://localhost:${PORT}`);
        });

        // Auto-encerramento de chamados pendentes às 23:59
        setInterval(async () => {
            const agora = new Date();
            if (agora.getHours() === 23 && agora.getMinutes() === 59) {
                try {
                    const [result] = await db.query(`
                        UPDATE chamados
                        SET status = 'finalizado',
                            encerrado_em = NOW(),
                            observacoes = CONCAT(COALESCE(observacoes, ''), '\n[Encerrado automaticamente às 23:59]')
                        WHERE status = 'pendente'
                          AND DATE(criado_em) <= CURDATE()
                    `);

                    if (result.affectedRows > 0) {
                        console.log(`🔒 Auto-encerramento: ${result.affectedRows} chamado(s) pendente(s) encerrado(s) às 23:59`);
                    }
                } catch (error) {
                    console.error('Erro no auto-encerramento de chamados:', error);
                }
            }
        }, 60 * 1000); // Verifica a cada 1 minuto
    } catch (error) {
        console.error('Falha ao sincronizar schema do banco antes de iniciar o servidor:', error);
        process.exit(1);
    }
}

startServer();
