# DACOT Estoque API

## Contrato de autenticação DACOT-HUB

O identificador do módulo é `inventory` e a audiência é `dacot-estoque`. O HUB emite JWT HS256 com `iss=dacot-hub`, `aud=dacot-estoque`, `module=inventory`, `sub=tenant_user:<id>`, `restaurant_id`, `role`, `hub_access` (versões de usuário/restaurante/módulo), `jti`, `iat`, `nbf`, `exp` e `handoff_version=1`. O prazo máximo é 60 segundos. Apenas os papéis `admin` e `manager` podem entrar.

Na troca de sessão, o backend confere `GET /api/public/tenants/{restaurant_id}/modules/inventory/status` e `POST /api/public/tenants/{restaurant_id}/modules/inventory/access`, ambos com `X-Module-Key`. O segundo endpoint é consultado novamente em cada requisição autenticada e no refresh, para que mudanças de papel, tenant, módulo ou versões revoguem as sessões. O Hub deriva restaurante e usuário da sessão autenticada; o frontend nunca escolhe esses identificadores nem recebe uma chave de serviço.

O `jti` é consumido em transação MongoDB e não pode ser reutilizado. A sessão fica em cookie HttpOnly, Secure e SameSite=Lax em produção, com prefixo `__Host-`, sem atributo Domain e vinculada ao identificador da aba.

## Rodar localmente

Na raiz do repositório. A API exige um MongoDB em replica set (mesmo com um único nó), pois mutações de estoque usam transações. MongoDB standalone não é suportado. O `.env.example` usa o nome local `rs0`; configure um MongoDB local em replica set ou use uma instância de teste do Atlas.

