# Project Launcher

Source versionnee du launcher manuel expose sur le VPS via `/root/project-launcher`.

Deploiement local sur le VPS:

```bash
rsync -a --delete --exclude node_modules --exclude dist /root/paseo/ops/project-launcher/ /root/project-launcher/
cd /root/project-launcher
npm install
npm run build
systemctl restart project-launcher
```

Le terminal Codex du launcher est destine au diagnostic et a la correction des scripts de lancement. Il ne doit pas modifier le code applicatif des projets cibles.
