require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
    try {
        console.log('Testando conexão com MySQL...');
        console.log('Host:', process.env.DB_HOST || 'localhost');
        console.log('User:', process.env.DB_USER || 'root');
        console.log('Database:', process.env.DB_NAME || 'whatsapp_admin');
        
        // Primeiro conectar sem database
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || ''
        });

        console.log('✓ Conectado ao MySQL');

        // Listar databases
        const [databases] = await connection.query('SHOW DATABASES');
        console.log('\nDatabases disponíveis:');
        databases.forEach(db => {
            console.log(' -', db.Database);
        });

        // Verificar se whatsapp_admin existe
        const dbExists = databases.some(db => db.Database === 'whatsapp_admin');
        
        if (!dbExists) {
            console.log('\n✗ Database whatsapp_admin não encontrado!');
            console.log('Criando database...');
            await connection.query('CREATE DATABASE whatsapp_admin');
            console.log('✓ Database whatsapp_admin criado!');
        } else {
            console.log('\n✓ Database whatsapp_admin encontrado!');
        }

        await connection.end();
        process.exit(0);
    } catch (error) {
        console.error('✗ Erro:', error.message);
        process.exit(1);
    }
}

testConnection();