```powershell
py -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements-dev.txt
Copy-Item backend/.env.example backend/.env
Set-Location backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check: `GET /health` (confirma conectividade com MongoDB, suporte a transações e configuração do Hub). A API recusa inicialização se o Atlas/MongoDB não anunciar replica set ou cluster sharded; se o banco ficar indisponível após a inicialização, `/health` retorna 503. Em produção, também recusa inicialização sem configuração de autenticação do HUB. O health check não consulta o HUB em nome de um restaurante: se o HUB estiver indisponível, o serviço pode permanecer saudável para o Render, mas handoff, refresh e requisições autenticadas falham fechados com 503 até o HUB voltar. OpenAPI: `/docs`.

### Testes de integração MongoDB

A suíte de integração cria um banco aleatório com prefixo `dacot_estoque_tests_` e o apaga ao final. Para habilitá-la, configure `MONGODB_TEST_URI` para um MongoDB **exclusivo de testes**, `MONGODB_TEST_ALLOW_DB_CREATE_DROP=YES` como confirmação explícita e execute `python -m pytest -q`. Use um usuário MongoDB separado, com acesso limitado aos bancos de teste; nunca use a URI de produção. A suíte recusa iniciar se `MONGODB_TEST_URI` for igual a `MONGODB_URI`. Sem essas variáveis, os testes de integração são ignorados e os testes unitários continuam executando.

## Render — Web Service `DACOT-ESTOQUE-BACKEND`

- **Root Directory:** `backend`
- **Runtime:** Python 3
- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Health Check Path:** `/health`

Variáveis necessárias:

- `ENVIRONMENT=production`
- `MONGODB_URI` — URI privada do cluster de teste/produção no MongoDB Atlas; precisa suportar transações (replica set ou cluster sharded) e MongoDB 5.0 ou superior (`$setWindowFields` mantém as duas últimas cotações válidas por fornecedor/insumo sem carregar todo o histórico em memória).
- `MONGODB_DATABASE=dacot_estoque`
- `HANDOFF_JWT_SECRET` — segredo HS256 compartilhado com o Hub, só no backend; mínimo 32 caracteres. Solicitar/provisionar pelo processo seguro do Hub.
- `HANDOFF_ISSUER=dacot-hub`
- `HANDOFF_AUDIENCE=dacot-estoque`
- `HUB_BASE_URL` — origem HTTPS da API do Hub, sem sufixo `/api`.
- `HUB_MODULE_KEY` — valor da chave de serviço independente provisionada para `inventory`; nunca usar a chave de Pedidos.
- `CORS_ORIGINS` — uma ou mais origens HTTPS exatas do Static Site, separadas por vírgulas; sem curingas, caminhos ou credenciais.

O Atlas precisa permitir conexão de rede do Render e suportar transações em replica set. Não use URI de produção em testes. Nunca exponha essas variáveis como `VITE_*`.

Para cookies entre origens, o frontend usa `credentials: include` e o backend permite credenciais somente para `CORS_ORIGINS`. Em produção, o cookie usa `SameSite=Lax; Secure`. Configure o Web Service com domínio personalizado sob `dacot.com.br` (por exemplo, `api-estoque.dacot.com.br`) antes do login real; `estoque.dacot.com.br` e `api-estoque.dacot.com.br` são origens distintas, mas pertencem ao mesmo site HTTPS, então o cookie host-only da API é enviado em chamadas autenticadas sem depender de cookies de terceiros. Não use a URL `onrender.com` como `VITE_API_BASE_URL` no ambiente real com este cookie. Valide o handoff em navegador real, inclusive com bloqueio de cookies de terceiros ativado.

## API disponível

- `GET /api/v1/ingredients/by-ids?ids=...` resolve até 100 ingredientes por requisição, deduplica IDs e sempre filtra pelo restaurante autenticado. A interface usa a rota para carregar em lote os ingredientes já vinculados a uma ficha técnica.

- `POST /api/v1/auth/session/exchange`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/me`.
- `GET/POST /api/v1/ingredients`, `GET/PATCH /api/v1/ingredients/{id}`. A criação exige `Idempotency-Key` e repete a resposta do mesmo cadastro quando chave e payload coincidem; uma chave reutilizada com payload diferente retorna HTTP 409. A chave e o ingrediente são gravados na mesma transação, incluindo o movimento de saldo inicial. Atualizações exigem `expected_version` e avançam a versão inteira monotônica por compare-and-set; requisições sem versão são rejeitadas. Conflitos retornam HTTP 409. Listagem: `limit` (1–500, default 500), `offset` (default 0), `low_stock`, `active_only` (inclui legados sem campo `active`), `search` (trecho do nome, categoria ou fornecedor), `category`, `status` (`normal`, `near_minimum`, `attention`, `critical`, `empty`, `needs-attention`) e `sort` (`name`, `quantity_asc`, `updated_desc`, `cost_desc`, `priority`, `value_desc`). “Próximo do mínimo” indica saldo entre 100% e 125% do mínimo; abaixo de 50% é crítico, entre 50% e 100% é atenção, e saldo zero é sem estoque. Os filtros são aplicados na consulta Mongo já escopada ao restaurante autenticado, incluindo a busca de fornecedor. A ordenação por saldo usa a quantidade em milésimos e fallback para documentos legados que ainda armazenam apenas `current_quantity`. A tela de estoque carrega páginas incrementais e consulta busca, filtros e ordenação no servidor. Dashboard e alguns fluxos do AppStore ainda dependem do estado completo carregado.
- `GET /api/v1/inventory-insights` retorna total do catálogo, valor conhecido em estoque, itens sem custo e contagem por situação do saldo, usando agregação Mongo escopada ao restaurante autenticado. A rota não retorna documentos de ingredientes. A listagem de insumos também aceita `include_summary=true`; nesse modo responde com `items`, total e valor conhecido/itens sem custo do mesmo filtro, em um `$facet` Mongo, mantendo o formato array padrão para clientes existentes.
- `GET/POST /api/v1/suppliers`, `GET /api/v1/suppliers/{id}`, `GET /api/v1/suppliers/by-ids`, `PATCH /api/v1/suppliers/{id}` (edição e desativação lógica). A listagem aceita `limit`/`offset`, `include_inactive` e busca por prefixo do nome; a tela lista páginas de 50 fornecedores e busca no servidor. A resolução por IDs aceita até 100 valores e sempre os restringe ao restaurante autenticado. A carga inicial resolve somente fornecedores ligados a insumos e movimentos carregados; listas, busca e opções de formulário consultam o catálogo sob demanda. A criação exige `Idempotency-Key`, com replay do mesmo cadastro apenas para payload idêntico e isolamento por restaurante. Atualizações exigem `expected_version` e usam compare-and-set por versão monotônica, retornando HTTP 409 para uma versão desatualizada; requisições sem versão são rejeitadas.
- `GET/POST /api/v1/purchases`, `GET/PUT /api/v1/purchases/{id}`, `GET /api/v1/purchase-insights`, `POST /api/v1/purchases/{id}/request|cancel|receipts`, `GET /api/v1/purchases/{id}/receipts` e `POST /api/v1/purchases/{id}/receipts/{receipt_id}/reversal`. A listagem aceita filtros tenant-scoped `status` e `supplier_id`, além de `limit`/`offset`; a tela de Compras busca 50 linhas por página e preserva contadores completos. O resumo agregado fornece status, total esperado no mês e métricas de recebimento por fornecedor sem baixar a coleção na inicialização. Compras têm versão inteira monotônica, avançada em edição, transição, recebimento e estorno; edição exige rascunho e `expected_version`, e o recebimento verifica a versão enviada para rejeitar formulários desatualizados antes de alterar o saldo. Tanto a edição quanto o recebimento exigem `expected_version`; tokens ausentes são rejeitados e versões desatualizadas não alteram o saldo. Repetir uma transição já concluída retorna o estado atual sem incrementar versão ou duplicar auditoria; retries de recebimento com a mesma chave retornam o resultado original. Alterações e estornos ficam registrados com responsável e horário. O estorno preserva o recebimento original, cria saída compensatória e só é permitido quando o saldo disponível suporta a reversão.
- As respostas de recebimento e estorno incluem `purchase`, `ingredients`, `movements`, `recipes` e `recipe_snapshots` afetados, todos filtrados pelo restaurante autenticado. Isso permite reconciliar o estado financeiro/operacional confirmado pelo backend sem recarregar todas as coleções; retries da mesma chave retornam o estado canônico daquela operação.
- `POST /api/v1/ingredients/{id}/movements`, `GET /api/v1/ingredients/{id}/movements`, `GET /api/v1/movements`. Ajustes manuais exigem `expected_balance` igual ao saldo que o operador viu; se o saldo mudou, retornam HTTP 409. As listagens de movimentos usam `limit` (1–500, default 500) e `offset` (default 0).
- `GET /api/v1/movement-insights` entrega até 100 movimentos recentes e as duas últimas compras válidas por combinação de ingrediente/fornecedor para montar ofertas. Não envia o histórico completo de compras na carga inicial. `GET /api/v1/ingredients/{id}/price-history` carrega, somente ao abrir o detalhe do insumo, até seis preços recentes e o resumo exato da variação dos últimos 120 dias; compras estornadas e fornecedores inexistentes são excluídos. As consultas são filtradas pelo restaurante autenticado. O detalhe também pagina o ledger completo sob demanda; a busca global usa `GET /api/v1/search` com resultados limitados.
- `GET /api/v1/recipes`, `GET /api/v1/recipes/snapshots`, `PUT /api/v1/recipes/{product_id}`, `PATCH /api/v1/recipes/{product_id}/status`. The recipe and snapshot lists accept optional tenant-scoped `ingredient_id` filters; snapshots also accept `product_id` for loading one recipe's history. A recipe body may set `yield_portions` (integer 1–10,000; omitted legacy values mean 1). Ingredient quantities describe the full batch; sale price and `cost_cents` snapshots are per portion, and snapshots also retain exact `batch_cost_cents` plus the yield used. Formula/status updates require `expected_version`; automatic cost snapshots also increment the recipe version. Deactivation preserves recipe composition and snapshots, creates an audit event, and does not get undone by subsequent formula edits.
- `GET /api/v1/recipe-insights` summarizes active count, complete latest-snapshot costs, average food-cost ratio and products above the 35% threshold. `GET /api/v1/recipes/{product_id}` returns one recipe only from the authenticated restaurant. The frontend loads the recipe catalog by 50-item pages and hydrates only the ingredients referenced by each page.
- `GET /api/v1/search?q=...` returns a bounded set of cross-entity matches for the global search, always scoped to the authenticated restaurant. It searches stock, suppliers, recipes, purchases, counts, losses and movements without loading entire collections into the browser.
- `GET /api/v1/ingredients/count-candidates` retorna candidatos paginados e contagens exatas para abertura de inventário (`selection_mode=all|low|category`, busca, categoria, inclusões e exclusões). `POST /api/v1/counts` aceita a seleção filtrada; a API resolve os IDs e congela os saldos dentro da transação, com limite de 500 itens. Itens inativos com saldo continuam elegíveis para contagem e podem ser reconciliados na aprovação, sem reativação.
- `GET /api/v1/counts?limit=50&offset=0`, `GET /api/v1/counts/{id}`, `GET /api/v1/count-insights`, `POST /api/v1/counts`, `PATCH /api/v1/counts/{id}/lines/{ingredient_id}`, `POST /api/v1/counts/{id}/approve`. A lista é tenant-scoped e paginada; o resumo agrega quantidades e impacto histórico no Mongo, e a consulta individual retorna 404 para IDs de outro restaurante. A carga inicial do frontend não baixa todas as sessões. A aprovação congela impacto financeiro, completude de custo e valores esperado/contado por linha; movimentos de correção guardam o custo unitário observado na aprovação. A resposta da aprovação inclui os movimentos gerados, com saldos resultantes, para reconciliar a interface sem recarregar todas as coleções. O histórico não é recalculado com custos atuais. Divergências seguem precisão de 0,001 unidade e os valores usam centavos arredondados meio para cima; linhas sem custo ficam explicitamente sem valoração.
- `GET/POST /api/v1/losses`, `GET /api/v1/losses/{id}` e `GET /api/v1/losses/month?reason=...&limit=50&offset=0`. A tela usa a consulta mensal paginada e o filtro validado de motivo; o foco por ID sempre busca no tenant autenticado e retorna 404 quando o registro não pertence ao restaurante. A criação retorna a perda e seu movimento auditável com o saldo resultante.
- `GET /api/v1/operational-insights` inclui totais mensais por motivo e o insumo precificado com maior impacto, calculados sobre snapshots da perda no Mongo e isolados pelo restaurante autenticado.
- `GET /api/v1/audit?limit=100&cursor=...` — combina eventos append-only e fontes legadas em páginas de até 500 (`items`, `has_more`, `next_cursor`), com cursor estável por data/ID e escopo do restaurante autenticado.
- `GET /health` (ping, detecção de suporte transacional e validação de configuração de autenticação).

