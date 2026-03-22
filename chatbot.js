const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { attachChatbot, registrarErro } = require('./chatbot-handler');

// ================= INICIALIZAÇÃO (MODO RESILIENTE) =================
const client = new Client({
    authStrategy: new LocalAuth({ 
        clientId: 'bot-hgp-v6',
        dataPath: path.join(__dirname, 'wwebjs_sessions')
    }),
    puppeteer: {
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--no-first-run'
        ]
    }
});
attachChatbot(client, { managedByServer: false });

// ================= MONITORAMENTO GLOBAL (CORREÇÃO DE CONFLITO) =================
client.on('qr', (qr) => {
    console.log('📲 Escaneie este QR Code para conectar a sessao do chatbot (bot-hgp-v6).');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('🔐 Sessao do chatbot autenticada. Aguardando ficar pronta...');
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Inicializando chatbot: ${percent}% - ${message}`);
});

client.on('ready', () => {
    console.log('🚀 BOT HGP ATIVO E MONITORADO');
});

client.on('auth_failure', (message) => {
    registrarErro(new Error(message), 'Falha de autenticacao do chatbot');
});

client.on('disconnected', async (reason) => {
    console.log('⚠️ Bot desconectado:', reason);
    try {
        await client.destroy(); // Fecha o Chrome corretamente
    } catch (e) { console.log('Erro ao destruir processo antigo.'); }
    
    console.log('Reiniciando em 15 segundos para evitar conflito de sessão...');
    setTimeout(() => { client.initialize(); }, 15000); 
});

process.on('unhandledRejection', (reason) => {
    if (reason.toString().includes("already running")) {
        console.error("⚠️ Erro Crítico: O Chrome já está aberto. Feche o processo Node/Chrome no Gerenciador de Tarefas.");
    }
    registrarErro(reason, 'Promessa não tratada');
});

process.on('uncaughtException', (err) => {
    registrarErro(err, 'Exceção não capturada');
});

// Inicialização ÚNICA
client.initialize().catch(err => registrarErro(err, "Falha na inicialização inicial"));