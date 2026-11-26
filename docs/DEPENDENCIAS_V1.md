# Revisão direcionada de dependências — 25/11/2026

`npm audit` identificou dois avisos distintos no React Router 6.30.6. `pip-audit` identificou 41 ocorrências: após agrupar por identificador, 29 avisos distintos (cinco PyMongo, 17 PyJWT e sete Starlette). CVEs e GHSAs listados como aliases no mesmo registro representam o mesmo aviso e não foram contados novamente. A análise a seguir se refere ao código inspecionado, não prova impossibilidade de exploração em qualquer implantação.

## Frontend

- **GHSA-wrjc-x8rr-h8h6 / CVE-2026-53669:** redirecionamento externo quando um caminho malicioso chega a `Link` ou `navigate`. A aplicação usa ambos; os caminhos encontrados são construídos a partir de prefixos internos e IDs, não foi demonstrado caminho controlado integralmente por invasor. Atualizado para React Router DOM 7.18.7, que inclui a correção. Essa mudança de versão principal é necessária para receber o patch publicado; requer Node >=20 e React >=18. O build local usou Node 24 e React 18. Confirme a versão Node do ambiente de build antes de publicar.
- **GHSA-337j-9hxr-rhxg / CVE-2026-53666:** construção indevida de erros na hidratação SSR. O aplicativo usa `BrowserRouter` com `Routes` declarativas e não usa SSR/hidratação do servidor; condição descrita não encontrada. A mesma atualização elimina o aviso.

## PyMongo — 4.11.3 para 4.18.3

O driver é usado no acesso ao MongoDB. Não há uso encontrado de GridFS, criptografia de campos no cliente, decodificação BSON a partir de `mmap`/`array`, ou URI Mongo fornecida pelo usuário. O código usa uma URI configurada no servidor e valida tamanhos nos schemas; não foi reproduzida exploração nos caminhos atuais.

- **PYSEC-2026-4295 / CVE-2026-96747:** redirecionamento de conexão KMS por documento de chave adulterado; requer criptografia de campos e escrita no cofre de chaves.
- **PYSEC-2026-4294 / CVE-2026-88029:** consulta indevida por ID na API GridFS; GridFS não identificado.
- **PYSEC-2026-4297 / CVE-2026-96748:** delimitadores codificados em URI podem alterar hosts; URI deve permanecer sob controle do servidor.
- **PYSEC-2026-4296 / CVE-2026-96749:** overflow ao codificar documento BSON de tamanho extraordinário; não foi reproduzida entrada que alcance a condição.
- **CVE-2026-106435:** leitura fora do buffer ao decodificar BSON malformado por `mmap`/`array`; essa forma de decodificação não foi encontrada.

## PyJWT — 2.10.1 para 2.15.1

O handoff usa `jwt.decode`, segredo de servidor e lista restrita a HS256; há validação de tamanho mínimo de segredo. Os seguintes avisos foram identificados individualmente:

- **PYSEC-2026-120 / CVE-2026-32597:** cabeçalho `crit` não validado; o decode é utilizado, portanto o requisito de cabeçalhos críticos é relevante mesmo sem exploração demonstrada. A versão nova inclui a correção.
- **PYSEC-2025-183 / CVE-2025-45768:** comprimento de chave escolhido pelo aplicativo; o fornecedor contesta a classificação. O código requer segredo de pelo menos 32 caracteres; entropia e sigilo reais dependem da configuração hospedada. O scanner deixou de apontar a versão atualizada, o que não comprova qualidade da chave implantada.
- **PYSEC-2026-179 / CVE-2026-48526; PYSEC-2026-176 / CVE-2026-48523; PYSEC-2026-4145 / CVE-2026-102268; PYSEC-2026-4149 / CVE-2026-102271:** confusão de algoritmos/chaves em configurações mistas, JWK ou chave assimétrica como HMAC. O projeto usa somente HS256 com segredo configurado, sem esses caminhos identificados.
- **PYSEC-2026-175 / CVE-2026-48522; PYSEC-2026-177 / CVE-2026-48524; PYSEC-2026-4140 / CVE-2026-101917; PYSEC-2026-4141 / CVE-2026-101918; PYSEC-2026-4144 / CVE-2026-102267; PYSEC-2026-4152 / CVE-2026-102274; GHSA-pxh4-856f-4h89:** riscos ligados a `PyJWKClient`, conjuntos JWK ou chave JWK vazia; esses mecanismos não foram encontrados.
- **PYSEC-2026-178 / CVE-2026-48525:** validação de JWS com payload destacado não codificado; não identificado nesse handoff.
- **PYSEC-2026-4148 / CVE-2026-102270:** processamento de certificado PEM fornecido pelo atacante; não identificado.
- **PYSEC-2026-4147 / CVE-2026-102269:** segmentos de assinatura não canônicos em 2.13.0; não se aplica à 2.10.1 original, mas está corrigido na versão escolhida.
- **PYSEC-2026-4183 / CVE-2026-102275:** importação privada de JWK OKP; não identificada.

## Starlette — 0.46.2 para 1.3.1, com FastAPI 0.135.4

O FastAPI anterior limitava Starlette abaixo de 0.47. Para instalar a correção de todos os avisos encontrados foi necessário atualizar FastAPI e usar a versão principal 1 do Starlette. A compatibilidade foi exercitada pela suíte local; deve ser confirmada também em homologação hospedada.

- **PYSEC-2026-1941 / CVE-2025-54121:** negação de serviço no upload multipart; rotas de upload/formulário não identificadas.
- **PYSEC-2026-1942 / CVE-2025-62727:** custo elevado ao processar `Range` em `FileResponse`; `FileResponse` não identificado no backend.
- **PYSEC-2026-161 / CVE-2026-48710** e **PYSEC-2026-248 / CVE-2026-54282:** reconstrução de URL com host/caminho malformado. O middleware usa `request.url.path` para cabeçalhos de privacidade; autenticação e autorização estão em dependências das rotas, sem bypass reproduzido. Caminho relevante corrigido na biblioteca.
- **PYSEC-2026-2281 / CVE-2026-48818:** `StaticFiles` no Windows; backend não serve arquivos por `StaticFiles`.
- **PYSEC-2026-2280 / CVE-2026-48817:** dispatch por `HTTPEndpoint`; uso direto não identificado.
- **PYSEC-2026-249 / CVE-2026-54283:** limites em formulários URL encoded; uso de `request.form()` não identificado.

## Validação e riscos restantes

- Após atualizações, `npm audit` e `pip-audit -r backend/requirements.txt` reportaram zero vulnerabilidades conhecidas na resolução feita na data da revisão. Isso não garante ausência de falhas desconhecidas nem valida credenciais e configuração implantadas.
- `pip check` no ambiente virtual isolado: sem conflitos. Backend: 274 testes aprovados e nenhum ignorado em replica set descartável. Frontend: 61 testes aprovados e build concluído.
- Após a migração para React Router 7, foram abertas localmente no navegador, em modo demonstração, as rotas de visão geral, estoque, contagens, compras, perdas, fornecedores e fichas técnicas. A verificação confirmou a renderização e navegação pelas telas, sem testar persistência real ou operações completas.
- Avisos de depreciação em `TestClient` permanecem; não houve falha na suíte. O handoff, as sessões e a navegação autenticada com HUB real e backend hospedado não foram testados. Validar em homologação o login, cookies, revogação, permissões, persistência após recarga e fluxos de escrita. O build do ambiente futuro precisa usar Node >=20; dependências de build existentes podem exigir versão ainda mais recente.
- Os riscos de limitação de abuso, backup/restauração e homologação registrados em `HARDENING_V1.md` permanecem abertos. Não houve alteração de produção.