Cada busca/escrita de domínio inclui o restaurante do principal autenticado. Entradas/saídas, compras e recebimentos guardam ator, motivo, preço, referência, horário e saldo posterior. Gravações de saldo com movimento, criação de ingrediente/fornecedor/compra, recebimento e consumo de handoff usam transações. Chaves de idempotência têm índices únicos escopados por restaurante; cadastros de ingrediente e fornecedor exigem a chave no endpoint e guardam o fingerprint do payload para reconhecer retries sem duplicar auditoria ou saldo inicial. Saídas e conversões são validadas no servidor. Valores monetários são centavos inteiros.

Listagem de ingredientes, fornecedores e movimentos também aceita `limit` (até 500) e `offset`; todas as páginas são filtradas pelo restaurante autenticado. A inicialização busca ingredientes, fichas, fornecedores referenciados por insumos/movimentos, contagens, perdas, auditoria recente e resumos agregados; não baixa todo o catálogo de fornecedores, todas as compras nem o histórico completo de snapshots. `GET /api/v1/purchase-insights` fornece contagens por status, total esperado e quantidade de pedidos não cancelados no mês (horário de Brasília), além de contagem, valor efetivamente recebido nos últimos 90 dias e última entrega por fornecedor. A lista de fornecedores, os seletores de formulário e a busca global consultam o catálogo sob demanda. A lista de Compras consulta páginas de 50 registros filtradas por status; o histórico do fornecedor também usa páginas sob demanda, e a busca global carrega compras somente quando aberta e consultada. O detalhe de compra e os formulários de edição/recebimento buscam um pedido pelo ID se ele ainda não estiver no AppStore. O detalhe busca somente o histórico da ficha aberta, e alterações de custo/conversão buscam fichas e snapshots ligados ao insumo alterado. A tela de estoque já consulta a API sob demanda e carrega páginas incrementais. Cadastro/edição de insumos e fornecedores, movimentos manuais/estornos, perdas, criação/edição/transição/recebimento/estorno de compras, início/aprovação de contagens e alterações de fichas aplicam registros canônicos do servidor ao AppStore e atualizam somente a auditoria recente. Aprovação de contagem e perda retornam os movimentos e saldos gerados; recebimento e estorno retornam compra, ingredientes, movimentos e fichas/snapshots afetados, além de recompor o histórico de preços a partir dos movimentos canônicos. Edição de linha atualiza a sessão de contagem. A auditoria carrega uma página recente na inicialização e busca páginas anteriores sob demanda nos detalhes de insumo e compra.

