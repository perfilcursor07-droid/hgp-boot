const mysql = require('mysql2/promise');
const { MYSQL_TIMEZONE } = require('./timezone');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'whatsapp_admin',
    timezone: MYSQL_TIMEZONE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const poolEventSource = pool.pool && typeof pool.pool.on === 'function'
    ? pool.pool
    : (typeof pool.on === 'function' ? pool : null);

if (poolEventSource) {
    poolEventSource.on('connection', (connection) => {
        connection.query(`SET time_zone = '${MYSQL_TIMEZONE}'`, (error) => {
            if (error) {
                console.error('Erro ao definir fuso horário da sessão MySQL:', error.message);
            }
        });
    });
}

module.exports = pool;
