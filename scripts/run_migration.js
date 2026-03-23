require('dotenv').config();
const mysql = require('mysql2/promise');
const { ensureSchema } = require('../config/ensureSchema');

async function runMigration() {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'whatsapp_admin',
            multipleStatements: true
        });

        console.log('✓ Conectado ao banco de dados');

        const changes = await ensureSchema(connection);
        if (changes.length > 0) {
            console.log(`✓ Schema sincronizado com ${changes.length} ajuste(s): ${changes.join(', ')}`);
        } else {
            console.log('✓ Schema já estava atualizado');
        }
        
        console.log('✓ Migration executada com sucesso!');
        console.log('✓ Tabelas criadas/atualizadas: admins, whatsapp_sessions, messages, chamados, contacts, chat_messages');

        await connection.end();
        process.exit(0);
    } catch (error) {
        console.error('✗ Erro ao executar migration:', error.message);
        process.exit(1);
    }
}

runMigration();
