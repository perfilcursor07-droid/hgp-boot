require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/database');

async function createAdmin() {
    const username = process.argv[2] || 'admin';
    const password = process.argv[3] || 'admin123';

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await db.query(
            'INSERT INTO admins (username, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = ?',
            [username, hashedPassword, hashedPassword]
        );

        console.log(`✓ Admin criado/atualizado com sucesso!`);
        console.log(`  Usuário: ${username}`);
        console.log(`  Senha: ${password}`);
        
        process.exit(0);
    } catch (error) {
        console.error('Erro ao criar admin:', error);
        process.exit(1);
    }
}

createAdmin();
