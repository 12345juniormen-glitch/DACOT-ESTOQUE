# Verificação direcionada da V1

Base: `main` em `8a5fe9f`. Integração Pedidos permanece fora desta branch. As classificações abaixo refletem o código e os testes locais; não comprovam o ambiente hospedado.

## P0

Nenhuma falha P0 reproduzida nos cenários executados. Isso não é certificação de segurança nem validação de produção.

## P1

- **Corrigido: expiração durante validação no HUB.** Em `principal_from_session` e `refresh_local_session`, a segunda verificação da sessão usava o horário anterior à chamada de rede. Uma sessão com prazo vencido durante a consulta poderia ainda passar na condição de expiração; no refresh poderia ser prorrogada. O backend agora consulta o horário novamente após a resposta do HUB. No handoff, a troca agora recusa o token que venceu durante a consulta antes de criar sessão. Os testes simulam a expiração; a chamada ao HUB continua obrigatória e falha fechada.
- **Pendente: limitação de abuso.** A aplicação não implementa limite próprio nas rotas de autenticação. Em teste local controlado, 100 chamadas inválidas sucessivas para o endpoint de handoff receberam 422 e nenhuma recebeu 429. Isso demonstra ausência de limitação no processo, não comprova exploração ou ausência de proteção no Render. O proprietário precisa verificar e configurar proteção efetiva na borda, com limites adequados, observabilidade e tratamento correto de proxy/IP, antes do piloto; depois repetir teste controlado. Não confiar em cabeçalhos encaminhados livremente pelo cliente.
- **Pendente: backup e recuperação.** Não há evidência no repositório de backup automático ativo nem de restauração testada no Atlas. Executar e registrar o procedimento em [BACKUP_RESTAURACAO.md](BACKUP_RESTAURACAO.md) em ambiente isolado, definindo responsáveis, RPO, RTO e retenção. O plano e recursos do Atlas dependem de confirmação pelo proprietário.
- **Pendente: homologação hospedada.** Confirmar no ambiente de teste o handoff real, revogação e lentidão do HUB, cookies, CORS, isolamento entre restaurantes, persistência após recarga, alertas e monitoramento. O roteiro é [HOMOLOGACAO_RENDER_HUB.md](HOMOLOGACAO_RENDER_HUB.md). Não se infere configuração do Render ou Atlas a partir dos testes locais.

## P2

- `npm audit` identificou duas entradas moderadas relacionadas a `react-router`/`react-router-dom` (avisos GHSA-wrjc-x8rr-h8h6 e GHSA-337j-9hxr-rhxg). A correção sugerida exige mudança de versão principal. Exploração no aplicativo não foi demonstrada; analisar compatibilidade e os caminhos de redirecionamento antes de atualizar.
- `pip-audit` reportou 41 entradas (incluindo duplicatas de identificadores) em `pymongo`, `PyJWT` e dependência transitiva `starlette`. Alguns avisos exigem recursos como JWKS, GridFS, upload multipart ou StaticFiles, cujo uso vulnerável não foi comprovado nesta verificação. Os avisos não equivalem a 41 vulnerabilidades exploráveis neste projeto. É necessário triar todos os avisos e atualizar versões compatíveis em mudança específica com testes completos; não presumir ausência de impacto a partir de uma amostra.
- As rotas existentes oferecem formulários e tentativas de recuperação para erros de rede; nenhum problema concreto de cliques foi demonstrado nesta execução. A validação manual com usuários de teste permanece necessária para decidir melhorias operacionais.

## Evidências de execução

- Suíte backend com replica set descartável em loopback: 274 aprovados, nenhum ignorado; inclui transações, concorrência, isolamento, idempotência, contagens, perdas, recebimentos, estornos e handoff com HUB simulado.
- Frontend: 61 testes de domínio aprovados e build de produção aprovado. Persistência e recarga são cobertas na API local; a recarga em navegador hospedado ainda não foi comprovada.
- Banco temporário usado somente para testes sintéticos; nenhum banco de produção foi usado.
- Há limites nas evidências: não foi executado ensaio real de `mongodump`/`mongorestore` por ausência das ferramentas Database Tools; o teste de 100 chamadas não é teste de carga nem valida a proteção da borda; o HUB real não foi acessado.
