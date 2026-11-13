# Homologação controlada — DACOT-ESTOQUE

Este roteiro valida o primeiro ambiente hospedado sem usar dados de produção e sem habilitar o módulo para todos os restaurantes. Execute as etapas na ordem; pare no primeiro critério reprovado. Não copie valores secretos para arquivos, tickets ou logs.

## 1. Preparar ambiente isolado

- Criar/selecionar um restaurante e usuários de teste no HUB. Usar um usuário `admin` e, se necessário, um `manager`; não usar contas de clientes.
- Manter `inventory` desativado para todos os demais restaurantes. Confirmar o estado inicial `active: false` no endpoint de status do restaurante de teste.
- Usar um banco MongoDB de homologação separado do banco de produção, com replica set ou cluster sharded e usuário próprio. Definir `MONGODB_DATABASE` para o banco de homologação.
- Configurar o Web Service `DACOT-ESTOQUE-BACKEND` com Root Directory `backend`, Build Command `pip install -r requirements.txt`, Start Command `uvicorn app.main:app --host 0.0.0.0 --port $PORT` e Health Check `/health`.
- Definir no backend, pelo painel seguro do Render: `ENVIRONMENT=production`, `MONGODB_URI`, `MONGODB_DATABASE`, `HANDOFF_JWT_SECRET`, `HANDOFF_ISSUER=dacot-hub`, `HANDOFF_AUDIENCE=dacot-estoque`, `HUB_BASE_URL`, `HUB_MODULE_KEY` independente da chave do Pedidos e `CORS_ORIGINS` com a origem HTTPS exata do frontend.
- Associar domínio HTTPS próprio ao backend sob `dacot.com.br` (por exemplo, `api-estoque.dacot.com.br`). O cookie `__Host-` é host-only; não usar o domínio `onrender.com` para homologar o fluxo de navegador com `SameSite=Lax`.
- Configurar o Static Site com Root Directory `/`, Build Command `npm ci && npm run build`, Publish Directory `dist`, rewrite `/*` → `/index.html`, e `VITE_API_BASE_URL` apontando somente para a origem HTTPS do backend. Nenhuma chave, JWT ou segredo deve ser configurado no frontend.
- No HUB, configurar `INVENTORY_MODULE_ENABLED`, `INVENTORY_MODULE_KEY` e `HANDOFF_ALLOWED_ORIGINS_JSON` conforme o contrato vigente do HUB. Incluir somente a origem oficial do Estoque e ativar `inventory` apenas no restaurante de teste.
- Manter Auto-Deploy do Static Site desligado durante a primeira homologação. Publicar o backend primeiro e só usar o frontend após o health check estar saudável.

## 2. Critérios do backend antes do navegador

1. Consultar `GET https://<backend>/health`. Esperado: HTTP 200, conexão Mongo disponível, replica set/cluster compatível com transações e autenticação HUB configurada. HTTP 503 bloqueia a homologação; não contornar removendo a checagem.
2. Para o restaurante de teste, consultar no HUB `GET /api/public/tenants/{restaurant_id}/modules/inventory/status` com a chave do serviço Inventory. Confirmar `active: true` somente para esse restaurante.
3. Confirmar que a allowlist do HUB contém a origem HTTPS exata do Estoque e que o backend tem essa origem em `CORS_ORIGINS`. Não usar `*`, origem de preview ou URL temporária.

## 3. Fluxo de autenticação e isolamento