Eventos novos de movimentos manuais, perdas, criação/edição/estado/recebimento/estorno de compras, início/edição/aprovação de contagens, snapshots de fichas e criação/edição de ingredientes/fornecedores são inseridos em `audit_events` dentro da mesma transação da operação, com índice por restaurante e data. Os documentos de origem guardam referências aos eventos para evitar duplicação no feed. O feed usa cursor estável de data/ID e resposta limitada. Para tenants ainda não migrados, fontes legadas são varridas e mescladas para preservar o histórico. Após o backfill marcar `audit_migrations.status=complete`, a leitura passa a consultar apenas `audit_events` com o índice temporal. O comando administrativo é retomável/idempotente e não é executado automaticamente pela API.

### Migração do histórico legado de auditoria

O comando abaixo faz primeiro uma contagem sem escrita, limitada ao restaurante explicitamente informado:

```powershell
Set-Location backend
python -m app.audit_migration --restaurant-id <RESTAURANT_ID> --batch-size 250
```

Para aplicar em ambiente local/homologação, use `--apply`. O comando é retomável e idempotente; só marca o tenant como concluído depois de percorrer todo o feed. Quando executado com `ENVIRONMENT=production`, também exige `--allow-production`. Confira a contagem e faça backup operacional antes de uma execução de escrita em qualquer ambiente compartilhado. Nenhuma migração é executada automaticamente na inicialização da API.

