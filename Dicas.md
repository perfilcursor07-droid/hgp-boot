-- PULL  PARA GIT LOCAL
git pull origin main
npm run migrate

-- SUBIR PARA GIT
git add .
git commit -m "Implementação de questionários dinâmicos e override de competência"
git push -u origin main

-- PULL  PARA GIT PRODUÇÃO
# PULL PARA GIT PRODUÇÃO
cd /home/hgpto/htdocs/hgpto.shop
PM2H="sudo -u hgpto env PM2_HOME=/home/hgpto/.pm2 PATH=/home/hgpto/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin /home/hgpto/.nvm/versions/node/v22.22.1/bin/pm2"

git pull origin main
chown -R hgpto:hgpto /home/hgpto/htdocs/hgpto.shop
node scripts/add_bot_user_profiles.js
npm run migrate
git log --oneline -5

$PM2H restart hgp-boot --update-env
$PM2H save
$PM2H logs hgp-boot --lines 80 --nostream

# Se o PM2 não religar sozinho, recriar A PARTIR DO PM2 DO HGPTO (nunca o do root):
# $PM2H delete hgp-boot
# $PM2H start ecosystem.config.js
# $PM2H save


