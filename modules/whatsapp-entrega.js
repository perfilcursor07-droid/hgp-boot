// Entrega de mensagens WhatsApp com fallback para contas em LID (@lid).
// O sendMessage direto para @lid costuma "dar certo" no Node e o usuário não vê nada.

function serializarId(valor) {
    if (!valor) return null;
    if (typeof valor === 'string') return valor;
    if (valor._serialized) return valor._serialized;
    if (valor.id?._serialized) return valor.id._serialized;
    return String(valor);
}

function adicionarId(lista, seen, valor) {
    const id = serializarId(valor);
    if (!id || seen.has(id)) return;
    seen.add(id);
    lista.push(id);
}

async function paresLidPn(client, userId) {
    if (!userId || typeof client?.getContactLidAndPhone !== 'function') return [];
    try {
        const pares = await client.getContactLidAndPhone([userId]);
        return Array.isArray(pares) ? pares : [];
    } catch (e) {
        return [];
    }
}

async function expandirDestinos(client, destino) {
    const ids = [];
    const seen = new Set();
    adicionarId(ids, seen, destino);

    for (const par of await paresLidPn(client, destino)) {
        adicionarId(ids, seen, par.lid);
        adicionarId(ids, seen, par.pn);
        adicionarId(ids, seen, par.wid);
    }

    return ids;
}

/**
 * Tenta entregar a mensagem por todos os caminhos possíveis.
 * @returns {Promise<boolean>}
 */
async function entregarMensagem(client, destino, content, extras = {}) {
    if (!client) {
        console.error('[Entrega] Cliente WhatsApp ausente');
        return false;
    }

    const { chat, msg } = extras;
    const erros = [];

    const tentar = async (rotulo, fn) => {
        try {
            await fn();
            console.log(`[Entrega] OK via ${rotulo}`);
            return true;
        } catch (e) {
            const detalhe = e?.message || String(e || 'erro');
            erros.push(`${rotulo}: ${detalhe}`);
            return false;
        }
    };

    if (chat && typeof chat.sendMessage === 'function') {
        if (await tentar('chat.sendMessage', () => chat.sendMessage(content))) return true;
    }

    if (msg && typeof msg.reply === 'function' && typeof content === 'string') {
        if (await tentar('msg.reply', () => msg.reply(content))) return true;
    }

    if (client.pupPage && msg?.id?._serialized && typeof content === 'string') {
        if (await tentar('store.quoted', async () => {
            const ok = await client.pupPage.evaluate(async (msgId, text) => {
                try {
                    const storeMsg = window.Store?.Msg?.get?.(msgId)
                        || window.Store?.Msg?.getById?.(msgId);
                    if (!storeMsg) return false;
                    const chat = storeMsg.chat
                        || window.Store?.Chat?.get?.(storeMsg.from)
                        || window.Store?.Chat?.get?.(storeMsg.id?.remote);
                    if (!chat) return false;
                    if (window.WWebJS?.sendMessage) {
                        await window.WWebJS.sendMessage(chat, text, { quotedMsg: storeMsg });
                        return true;
                    }
                    if (typeof chat.sendMessage === 'function') {
                        await chat.sendMessage(text);
                        return true;
                    }
                    return false;
                } catch (e) {
                    return false;
                }
            }, msg.id._serialized, content);
            if (!ok) throw new Error('não achou o chat no Store');
        })) return true;
    }

    if (msg && typeof msg.getChat === 'function' && !chat) {
        try {
            const chatMsg = await msg.getChat();
            if (chatMsg && typeof chatMsg.sendMessage === 'function') {
                if (await tentar('msg.getChat.sendMessage', () => chatMsg.sendMessage(content))) return true;
            }
        } catch (e) {
            erros.push(`msg.getChat: ${e.message}`);
        }
    }

    const ids = await expandirDestinos(client, destino);
    const sendOpts = extras.options || {};

    for (const id of ids) {
        if (await tentar(`sendMessage(${id})`, () => client.sendMessage(id, content, sendOpts))) {
            return true;
        }
    }

    console.error(`[Entrega] Falhou para ${destino} — ${erros.join(' | ') || 'sem tentativas'}`);
    return false;
}

module.exports = {
    entregarMensagem,
    expandirDestinos,
    paresLidPn,
    serializarId
};
