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

    try {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS total
             FROM chamados
             WHERE status = 'pendente'`
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
    } catch (error) {
        console.error('Erro ao sincronizar sessão desconectada:', error);
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
    if (!whatsappClient || whatsappState !== 'connected') {
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
                const numberId = await whatsappClient.getNumberId(number);
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

const listEscalaUsers = async () => {
    const [users] = await db.query(`
        SELECT
            id,
            username,
            COALESCE(NULLIF(nome_completo, ''), username) AS nome_exibicao,
            telefone,
            nivel_acesso
        FROM admins
        WHERE ativo = TRUE
          AND telefone IS NOT NULL
          AND telefone <> ''
        ORDER BY nome_exibicao ASC
    `);

    return users;
};

const listEscalas = async () => {
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
        ORDER BY e.data_escala DESC, tecnico_nome ASC
    `);

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

const listChamadosOverview = async () => {
    const [chamados] = await db.query(`
        SELECT *
        FROM chamados
        ORDER BY criado_em DESC
        LIMIT 200
    `);

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
        const [users] = await db.query('SELECT * FROM admins WHERE username = ? AND ativo = TRUE', [username]);
        
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
        
        // Redirecionar baseado no nível de acesso
        if (user.nivel_acesso === 'gestor') {
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
        const [sessions] = await db.query('SELECT * FROM whatsapp_sessions ORDER BY id DESC LIMIT 1');
        const session = sessions[0]
            ? {
                ...sessions[0],
                is_connected: whatsappState === 'connected'
            }
            : null;
        
        res.render('dashboard', {
            username: req.session.username,
            session,
            qrCode: currentQR
        });
    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
        res.render('dashboard', { username: req.session.username, session: null, qrCode: null });
    }
});

