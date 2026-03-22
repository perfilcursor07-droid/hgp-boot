require('dotenv').config();
const db = require('../config/database');

async function testGestores() {
    try {
        console.log('Buscando gestores...\n');
        
        const [gestores] = await db.query(`
            SELECT id, username, nome_completo, telefone, nivel_acesso, ativo
            FROM admins
            WHERE nivel_acesso = 'gestor' AND ativo = TRUE
            ORDER BY nome_completo
        `);

        console.log('Gestores encontrados:', gestores.length);
        console.log(JSON.stringify(gestores, null, 2));

        // Verificar todos os usuários
        console.log('\n\nTodos os usuários:');
        const [todos] = await db.query('SELECT id, username, nome_completo, nivel_acesso, ativo FROM admins');
        console.log(JSON.stringify(todos, null, 2));

        process.exit(0);
    } catch (error) {
        console.error('Erro:', error);
        process.exit(1);
    }
}

testGestores();
