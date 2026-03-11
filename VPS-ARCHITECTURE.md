# VPS - Documentation complète

> Dernière mise à jour : 2026-03-05

## Infos générales

| Clé | Valeur |
|-----|--------|
| Hostname | `srv1019093` (Hostinger VPS) |
| OS | Ubuntu 22.04.5 LTS (Jammy Jellyfish) |
| Kernel | 5.15.0-153-generic |
| Virtualisation | KVM (QEMU) |
| IPv4 publique | `92.113.26.116` |
| IPv6 publique | `2a02:4780:28:7e1d::1` |
| Port SSH | **2222** (non-standard) |
| User principal | `lambert` (`/home/lambert`) |

## Ressources

| Ressource | Détail |
|-----------|--------|
| CPU | 2 vCores |
| RAM | 7.8 GiB total (~5 GiB disponible) |
| Disque | 97 GB total, 19 GB utilisés (79 GB libres) |
| Swap | Aucun |

---

## Architecture réseau

### Interfaces
- `eth0` → IP publique `92.113.26.116/24`
- `wg0` → WireGuard VPN `10.0.0.1/24`
- `br-d0dbb8ef52a1` → réseau Docker `web` (`172.18.0.1/16`)
- `br-898aaa6bc0e6` → réseau Docker `apps_internal` (`172.19.0.1/16`)

### Ports ouverts (publics)
- `80` → Traefik (HTTP, redirige vers HTTPS)
- `443` → Traefik (HTTPS)
- `2222` → SSH

### Ports accessibles via VPN uniquement (10.0.0.1)
| Port | Service |
|------|---------|
| `5050` | PgAdmin4 |
| `5678` | n8n |
| `3001` | Uptime Kuma |
| `3000` | Puppeteer service |
| `8080` | Traefik Dashboard |
| `8081` | Redis Commander |

---

## Reverse Proxy : Traefik

- **Image** : `traefik:latest`
- **Config** : `/home/lambert/apps/traefik/traefik.yml`
- **Certificats** : DNS Challenge via **Cloudflare** (email: `lambertheo@gmail.com`)
- **Stockage certs** : `/home/lambert/apps/traefik/ssl/acme.json`
- **Entrypoints** :
  - `web` (80) → redirige automatiquement vers `websecure`
  - `websecure` (443)
- **Dashboard** : accessible uniquement via VPN sur `10.0.0.1:8080`

### Ajouter un nouveau service à Traefik
Le service doit être dans le réseau Docker `web` et avoir ces labels :
```yaml
networks:
  - web

labels:
  - "traefik.enable=true"
  - "traefik.http.routers.MON_APP.rule=Host(`mon-domaine.com`)"
  - "traefik.http.routers.MON_APP.entrypoints=websecure"
  - "traefik.http.routers.MON_APP.tls=true"
  - "traefik.http.routers.MON_APP.tls.certresolver=cloudflare"
  - "traefik.http.services.MON_APP.loadbalancer.server.port=PORT_INTERNE"
  # Redirection HTTP→HTTPS
  - "traefik.http.middlewares.MON_APP-https.redirectscheme.scheme=https"
  - "traefik.http.middlewares.MON_APP-https.redirectscheme.permanent=true"
  - "traefik.http.routers.MON_APP-http.rule=Host(`mon-domaine.com`)"
  - "traefik.http.routers.MON_APP-http.entrypoints=web"
  - "traefik.http.routers.MON_APP-http.middlewares=MON_APP-https"
```

---

## Réseaux Docker

| Réseau | Type | Usage |
|--------|------|-------|
| `web` | bridge externe | Containers exposés via Traefik |
| `internal` | bridge externe | Containers internes (pas exposés) |
| `pricewatch_default` | bridge local | PriceWatch (isolé) |

Les deux réseaux `web` et `internal` sont **externes** → ils existent déjà, ne pas les recréer dans un nouveau compose.

---

## Applications en production

Toutes les apps sont définies dans `/home/lambert/apps/docker-compose.yml`.

### Infrastructure partagée

| Container | Image | Réseau | Notes |
|-----------|-------|--------|-------|
| `traefik` | `traefik:latest` | `web` | Reverse proxy |
| `postgres` | `postgres:15` | `internal` | BDD partagée entre apps |
| `puppeteer-service` | custom | `internal` | API scraping, VPN only `:3000` |
| `n8n` | `n8nio/n8n:latest` | `internal` | Automations, VPN only `:5678` |
| `uptime-kuma` | `louislam/uptime-kuma:1` | `internal` | Monitoring, VPN only `:3001` |

### Applications web