app.post('/whatsapp/connect', isAuthenticated, async (req, res) => {
    try {
        if (whatsappState === 'connected') {
            return res.json({ success: true, connected: true, message: 'WhatsApp já está conectado' });
        }

        if (whatsappState === 'connecting' && whatsappClient) {
            return res.json({ success: true, connected: false, message: 'Conexão com WhatsApp em andamento' });
        }

        if (whatsappClient) {
            try {
                await whatsappClient.destroy();
            } catch (error) {
                console.error('Erro ao limpar cliente WhatsApp anterior:', error);
            }

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
        });

        whatsappClient.on('ready', async () => {
            console.log('WhatsApp conectado!');
            whatsappState = 'connected';
            whatsappLastError = null;
            currentQR = null;
            await db.query(
                'UPDATE whatsapp_sessions SET is_connected = ?, last_connected = NOW(), qr_code = NULL WHERE session_name = ?',
                [true, 'admin-session']
            );
        });

        whatsappClient.on('auth_failure', async (message) => {
            console.error('Falha de autenticação do WhatsApp:', message);
            whatsappLastError = `Falha de autenticação do WhatsApp: ${message}`;
            await resetWhatsAppRuntime();
        });

        whatsappClient.on('disconnected', async (reason) => {
            console.log('WhatsApp desconectado:', reason);
            whatsappLastError = `WhatsApp desconectado: ${reason}`;

            if (whatsappClient) {
                try {
                    await whatsappClient.destroy();
                } catch (error) {
                    console.error('Erro ao destruir cliente após desconexão:', error);
                }
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

        res.json({ success: true, connected: false, message: 'Conectando ao WhatsApp...' });
    } catch (error) {
        console.error('Erro ao conectar:', error);
        await resetWhatsAppRuntime();
        res.status(500).json({ success: false, message: 'Erro ao conectar' });
    }
});

app.get('/whatsapp/status', isAuthenticated, async (req, res) => {
    try {
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
        const [messages] = await db.query(`
            SELECT m.*, ws.session_name 
            FROM messages m
            JOIN whatsapp_sessions ws ON m.session_id = ws.id
            ORDER BY m.timestamp DESC
            LIMIT 100
        `);
        res.render('messages', { username: req.session.username, messages });
    } catch (error) {
        console.error('Erro ao carregar mensagens:', error);
        res.render('messages', { username: req.session.username, messages: [] });
    }
});

app.get('/chamados', isAuthenticated, async (req, res) => {
    try {
        // Garantir que nivelAcesso existe na sessão
        if (!req.session.nivelAcesso) {
            req.session.nivelAcesso = 'administrador';
        }

        const { chamados, contagem } = await listChamadosOverview();

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
        const overview = await listChamadosOverview();
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

        const [rows] = await db.query(
            `SELECT COUNT(*) AS total
             FROM chamados
             WHERE status = 'pendente'`
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
        
        res.json({
            messagesToday: messagesToday[0].count,
            activeContacts: activeContacts[0].count
        });
    } catch (error) {
        res.json({ messagesToday: 0, activeContacts: 0 });
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
            listEscalas(),
            listEscalaUsers()
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

app.get('/fluxo', isAuthenticated, isAdmin, async (req, res) => {
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

        // Total por período
        const [totalPeriodo] = await db.query(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'aberto' THEN 1 ELSE 0 END) as abertos,
                   SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) as pendentes,
                   SUM(CASE WHEN status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ?
        `, [dataInicio, dataFim]);

        // Por setor
        const [porSetor] = await db.query(`
            SELECT setor, COUNT(*) as total,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN status != 'finalizado' THEN 1 ELSE 0 END) as abertos
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ?
            GROUP BY setor
            ORDER BY total DESC
        `, [dataInicio, dataFim]);

        // Por categoria
        const [porCategoria] = await db.query(`
            SELECT categoria, COUNT(*) as total,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN status != 'finalizado' THEN 1 ELSE 0 END) as abertos
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ?
            GROUP BY categoria
            ORDER BY total DESC
        `, [dataInicio, dataFim]);

        // Por atendente
        const [porAtendente] = await db.query(`
            SELECT COALESCE(atendente_nome, tecnico_nome, 'Sem atendente') as atendente,
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                   SUM(CASE WHEN status NOT IN ('finalizado','em_atendimento') THEN 1 ELSE 0 END) as pendentes
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ?
            GROUP BY atendente
            ORDER BY total DESC
        `, [dataInicio, dataFim]);

        // Por dia (para gráfico)
        const [porDia] = await db.query(`
            SELECT DATE_FORMAT(criado_em, '%Y-%m-%d') as dia, COUNT(*) as total
            FROM chamados
            WHERE DATE(criado_em) BETWEEN ? AND ?
            GROUP BY dia
            ORDER BY dia ASC
        `, [dataInicio, dataFim]);

        res.json({
            success: true,
            resumo: totalPeriodo[0],
            porSetor,
            porCategoria,
            porAtendente,
            porDia
        });
    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
    }
});

app.get('/settings', isAuthenticated, isAdmin, async (req, res) => {
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

app.get('/api/settings/system', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [settings] = await db.query('SELECT setting_key, setting_value FROM system_settings');
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });
        res.json({ success: true, settings: settingsMap });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao carregar configurações' });
    }
});

app.post('/api/settings/system', isAuthenticated, isAdmin, async (req, res) => {
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

app.get('/api/settings/chatbot-file', isAuthenticated, async (req, res) => {
    try {
        const content = await readChatbotFile();
        res.json({ success: true, content, fileName: 'chatbot.js' });
    } catch (error) {
        console.error('Erro ao ler chatbot.js:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar chatbot.js' });
    }
});

app.post('/api/settings/chatbot-file', isAuthenticated, async (req, res) => {
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
        const escalas = await listEscalas();
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

app.get('/api/fluxos', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const flows = await listChatbotFlows();
        res.json({ success: true, flows });
    } catch (error) {
        console.error('Erro ao listar fluxos:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar fluxos' });
    }
});

app.get('/api/fluxos/:id', isAuthenticated, isAdmin, async (req, res) => {
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

app.post('/api/fluxos', isAuthenticated, isAdmin, async (req, res) => {
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

app.put('/api/fluxos/:id', isAuthenticated, isAdmin, async (req, res) => {
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

app.delete('/api/fluxos/:id', isAuthenticated, isAdmin, async (req, res) => {
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

app.post('/api/fluxos/:id/steps', isAuthenticated, isAdmin, async (req, res) => {
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

app.put('/api/fluxos/:flowId/steps/:stepId', isAuthenticated, isAdmin, async (req, res) => {
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

app.delete('/api/fluxos/:flowId/steps/:stepId', isAuthenticated, isAdmin, async (req, res) => {
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
        const [usuarios] = await db.query(`
            SELECT id, username, nome_completo, cpf, telefone, nivel_acesso, ativo, created_at
            FROM admins
            ORDER BY created_at DESC
        `);

        const stats = {
            total: usuarios.length,
            administradores: usuarios.filter(u => u.nivel_acesso === 'administrador').length,
            gestores: usuarios.filter(u => u.nivel_acesso === 'gestor').length,
            ativos: usuarios.filter(u => u.ativo).length
        };

        res.render('usuarios', { 
            username: req.session.username,
            usuarios,
            stats
        });
    } catch (error) {
        console.error('Erro ao carregar usuários:', error);
        res.render('usuarios', { 
            username: req.session.username,
            usuarios: [],
            stats: { total: 0, administradores: 0, gestores: 0, ativos: 0 }
        });
    }
});

// API - Listar gestores disponíveis (DEVE VIR ANTES DE :id)
app.get('/api/usuarios/gestores', isAuthenticated, isAdmin, async (req, res) => {
    try {
        console.log('Buscando gestores... Usuário:', req.session.username, 'Nível:', req.session.nivelAcesso);
        
        const [gestores] = await db.query(`
            SELECT id, username, nome_completo, telefone
            FROM admins
            WHERE nivel_acesso = 'gestor' AND ativo = TRUE
            ORDER BY nome_completo
        `);

        console.log('Gestores encontrados:', gestores.length);
        res.json({ success: true, gestores });
    } catch (error) {
        console.error('Erro ao buscar gestores:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar gestores' });
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

        res.json({ success: true, usuario: usuarios[0] });
    } catch (error) {
        console.error('Erro ao buscar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar usuário' });
    }
});

// API - Criar usuário
app.post('/api/usuarios', isAuthenticated, isAdmin, async (req, res) => {
    const { nome_completo, username, cpf, telefone, nivel_acesso, password, ativo } = req.body;

    try {
        // Verificar se o usuário já existe
        const [existing] = await db.query('SELECT id FROM admins WHERE username = ? OR cpf = ?', [username, cpf]);
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Usuário ou CPF já cadastrado' });
        }

        // Criptografar senha
        const hashedPassword = await bcrypt.hash(password, 10);

        await db.query(
            `INSERT INTO admins (username, nome_completo, cpf, telefone, nivel_acesso, password, ativo)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [username, nome_completo, cpf, telefone, nivel_acesso, hashedPassword, ativo]
        );

        res.json({ success: true, message: 'Usuário criado com sucesso' });
    } catch (error) {
        console.error('Erro ao criar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar usuário' });
    }
});

// API - Atualizar usuário
app.put('/api/usuarios/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { nome_completo, username, cpf, telefone, nivel_acesso, password, ativo } = req.body;
    const userId = req.params.id;

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
        if (password && password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(password, 10);
            await db.query(
                `UPDATE admins 
                 SET username = ?, nome_completo = ?, cpf = ?, telefone = ?, nivel_acesso = ?, password = ?, ativo = ?
                 WHERE id = ?`,
                [username, nome_completo, cpf, telefone, nivel_acesso, hashedPassword, ativo, userId]
            );
        } else {
            // Atualizar sem modificar a senha
            await db.query(
                `UPDATE admins 
                 SET username = ?, nome_completo = ?, cpf = ?, telefone = ?, nivel_acesso = ?, ativo = ?
                 WHERE id = ?`,
                [username, nome_completo, cpf, telefone, nivel_acesso, ativo, userId]
            );
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
        const [usuarios] = await db.query(`
            SELECT id, username, nome_completo, telefone, nivel_acesso, ativo
            FROM admins
            WHERE ativo = TRUE AND telefone IS NOT NULL AND telefone <> '' AND nivel_acesso = 'gestor'
            ORDER BY nome_completo
        `);

        const [todosTurnos] = await db.query(`
            SELECT t.*, COALESCE(NULLIF(a.nome_completo,''), a.username) as nome_usuario
            FROM user_turnos t
            JOIN admins a ON a.id = t.admin_id
            WHERE t.ativo = TRUE
            ORDER BY t.admin_id, t.dia_semana
        `);

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

// API - Encaminhar chamado para gestor (DEVE VIR ANTES DE :id/atender)
app.post('/api/chamados/:id/encaminhar', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const chamadoId = req.params.id;
        const { gestorId } = req.body;

        // Buscar dados do gestor
        const [gestor] = await db.query(
            'SELECT id, nome_completo, telefone FROM admins WHERE id = ? AND nivel_acesso = "gestor"',
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

        // Enviar WhatsApp para o gestor
        if (whatsappClient && whatsappState === 'connected' && gestor[0].telefone) {
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
                        const numberId = await whatsappClient.getNumberId(numero);
                        if (numberId && numberId._serialized) {
                            console.log('ID do gestor encontrado:', numberId._serialized);
                            await whatsappClient.sendMessage(numberId._serialized, mensagemGestor);
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
        if (whatsappClient && whatsappState === 'connected' && chamado[0].chat_origem) {
            try {
                const mensagemSolicitante = `🔔 *ATUALIZAÇÃO DO CHAMADO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *Atendente:* ${gestor[0].nome_completo}\n` +
                    `📊 *Status:* Em Atendimento\n\n` +
                    `Seu chamado foi encaminhado e está sendo atendido.`;

                await whatsappClient.sendMessage(chamado[0].chat_origem, mensagemSolicitante);
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

// API - Iniciar atendimento de chamado
app.post('/api/chamados/:id/atender', isAuthenticated, async (req, res) => {
    try {
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
        if (whatsappClient && whatsappState === 'connected' && chamado[0].chat_origem) {
            try {
                const mensagem = `🔔 *ATUALIZAÇÃO DO CHAMADO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *Atendente:* ${atendenteNome}\n` +
                    `📊 *Status:* Em Atendimento\n\n` +
                    `Seu chamado está sendo atendido. Em breve entraremos em contato.`;
                
                await whatsappClient.sendMessage(chamado[0].chat_origem, mensagem);
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
        if (whatsappClient && whatsappState === 'connected') {
            try {
                let notificacaoEnviada = false;

                if (whatsappChatbotController?.reiniciarFluxoPorEncerramento) {
                    notificacaoEnviada = await whatsappChatbotController.reiniciarFluxoPorEncerramento(chamado[0].chat_origem, {
                        protocolo: chamado[0].protocolo,
                        atendenteNome: chamado[0].atendente_nome || 'Equipe TI',
                        nomeExibicao: chamado[0].solicitante_nome || 'Prezado'
                    });
                }

                if (!notificacaoEnviada) {
                    const destinoSolicitante = await resolveWhatsAppDestination(
                        chamado[0].chat_origem,
                        chamado[0].telefone_whatsapp,
                        chamado[0].telefone_contato
                    );

                    if (destinoSolicitante) {
                        await whatsappClient.sendMessage(destinoSolicitante, mensagemEncerramento);
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

        // Enviar mensagem pelo WhatsApp
        if (whatsappClient && whatsappState === 'connected' && chamado[0].chat_origem) {
            try {
                const mensagemWhatsApp = `💬 *MENSAGEM DO ATENDIMENTO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *${remetenteNome}:*\n\n` +
                    `${mensagem.trim()}`;
                
                await whatsappClient.sendMessage(chamado[0].chat_origem, mensagemWhatsApp);
                
                res.json({ success: true, message: 'Mensagem enviada com sucesso' });
            } catch (error) {
                console.error('Erro ao enviar mensagem WhatsApp:', error);
                res.status(500).json({ success: false, message: 'Erro ao enviar mensagem pelo WhatsApp' });
            }
        } else {
            res.status(400).json({ success: false, message: 'WhatsApp não está conectado' });
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

        if (whatsappClient && whatsappState === 'connected' && chamado[0].chat_origem) {
            try {
                const filePath = path.join(__dirname, 'public', 'uploads', 'chat-media', req.file.filename);
                const fileData = await fs.readFile(filePath);
                const base64 = fileData.toString('base64');
                const media = new MessageMedia(mimeType, base64, req.file.originalname);
                const caption = legenda ? `📌 ${chamado[0].protocolo}\n\n${legenda}` : `📌 ${chamado[0].protocolo}`;
                await whatsappClient.sendMessage(chamado[0].chat_origem, media, { caption });
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

        app.listen(PORT, () => {
            console.log(`Servidor rodando em http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Falha ao sincronizar schema do banco antes de iniciar o servidor:', error);
        process.exit(1);
    }
}

startServer();
