require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const bcrypt = require('bcrypt');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const db = require('./config/database');
const { attachChatbot } = require('./chatbot-handler');

const app = express();
const PORT = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);
const CHATBOT_FILE_PATH = path.join(__dirname, 'chatbot.js');
const ESCALA_FILE_PATH = path.join(__dirname, 'escala.json');

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

// WhatsApp client
let whatsappClient = null;
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
    whatsappState = 'disconnected';
    await syncDisconnectedSession();
};

const readChatbotFile = async () => fs.readFile(CHATBOT_FILE_PATH, 'utf8');
const readEscalaFile = async () => fs.readFile(ESCALA_FILE_PATH, 'utf8');

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

const validateEscalaSource = async (source) => {
    try {
        const parsed = JSON.parse(source);

        if (!Array.isArray(parsed)) {
            return 'O arquivo da escala deve conter uma lista JSON.';
        }

        for (const [index, item] of parsed.entries()) {
            if (!item || typeof item !== 'object') {
                return `Registro inválido na posição ${index + 1}.`;
            }

            if (typeof item.data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.data)) {
                return `O campo data do registro ${index + 1} deve estar no formato YYYY-MM-DD.`;
            }

            if (typeof item.tecnico !== 'string' || !item.tecnico.trim()) {
                return `O campo tecnico do registro ${index + 1} é obrigatório.`;
            }

            if (typeof item.telefone !== 'string' || !item.telefone.trim()) {
                return `O campo telefone do registro ${index + 1} é obrigatório.`;
            }
        }

        return null;
    } catch (error) {
        return error.message || 'JSON inválido na escala.';
    }
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
        const [users] = await db.query('SELECT * FROM admins WHERE username = ?', [username]);
        
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
        res.redirect('/dashboard');
    } catch (error) {
        console.error('Erro no login:', error);
        res.render('login', { error: 'Erro ao fazer login' });
    }
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
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

        attachChatbot(whatsappClient, { managedByServer: true });

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

app.get('/messages', isAuthenticated, async (req, res) => {
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
        }, { total: 0, aberto: 0, pendente: 0, finalizado: 0 });

        res.render('chamados', {
            username: req.session.username,
            chamados,
            contagem
        });
    } catch (error) {
        console.error('Erro ao carregar chamados:', error);
        res.render('chamados', {
            username: req.session.username,
            chamados: [],
            contagem: { total: 0, aberto: 0, pendente: 0, finalizado: 0 }
        });
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

app.get('/contacts', isAuthenticated, (req, res) => {
    res.render('coming-soon', { username: req.session.username, page: 'Contatos' });
});

app.get('/settings', isAuthenticated, async (req, res) => {
    try {
        const [chatbotCode, escalaCode] = await Promise.all([
            readChatbotFile(),
            readEscalaFile()
        ]);

        res.render('settings', {
            username: req.session.username,
            chatbotCode,
            escalaCode,
            chatbotFileName: 'chatbot.js',
            escalaFileName: 'escala.json'
        });
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
        res.status(500).render('settings', {
            username: req.session.username,
            chatbotCode: '',
            escalaCode: '[]',
            chatbotFileName: 'chatbot.js',
            escalaFileName: 'escala.json'
        });
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

app.get('/api/settings/escala-file', isAuthenticated, async (req, res) => {
    try {
        const content = await readEscalaFile();
        res.json({ success: true, content, fileName: 'escala.json' });
    } catch (error) {
        console.error('Erro ao ler escala.json:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar escala.json' });
    }
});

app.post('/api/settings/escala-file', isAuthenticated, async (req, res) => {
    const { content } = req.body;

    if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ success: false, message: 'O conteúdo da escala não pode ficar vazio' });
    }

    try {
        const validationError = await validateEscalaSource(content);

        if (validationError) {
            return res.status(400).json({
                success: false,
                message: 'A escala não foi salva porque há erro de validação',
                details: validationError
            });
        }

        await fs.writeFile(ESCALA_FILE_PATH, content, 'utf8');

        res.json({
            success: true,
            message: 'escala.json atualizado no projeto com sucesso'
        });
    } catch (error) {
        console.error('Erro ao salvar escala.json:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar escala.json' });
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

syncDisconnectedSession();

app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
