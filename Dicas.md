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
git log --oneline -5
pm2 flush hgp-boot
pm2 restart hgp-boot
pm2 logs hgp-boot --lines 80

