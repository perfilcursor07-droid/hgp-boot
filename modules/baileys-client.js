// ════════════════════════════════════════════════════════════════════
// Baileys Client — wrapper compatível com whatsapp-web.js
// ════════════════════════════════════════════════════════════════════
// Usado APENAS para instâncias novas (SESAU, etc).
// O HGP continua usando whatsapp-web.js direto.
// ════════════════════════════════════════════════════════════════════

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const EventEmitter = require('events');

const logger = pino({ level: 'silent' });

class BaileysClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.clientId = options.clientId || 'default';
        this.authDir = options.authDir || path.join(__dirname, '..', '.baileys_auth');
        this.sock = null;
        this.isConnected = false;
        this.qrRetries = 0;
        this.maxQrRetries = 5;
        this._destroyed = false;
        // Dedup de mensagens recebidas por ID — sobrevive a reconexões (515 etc).
        // Mantido no nível da instância (não do socket) para que múltiplos
        // sockets criados na mesma instância compartilhem o mesmo registro.
        this._recentMsgIds = new Map();
    }

    async initialize() {
        if (this._destroyed) return;

        const sessionDir = path.join(this.authDir, this.clientId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        this._state = state;
        this._saveCreds = saveCreds;
        this._sessionDir = sessionDir;

        await this._createSocket();
    }

    async _reconnect() {
        if (this._destroyed) return;
        await this._createSocket();
    }

    async _createSocket() {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(this._sessionDir);

        // Limpar socket anterior se existir — remover listeners E encerrar a
        // conexão websocket antiga. Sem o end(), o socket antigo pode continuar
        // vivo e entregar mensagens em paralelo ao novo (duplicação).
        if (this.sock) {
            try { this.sock.ev.removeAllListeners(); } catch (e) {}
            try { this.sock.end(undefined); } catch (e) {}
            this.sock = null;
        }

        this.sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger,
            printQRInTerminal: false,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            // ═══ ANTI-BAN: Configurações otimizadas ═══
            markOnlineOnConnect: false,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 25_000,
            retryRequestDelayMs: 500,
            defaultQueryTimeoutMs: 60_000,
            emitOwnEvents: false,
            fireInitQueries: true
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            if (this._destroyed) return;
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrRetries++;
                if (this.qrRetries > this.maxQrRetries) {
                    this.emit('auth_failure', 'QR Code expirado');
                    return;
                }
                try {
                    const qrDataUrl = await qrcode.toDataURL(qr);
                    this.emit('qr', qrDataUrl);
                } catch (e) {
                    this.emit('qr', qr);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !this._destroyed;

                if (shouldReconnect) {
                    const delay = Math.min(30000, 5000 * this.qrRetries);
                    console.log(`[Baileys:${this.clientId}] Desconectado (${statusCode}) — reconectando em ${delay/1000}s...`);
                    this.isConnected = false;
                    setTimeout(() => {
                        if (!this._destroyed) this._reconnect();
                    }, delay);
                } else {
                    this.isConnected = false;
                    this.emit('disconnected', statusCode === DisconnectReason.loggedOut ? 'LOGOUT' : 'Desconectado');
                }
            }

            if (connection === 'open') {
                this.isConnected = true;
                this.qrRetries = 0;
                this.emit('ready');
            }
        });

        // Mensagens recebidas — registra UMA vez por socket
        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify' || this._destroyed) return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                if (!msg.message) continue;

                const msgId = msg.key.id;
                const remoteJid = msg.key.remoteJid || '';
                const ts = msg.messageTimestamp || 0;
                const m = msg.message || {};
                const textoRaw = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';

                const now = Date.now();
                console.log(`[Baileys:${this.clientId}] upsert from=${remoteJid} id=${msgId} ts=${ts} body="${String(textoRaw).slice(0, 40)}"`);

                // ═══ DEDUP À PROVA DE RECONEXÃO E DE @lid ═══
                // O Baileys 7.x (endereçamento LID) pode entregar a MESMA mensagem
                // lógica DUAS vezes com key.id DIFERENTE, quase simultaneamente.
                // Deduplicamos por remetente + conteúdo dentro de uma JANELA curta.
                // A reentrega chega em milissegundos; um input genuíno repetido
                // (ex: digitar "1" no menu e "1" no submenu) leva segundos e passa.
                const DEDUP_WINDOW_MS = 6000;
                const dedupKey = `${remoteJid}|${String(textoRaw).trim().toLowerCase()}`;
                const lastSeen = this._recentMsgIds.get(dedupKey);
                if (lastSeen && (now - lastSeen) < DEDUP_WINDOW_MS) {
                    console.log(`[Baileys:${this.clientId}] >> DUPLICADA ignorada (${now - lastSeen}ms) key="${dedupKey.slice(0, 50)}"`);
                    continue;
                }
                this._recentMsgIds.set(dedupKey, now);
                // Limpeza preguiçosa: remove chaves antigas
                if (this._recentMsgIds.size > 500) {
                    for (const [k, t] of this._recentMsgIds) {
                        if (now - t > 60 * 1000) this._recentMsgIds.delete(k);
                    }
                }

                const fakeMsg = this._converterMensagem(msg);
                this.emit('message', fakeMsg);
            }
        });
    }

    _converterMensagem(msg) {
        const jid = msg.key.remoteJid || '';
        const message = msg.message || {};
        const texto = message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || '';
        let type = 'chat';
        const hasMedia = !!(message.imageMessage || message.videoMessage || message.audioMessage || message.documentMessage || message.stickerMessage);
        if (message.imageMessage) type = 'image';
        else if (message.videoMessage) type = 'video';
        else if (message.audioMessage) type = 'ptt';
        else if (message.documentMessage) type = 'document';
        else if (message.stickerMessage) type = 'sticker';
        const pushName = msg.pushName || '';
        const self = this;

        return {
            from: jid, to: '', body: texto, type, hasMedia, fromMe: false,
            timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
            id: { _serialized: msg.key.id || `${jid}-${Date.now()}` },
            async getContact() { return { pushname: pushName, name: pushName, number: jid.replace(/@.*$/, '') }; },
            async delete(forEveryone) { try { await self.sock.sendMessage(jid, { delete: msg.key }); } catch (e) {} },
            async downloadMedia() { return null; }
        };
    }

    async sendMessage(chatId, content, options = {}) {
        if (!this.sock || !this.isConnected) throw new Error('WhatsApp não está conectado');

        // ═══ ANTI-BAN: Simular comportamento humano ═══
        // 1. Delay aleatório ANTES de enviar (humanos não respondem instantaneamente)
        const preDelay = 1000 + Math.floor(Math.random() * 2000); // 1-3s
        await new Promise(r => setTimeout(r, preDelay));

        // 2. Mostrar "digitando..." (presença composing)
        try {
            await this.sock.sendPresenceUpdate('composing', chatId);
            // Tempo de "digitação" proporcional ao tamanho do texto (50-80ms por caractere)
            const textoLen = typeof content === 'string' ? content.length : (options.caption || '').length || 20;
            const typingTime = Math.min(4000, Math.max(800, textoLen * (50 + Math.floor(Math.random() * 30))));
            await new Promise(r => setTimeout(r, typingTime));
            await this.sock.sendPresenceUpdate('paused', chatId);
        } catch (e) { /* não-crítico */ }

        // 3. Micro-delay final aleatório (100-500ms)
        await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 400)));

        // ═══ ENVIO ═══
        if (typeof content === 'string') {
            await this.sock.sendMessage(chatId, { text: content });
            return {};
        }
        if (content && content.mimetype) {
            const buffer = Buffer.from(content.data, 'base64');
            const mime = content.mimetype;
            if (mime.startsWith('image/')) await this.sock.sendMessage(chatId, { image: buffer, caption: options.caption || '', mimetype: mime });
            else if (mime.startsWith('video/')) await this.sock.sendMessage(chatId, { video: buffer, caption: options.caption || '', mimetype: mime });
            else if (mime.startsWith('audio/')) await this.sock.sendMessage(chatId, { audio: buffer, mimetype: mime, ptt: true });
            else await this.sock.sendMessage(chatId, { document: buffer, mimetype: mime, fileName: content.filename || 'arquivo' });
            return {};
        }
        if (content?.text) await this.sock.sendMessage(chatId, { text: content.text });
        return {};
    }

    async getNumberId(numero) {
        if (!this.sock) return null;
        try {
            let num = String(numero).replace(/\D/g, '');
            const [result] = await this.sock.onWhatsApp(num);
            if (result?.exists) return { _serialized: result.jid };
            return null;
        } catch (e) { return null; }
    }

    async getContactById(jid) { return { pushname: '', name: '', number: jid.replace(/@.*$/, '') }; }

    async getChatById(chatId) {
        const self = this;
        return {
            async sendStateTyping() { try { await self.sock.sendPresenceUpdate('composing', chatId); } catch (e) {} },
            async clearState() { try { await self.sock.sendPresenceUpdate('paused', chatId); } catch (e) {} }
        };
    }

    async destroy() {
        this._destroyed = true;
        if (this.sock) {
            try { this.sock.ev.removeAllListeners(); this.sock.end(); } catch (e) {}
            this.sock = null;
        }
        this.isConnected = false;
    }

    async logout() {
        if (this.sock) { try { await this.sock.logout(); } catch (e) {} }
        await this.destroy();
        const sessionDir = path.join(this.authDir, this.clientId);
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

module.exports = { BaileysClient };
