# DACOT Estoque API

## Contrato de autenticação DACOT-HUB

O identificador do módulo é `inventory` e a audiência é `dacot-estoque`. O HUB emite JWT HS256 com `iss=dacot-hub`, `aud=dacot-estoque`, `module=inventory`, `sub=tenant_user:<id>`, `restaurant_id`, `role`, `hub_access` (versões de usuário/restaurante/módulo), `jti`, `iat`, `nbf`, `exp` e `handoff_version=1`. O prazo máximo é 60 segundos. Apenas os papéis `admin` e `manager` podem entrar.

Na troca de sessão, o backend confere `GET /api/public/tenants/{restaurant_id}/modules/inventory/status` e `POST /api/public/tenants/{restaurant_id}/modules/inventory/access`, ambos com `X-Module-Key`. O segundo endpoint é consultado novamente em cada requisição autenticada e no refresh, para que mudanças de papel, tenant, módulo ou versões revoguem as sessões. O Hub deriva restaurante e usuário da sessão autenticada; o frontend nunca escolhe esses identificadores nem recebe uma chave de serviço.

O `jti` é consumido em transação MongoDB e não pode ser reutilizado. A sessão fica em cookie HttpOnly, Secure e SameSite=None em produção, com prefixo `__Host-`, sem atributo Domain e vinculada ao identificador da aba.

## Rodar localmente

Na raiz do repositório:

```powershell
py -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements-dev.txt
Copy-Item backend/.env.example backend/.env
Set-Location backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check: `GET /health` (confirma MongoDB e configuração segura do Hub; responde 503 enquanto a autenticação não estiver configurada). OpenAPI: `/docs`.

## Render — Web Service `DACOT-ESTOQUE-BACKEND`

- **Root Directory:** `backend`
- **Runtime:** Python 3
- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Health Check Path:** `/health`

Variáveis necessárias:

- `ENVIRONMENT=production`
- `MONGODB_URI` — URI privada do cluster de teste/produção no MongoDB Atlas.
- `MONGODB_DATABASE=dacot_estoque`
- `HANDOFF_JWT_SECRET` — segredo HS256 compartilhado com o Hub, só no backend; mínimo 32 caracteres. Solicitar/provisionar pelo processo seguro do Hub.
- `HANDOFF_ISSUER=dacot-hub`
- `HANDOFF_AUDIENCE=dacot-estoque`
- `HUB_BASE_URL` — origem HTTPS da API do Hub, sem sufixo `/api`.
- `HUB_MODULE_KEY` — valor da chave de serviço independente provisionada para `inventory`; nunca usar a chave de Pedidos.
- `CORS_ORIGINS` — uma ou mais origens HTTPS exatas do Static Site, separadas por vírgulas; sem curingas, caminhos ou credenciais.

O Atlas precisa permitir conexão de rede do Render e suportar transações em replica set. Não use URI de produção em testes. Nunca exponha essas variáveis como `VITE_*`.

Para cookies entre origens, o frontend usa `credentials: include` e o backend permite credenciais somente para `CORS_ORIGINS`. O cookie de produção usa `SameSite=None; Secure`. Para reduzir bloqueios de cookies de terceiros nos navegadores, prefira publicar a API em domínio personalizado sob `dacot.com.br` (por exemplo, `api-estoque.dacot.com.br`) e validar o fluxo no navegador real.

## API disponível

- `POST /api/v1/auth/session/exchange`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/me`.
- `GET/POST /api/v1/ingredients`, `GET/PATCH /api/v1/ingredients/{id}`.
- `GET/POST /api/v1/suppliers`.
- `GET/POST /api/v1/purchases`, `GET /api/v1/purchases/{id}`, `POST /api/v1/purchases/{id}/request|cancel|receipts`.
- `POST /api/v1/ingredients/{id}/movements`, `GET /api/v1/ingredients/{id}/movements`, `GET /api/v1/movements`.
- `GET /api/v1/recipes`, `PUT /api/v1/recipes/{product_id}`.
- `GET /health` (ping real ao MongoDB).

Cada busca/escrita de domínio inclui o restaurante do principal autenticado. Entradas/saídas, compras e recebimentos guardam ator, motivo, preço, referência, horário e saldo posterior. Gravações de saldo com movimento, criação de compra, recebimento e consumo de handoff usam transações. Chaves de idempotência têm índices únicos escopados por restaurante. Saídas e conversões são validadas no servidor. Valores monetários são centavos inteiros.

## Frontend separado

Static Site existente: **Root Directory:** raiz do repositório; **Build Command:** `npm ci && npm run build`; **Publish Directory:** `dist`.

Defina `VITE_API_BASE_URL=https://<origem-do-backend>` no build do Static Site, usando somente a origem do backend, sem `/api/v1`. O build Vite de produção já força o modo real; se a variável estiver ausente, o app falha fechado em vez de usar dados de demonstração. `VITE_APP_MODE=production` pode ser definido para deixar a intenção explícita, mas não é necessário. A origem correspondente precisa constar exatamente em `CORS_ORIGINS` no backend. Nenhum segredo ou token de sessão fica em variáveis do frontend; a sessão usa cookie HttpOnly e header de vínculo de aba.

Como o app usa React Router no navegador, configure no Static Site a regra de rewrite `/*` para `/index.html` com ação `Rewrite`, para que rotas internas funcionem ao abrir ou atualizar diretamente uma URL.

Para uma primeira publicação controlada, mantenha o Auto-Deploy do Static Site desligado. Configure e publique primeiro o backend, espere `/health` ficar saudável e valide o handoff com o restaurante de teste no HUB. Só então publique manualmente o Static Site com `VITE_API_BASE_URL` correto. Após validar o fluxo completo, o Auto-Deploy pode ser habilitado conscientemente em cada serviço. O estado real dessas opções deve ser conferido na página Settings de cada serviço no Render.

## Lacunas antes de produção

1. Configurar o HUB para liberar `inventory` e ativá-lo manualmente apenas para o restaurante de teste. As variáveis `INVENTORY_MODULE_ENABLED` e `INVENTORY_MODULE_KEY` pertencem ao HUB; a origem do Estoque deve estar na allowlist `HANDOFF_ALLOWED_ORIGINS_JSON`.
2. Configurar as variáveis privadas do Web Service e `CORS_ORIGINS` no Render; nenhum segredo deve ir ao Static Site.
3. Executar um handoff real no ambiente publicado. Os testes locais validam JWT, troca de cookie, endpoint de autorização e revogação mockados, mas não substituem a conexão com o HUB hospedado.
4. Contagens, perdas e histórico de snapshots de fichas técnicas ainda não estão persistidos pela API; essas operações permanecem bloqueadas no modo de produção.