Saldos, quantidades recebidas, contagens e movimentos usam milésimos inteiros da unidade como representação autoritativa (`*_milli`). A resolução é 0,001 unidade e valores convertidos são arredondados para o milésimo mais próximo, meio milésimo para cima. O mínimo também recebe representação inteira ao criar ou editar o ingrediente. Campos numéricos tradicionais permanecem nas respostas por compatibilidade com o frontend; documentos legados sem `current_quantity_milli` são normalizados na primeira movimentação. A interface exibe até três casas decimais.

Conversões comerciais são configuradas no ingrediente como `conversions: {"caixa": 12}`; o fator significa 12 unidades-base por uma caixa. Os rótulos são normalizados para minúsculas e não podem substituir `g`, `kg`, `ml`, `l` ou `un`. Compras usam a conversão validada no momento da criação do rascunho; o fator fica congelado na linha e é reutilizado no recebimento, mesmo se o cadastro do ingrediente mudar depois. Mudanças de conversão aplicam-se a novas compras. O cliente limita a 20 rótulos personalizados por ingrediente.

O custo atual do ingrediente usa custo médio ponderado móvel em unidade-base ao receber mercadoria. O histórico mantém o preço efetivamente pago na unidade de compra, o custo normalizado para a unidade-base, fornecedor e referência da compra. Arredondamento do custo médio: centavo mais próximo, meio centavo arredondado para cima. Não são estimados impostos, fretes ou outros custos não informados.

