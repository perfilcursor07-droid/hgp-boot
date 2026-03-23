require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/database');

async function createAdmin() {
    const username = process.argv[2] || 'admin';
    const password = process.argv[3] || 'admin123';
    const nomeCompleto = process.argv[4] || 'Administrador';

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await db.query(
            `INSERT INTO admins (username, nome_completo, nivel_acesso, password, ativo)
             VALUES (?, ?, 'administrador', ?, TRUE)
             ON DUPLICATE KEY UPDATE nome_completo = VALUES(nome_completo), nivel_acesso = VALUES(nivel_acesso), password = VALUES(password), ativo = TRUE`,
            [username, nomeCompleto, hashedPassword]
        );

        console.log(`✓ Admin criado/atualizado com sucesso!`);
        console.log(`  Usuário: ${username}`);
        console.log(`  Nome: ${nomeCompleto}`);
        console.log(`  Senha: ${password}`);
        
        process.exit(0);
    } catch (error) {
        console.error('Erro ao criar admin:', error);
        process.exit(1);
    }
}

createAdmin();
