# Backup e restauração do DACOT-ESTOQUE

Este procedimento requer um responsável, um ambiente de recuperação isolado e uma cópia verificada antes do piloto. Nunca restaure sobre o Atlas de produção durante um ensaio. O projeto não configura nem comprova uma rotina automática de backups.

## Preparação

1. O proprietário identifica o cluster e a base do Estoque, seus responsáveis, período de retenção, RPO e RTO. Confere no Atlas se o plano atual oferece snapshots e recuperação, suas restrições e eventuais custos antes de habilitar qualquer opção. Não pressupor que a funcionalidade esteja ativa.
2. Documentar em local restrito a periodicidade, horário, versão do MongoDB, topologia, destino criptografado, retenção, acesso e procedimento de resposta a falhas. As cópias contêm dados de todos os restaurantes e exigem controle de acesso e criptografia em trânsito e em repouso.
3. Usar conta dedicada de backup com apenas as permissões necessárias, e armazenar credenciais em gerenciador de segredos. Não colocar URI com senha em comandos, histórico de terminal, repositório ou logs. Conferir o hash e o sucesso do backup e alertar o responsável quando falhar.

## Backup consistente

Preferir um snapshot consistente do Atlas compatível com o plano e a topologia confirmados pelo proprietário. Registrar data, horário, identificação do snapshot e a versão da aplicação, sem registrar credenciais. Confirmar que é possível restaurá-lo em destino isolado.

Se snapshots adequados não estiverem disponíveis, preparar uma janela de manutenção: interromper todas as escritas no Estoque e em processos que compartilhem sua base, confirmar que transações terminaram, então executar `mongodump` com a configuração de conexão em arquivo privado fora do repositório e destino criptografado. Manter as escritas suspensas até o dump terminar. Um dump por banco com escritas concorrentes não garante um retrato consistente das transações entre coleções. Para backup online, avaliar com o proprietário um mecanismo de snapshot apropriado à topologia; `--oplog` tem requisitos e limitações próprias e não deve ser combinado cegamente com filtros de banco.

Exemplo ilustrativo, executado pelo responsável após conferir base e destino, com arquivo de configuração protegido aceito pelo MongoDB Database Tools:

```powershell
mongodump --config <arquivo-privado-de-conexao> --db <base-do-estoque> --archive=<arquivo-em-destino-protegido> --gzip
```

Verificar código de saída e log sem segredos, conferir tamanho e integridade do arquivo e registrar início/fim e hash. Somente então liberar as escritas. Retenção e remoção devem seguir a política aprovada pelo proprietário.

## Ensaio de restauração isolado

1. Criar ou selecionar um replica set de teste separado, de versão principal ou feature compatibility version compatível com a origem. Verificar visualmente o endereço e o nome da base de destino antes de prosseguir. Usar dados sintéticos ou acesso aprovado para dados sensíveis.
2. Restaurar o snapshot pelo Atlas para um destino isolado, se disponível, ou usar `mongorestore` em uma base vazia e exclusivamente de teste. A configuração privada deve apontar ao destino isolado; nunca incluir `--drop` neste ensaio.

```powershell
mongorestore --config <arquivo-privado-do-destino-isolado> --archive=<arquivo-de-backup> --gzip --nsInclude="<base-do-estoque>.*" --nsFrom="<base-do-estoque>.*" --nsTo="dacot_restore_test.*" --stopOnError
```

3. Conferir logs e índices, comparar totais e amostras por restaurante, recebimentos, saldos, movimentos, perdas, fichas, contagens e respectivos registros de auditoria. Validar também um acesso cruzado negado e a integridade dos relacionamentos com a aplicação de homologação. Não conectar a aplicação de produção ao destino de teste.
4. Registrar data do backup, duração, resultados, responsável e divergências; repetir periodicamente. Em um incidente real, isolar gravações, preservar evidências e definir o ponto de recuperação com o proprietário antes de qualquer troca de banco ou restauração em produção.

Referências oficiais: [mongodump](https://www.mongodb.com/docs/database-tools/mongodump/), [mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/) e [backups do Atlas](https://www.mongodb.com/docs/atlas/backup/cloud-backup/overview/).