Custos de fichas técnicas arredondam cada linha para centavos inteiros usando `ROUND_HALF_UP`; o total é a soma dessas linhas para coincidir com os valores exibidos. O frontend calcula a conversão e o arredondamento com razões decimais e aplica a mesma política.

## Frontend separado

Static Site existente: **Root Directory:** raiz do repositório; **Build Command:** `npm ci && npm run build`; **Publish Directory:** `dist`.

Defina `VITE_API_BASE_URL=https://<origem-do-backend>` no build do Static Site, usando somente a origem do backend, sem `/api/v1`. O build Vite de produção já força o modo real; se a variável estiver ausente, o app falha fechado em vez de usar dados de demonstração. `VITE_APP_MODE=production` pode ser definido para deixar a intenção explícita, mas não é necessário. A origem correspondente precisa constar exatamente em `CORS_ORIGINS` no backend. Nenhum segredo ou token de sessão fica em variáveis do frontend; a sessão usa cookie HttpOnly e header de vínculo de aba.

Como o app usa React Router no navegador, configure no Static Site a regra de rewrite `/*` para `/index.html` com ação `Rewrite`, para que rotas internas funcionem ao abrir ou atualizar diretamente uma URL.

Para uma primeira publicação controlada, mantenha o Auto-Deploy do Static Site desligado. Configure e publique primeiro o backend; só prossiga quando `/health` estiver saudável. Em seguida, publique manualmente o Static Site com `VITE_API_BASE_URL` correto e execute o roteiro de homologação com o restaurante de teste no HUB antes de liberar qualquer piloto. Assim, o frontend não é publicado antes da API estar operacional e o handoff é validado no navegador real. Após validar o fluxo completo, o Auto-Deploy pode ser habilitado conscientemente em cada serviço. O estado real dessas opções deve ser conferido na página Settings de cada serviço no Render.

## Lacunas antes de produção

O roteiro controlado com pré-requisitos, passos de autenticação, persistência, isolamento e revogação está em [`docs/HOMOLOGACAO_RENDER_HUB.md`](../docs/HOMOLOGACAO_RENDER_HUB.md). Use somente ambiente e restaurante de teste.

1. Configurar o HUB para liberar `inventory` e ativá-lo manualmente apenas para o restaurante de teste. As variáveis `INVENTORY_MODULE_ENABLED` e `INVENTORY_MODULE_KEY` pertencem ao HUB; a origem do Estoque deve estar na allowlist `HANDOFF_ALLOWED_ORIGINS_JSON`.
2. Configurar as variáveis privadas do Web Service e `CORS_ORIGINS` no Render; nenhum segredo deve ir ao Static Site.
3. Executar um handoff real no ambiente publicado. Os testes locais validam JWT, troca de cookie, endpoint de autorização e revogação mockados, mas não substituem a conexão com o HUB hospedado.
4. Contagens, perdas e histórico de snapshots de fichas técnicas são persistidos localmente e testados em replica set. A persistência hospedada e o handoff real ainda precisam de homologação controlada.