1. Abrir o HUB e iniciar o DACOT-ESTOQUE pelo handoff normal; não colar JWT em ferramentas, console ou tickets.
2. Confirmar que a tela autenticada carrega e que `GET /api/v1/me` retorna o usuário, papel e restaurante do usuário de teste.
3. No navegador, verificar que o cookie de sessão é `HttpOnly`, `Secure`, `SameSite=Lax`, prefixo `__Host-`, sem `Domain`; o token de handoff não deve persistir no armazenamento do navegador.
4. Tentar o handoff com usuário sem papel permitido e com restaurante sem `inventory` ativo. Esperado: acesso negado, sem sessão criada.
5. Fazer uma requisição autenticada de leitura e uma escrita sem `Origin` autorizado. Esperado: escrita negada; CORS não deve refletir origens arbitrárias.
6. Criar um segundo restaurante de teste sem módulo ativo. Com a sessão do primeiro tenant, tentar acessar um ID conhecido do segundo tenant em uma rota de detalhe. Esperado: HTTP 404/negação sem revelar dados. Não inserir `restaurant_id` manualmente em requisições de negócio.

## 4. Persistência e fluxos essenciais

Use nomes claramente sintéticos, por exemplo `TESTE HOMOLOGACAO - NAO COMPRAR`, e quantidades/valores pequenos. Registre os IDs apenas no registro interno de homologação.

1. Cadastrar ingrediente com custo e unidade conhecidos; conferir que saldo inicial zero não cria entrada fictícia. Criar outro ingrediente somente se necessário para conversão de embalagem.
2. Cadastrar fornecedor de teste e uma compra em rascunho. Recarregar a página e confirmar persistência.
3. Receber parcialmente uma linha com preço explícito. Confirmar saldo, movimento de entrada, custo atualizado e histórico de preço; repetir a mesma operação com a mesma chave de idempotência e confirmar que não duplica saldo nem recibo.
4. Abrir detalhe do ingrediente e conferir ledger, ator, origem, quantidade em unidade-base, saldo e histórico do recebimento.
5. Criar uma saída manual pequena com motivo; confirmar que o saldo diminui e há evento auditável. Tentar uma alteração baseada em saldo/versão antiga e confirmar conflito sem mudança de saldo.
6. Criar, editar e consultar uma ficha técnica com ingrediente de teste; confirmar rendimento, conversão, custo conhecido/desconhecido e snapshot após recarregar.
7. Registrar uma perda e uma contagem de teste, aprovar a contagem e conferir os movimentos corretivos e o impacto congelado. Consultar dashboard e confirmar que os totais refletem as operações canônicas.
8. Confirmar as mesmas entidades diretamente no banco de homologação usando acesso somente leitura e filtros pelo `restaurant_id` de teste. Não executar comandos de limpeza na base real.

## 5. Expiração e revogação

1. Fazer logout pelo produto. Esperado: cookie removido e sessão revogada; chamadas autenticadas subsequentes devem falhar.
2. Em nova sessão de teste, desativar `inventory` para o restaurante no HUB. Fazer uma nova chamada autenticada e um refresh. Esperado: falha fechada e sessão não renovada.
3. Reativar somente o restaurante de teste, fazer novo handoff e confirmar que o fluxo volta a funcionar. Não reutilizar handoff anterior; o `jti` deve ser de uso único e o handoff expira em 60 segundos.
4. Confirmar expiração normal da sessão e que a reautenticação exige novo handoff do HUB.

## 6. Encerramento

- Registrar cada critério como aprovado/reprovado, timestamp, versão do backend/frontend, restaurante de teste e IDs sintéticos; nunca registrar cookies, JWTs, chaves ou URI Mongo.
- Remover os registros sintéticos exclusivamente pelo fluxo suportado do produto, se esse fluxo existir. Caso contrário, manter o restaurante/banco de homologação isolado para limpeza controlada pelo responsável pelo ambiente; não executar limpeza ad hoc no banco de produção.
- Manter o Static Site sem publicação/Auto-Deploy até todos os critérios de autenticação, isolamento, transação e persistência passarem. Qualquer falha de health, sessão, tenant, idempotência ou saldo é bloqueadora para piloto.
- Só considerar a V1 homologada após evidência dos passos acima no navegador e no ambiente hospedado. Os testes locais de API, mocks do HUB e Mongo replica set descartável não substituem esta etapa.
