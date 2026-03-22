require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function runMigration() {
    try {
        // Conectar ao MySQL
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'whatsapp_admin',
            multipleStatements: true
        });

        console.log('✓ Conectado ao banco de dados');

        const migrationsDir = path.join(__dirname, '../migrations');
        const sqlFiles = fs.readdirSync(migrationsDir)
            .filter((file) => file.endsWith('.sql'))
            .sort();

        for (const file of sqlFiles) {
            const sqlFile = path.join(migrationsDir, file);
            const sql = fs.readFileSync(sqlFile, 'utf8');
            await connection.query(sql);
            console.log(`✓ Migration executada: ${file}`);
        }
        
        console.log('✓ Migration executada com sucesso!');
        console.log('✓ Tabelas criadas/atualizadas: admins, whatsapp_sessions, messages, chamados');

        await connection.end();
        process.exit(0);
    } catch (error) {
        console.error('✗ Erro ao executar migration:', error.message);
        process.exit(1);
    }
}

runMigration();
