require('dotenv').config();

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Araguaina';
const MYSQL_TIMEZONE = process.env.DB_TIMEZONE || '-03:00';

if (!process.env.TZ) {
    process.env.TZ = APP_TIMEZONE;
}

module.exports = {
    APP_TIMEZONE,
    MYSQL_TIMEZONE
};