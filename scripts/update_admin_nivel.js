require('dotenv').config();
const db = require('../config/database');

async function updateAdmin() {
    try {
        console.log('Atualizando nível de acesso do admin...');
        
        await db.query(`
            UPDATE admins 
            SET nivel_acesso = 'administrador'
            WHERE username = 'admin' AND (nivel_acesso IS NULL OR nivel_acesso = '')
        `);
        
        console.log('✓ Admin atualizado com sucesso!');
        process.exit(0);
    } catch (error) {
        console.error('✗ Erro:', error);
        process.exit(1);
    }
}

updateAdmin();