| App | Container | Domaine | Stack |
|-----|-----------|---------|-------|
| Portfolio | `portfolio` | `theolambert.dev` | React/Vite + Nginx (Docker) |
| RSS App | `rss-app` | `${DOMAIN}` (var .env) | React/Vite + Supabase |
| PriceWatch Frontend | `pricewatch_frontend` | `pricewatch.it.com` | React/Vite |
| PriceWatch Backend | `pricewatch_backend` | `api.pricewatch.it.com` | FastAPI (Python) |
| PriceWatch Celery Worker | `pricewatch_celery_worker` | — | Celery + Redis |
| PriceWatch Celery Beat | `pricewatch_celery_beat` | — | Celery Beat |
| PriceWatch Redis | `pricewatch_redis` | — | Redis 7 Alpine |
| PriceWatch PgAdmin | `pricewatch_pgadmin` | — | VPN only `:5050` |
| PriceWatch Redis Commander | `pricewatch_redis_commander` | — | VPN only `:8081` |

---

## Structure des fichiers

```
/home/lambert/
├── apps/                          # Tous les projets Docker
│   ├── docker-compose.yml         # Compose principal (PROD)
│   ├── .env                       # Variables d'environnement globales
│   ├── traefik/
│   │   ├── traefik.yml            # Config Traefik active
│   │   └── ssl/                   # Certificats ACME (acme.json)
│   ├── PriceWatch/                # App PriceWatch
│   │   ├── Backend/               # FastAPI
│   │   ├── Frontend/              # React/Vite
│   │   ├── docker-compose.yml     # Dev local
│   │   └── docker-compose.prod.yml
│   ├── portfolio-sparkling-portal/ # Portfolio perso (React/Vite)
│   ├── rss-supabase-horizon/      # App RSS (React/Vite + Supabase)
│   ├── puppeteer-service/         # Service scraping Node.js
│   ├── n8n/data/                  # Données persistantes n8n
│   ├── monitoring/                # Données Uptime Kuma
│   └── postgres-init/             # Scripts init PostgreSQL
├── data/
│   └── postgres/                  # Volume PostgreSQL partagé
├── backups/                       # Backups auto (7 jours)
├── backup.sh                      # Script backup (cron 2h du matin)
├── backup.log                     # Logs backup
├── logs.sh                        # Script logs
└── restart-all.sh                 # Script restart des containers
```

---

## Base de données PostgreSQL partagée

- **Container** : `postgres` (image `postgres:15`)
- **Réseau** : `internal`
- **Volume** : `../data/postgres` → `/home/lambert/data/postgres`
- **Accès depuis autres containers** : `host=postgres port=5432`
- **Auth** : `POSTGRES_HOST_AUTH_METHOD=trust` (pas de mdp requis en interne)
- **PgAdmin** : `10.0.0.1:5050` (VPN requis)

Pour ajouter une DB à une nouvelle app :
```bash
docker exec postgres psql -U postgres -c "CREATE DATABASE ma_nouvelle_db;"
docker exec postgres psql -U postgres -c "CREATE USER mon_user WITH PASSWORD 'mdp';"
docker exec postgres psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ma_nouvelle_db TO mon_user;"
```

---

## Déploiement d'une nouvelle application

### Checklist
1. Créer le dossier du projet dans `/home/lambert/apps/`
2. Ajouter le service dans `/home/lambert/apps/docker-compose.yml`
3. Le service public → réseau `web` + labels Traefik
4. Le service interne → réseau `internal` (VPN only ou pas d'exposition)
5. Si besoin d'une DB → utiliser le container `postgres` partagé
6. Les DNS du domaine doivent pointer vers `92.113.26.116` via Cloudflare
7. Traefik gère automatiquement les certificats TLS via Cloudflare DNS Challenge
8. Déployer : `docker compose up -d --build NOM_SERVICE`

### Variables d'env
Le fichier `/home/lambert/apps/.env` contient toutes les variables globales (Cloudflare, PostgreSQL, domaines, etc.).

---

## Runtimes installés sur le host

| Outil | Version |
|-------|---------|
| Node.js | v24.12.0 (via nvm) |
| npm | 11.7.0 |
| yarn | 1.22.22 (corepack) |
| pnpm | 10.30.3 (corepack) |
| Python | 3.10.12 |
| Git | 2.34.1 |
| Docker | installé + running |

> Les apps sont containerisées — le runtime host sert principalement au développement local.

---

## Backups

- **Script** : `/home/lambert/backup.sh`
- **Cron** : tous les jours à **02:00**
- **Contenu** : dump PostgreSQL complet + archives n8n + certs Traefik
- **Rétention** : 7 jours
- **Destination** : `/home/lambert/backups/`

---

## Sécurité

- SSH sur port **2222** (non-standard)
- Services admin (n8n, PgAdmin, Uptime Kuma, Redis Commander, Traefik Dashboard) **uniquement accessibles via WireGuard VPN** (interface `wg0`, réseau `10.0.0.0/24`)
- TLS géré par Traefik via Cloudflare DNS Challenge (wildcard possible)
- Pas de ufw actif — la sécurité repose sur le binding des ports sensibles à `10.0.0.1`
