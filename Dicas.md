-- PULL  PARA GIT LOCAL
git pull origin main
npm run migrate

-- SUBIR PARA GIT
git add .
git commit -m "Implementação de questionários dinâmicos e override de competência"
git push -u origin main

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
git pull origin main
node scripts/add_bot_user_profiles.js
npm run migrate
git log --oneline -5
sudo -u hgpto env PM2_HOME=/home/hgpto/.pm2 PATH=/home/hgpto/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin /home/hgpto/.nvm/versions/node/v22.22.1/bin/pm2 flush hgp-boot
sudo -u hgpto env PM2_HOME=/home/hgpto/.pm2 PATH=/home/hgpto/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin /home/hgpto/.nvm/versions/node/v22.22.1/bin/pm2 restart hgp-boot --update-env
sudo -u hgpto env PM2_HOME=/home/hgpto/.pm2 PATH=/home/hgpto/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin /home/hgpto/.nvm/versions/node/v22.22.1/bin/pm2 logs hgp-boot --lines 80

-- Se o PM2 não religar sozinho após o pull, use o ecosystem:
pm2 delete hgp-boot
pm2 start ecosystem.config.js
pm2 save



