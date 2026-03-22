require('dotenv').config();
const db = require('../config/database');

async function syncContacts() {
    try {
        console.log('🔄 Sincronizando contatos das mensagens...\n');

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

        console.log(`📊 Encontrados ${messages.length} números únicos nas mensagens\n`);

        let synced = 0;
        let updated = 0;
        let created = 0;

        for (const msg of messages) {
            const [result] = await db.query(`
                INSERT INTO contacts (phone_number, contact_name, first_message_at, last_message_at, message_count)
                VALUES (?, NULL, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    first_message_at = LEAST(first_message_at, VALUES(first_message_at)),
                    last_message_at = GREATEST(last_message_at, VALUES(last_message_at)),
                    message_count = VALUES(message_count)
            `, [msg.phone_number, msg.first_message, msg.last_message, msg.msg_count]);

            if (result.affectedRows === 1) {
                created++;
                console.log(`✓ Novo contato: ${msg.phone_number} (${msg.msg_count} mensagens)`);
            } else if (result.affectedRows === 2) {
                updated++;
                console.log(`↻ Atualizado: ${msg.phone_number} (${msg.msg_count} mensagens)`);
            }

            synced++;
        }

        console.log(`\n✅ Sincronização concluída!`);
        console.log(`   Total processado: ${synced}`);
        console.log(`   Novos contatos: ${created}`);
        console.log(`   Atualizados: ${updated}`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Erro ao sincronizar contatos:', error);
        process.exit(1);
    }
}

syncContacts();
