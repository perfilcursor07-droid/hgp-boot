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
cd /home/hgpto/htdocs/hgpto.shop
git pull origin main
node scripts/add_bot_user_profiles.js
npm run migrate
git log --oneline -5
pm2 flush hgp-boot
pm2 restart hgp-boot --update-env
pm2 logs hgp-boot --lines 80

-- Se o PM2 não religar sozinho após o pull, use o ecosystem:
pm2 delete hgp-boot
pm2 start ecosystem.config.js
pm2 save



