# 🦘 Canguinha

Gestão de finanças pessoais conectada ao Open Finance via [Pluggy](https://pluggy.ai).
Dashboard com saldo das contas, faturas dos cartões e transações por conta/cartão e período.

## Rodar com Docker (recomendado)

```bash
cp .env.example .env      # preencha as credenciais Pluggy
docker compose up -d --build
```

Abra <http://localhost:3010> (mude com `APP_PORT` no `.env`). Sobe dois serviços:

- **app**: o Canguinha (Node 22 Alpine)
- **db**: Postgres 17. Guarda as conexões adicionadas pela tela e as metas. Os dados ficam no volume `canguinha_pgdata`
  e sobrevivem a `docker compose down` (só somem com `down -v`).

Na primeira subida, se o banco estiver vazio, o app importa `data/items.json` e `data/goals.json` (montados só para leitura).

Comandos úteis:

```bash
docker compose logs -f app                                     # logs
docker compose up -d --build app                               # depois de mudar o código
docker compose exec db psql -U canguinha -d canguinha          # SQL
docker compose exec -T db pg_dump -U canguinha canguinha > backup.sql
```

### Histórico

Com Postgres, tudo que vem da Pluggy é gravado e o app **lê do banco**:

| Tabela | Conteúdo |
|---|---|
| `accounts` | contas (normalizada + resposta original da Pluggy) |
| `transactions` | todas as transações, com a resposta original em `raw` |
| `bills` | faturas dos cartões |
| `sync_runs` | log de cada sincronização |
| `items`, `goals` | conexões adicionadas pela tela e metas |

- Sincroniza tudo ao subir e a cada `SYNC_INTERVAL_HOURS` (padrão 6); também pelo botão em **Conexões**.
- **Atualizar do banco** (em **Conexões**, por item) pede à Pluggy uma coleta nova no banco. O app acompanha o
  item até terminar (até 15 min) e então sincroniza sozinho, sem depender de webhooks.
- O histórico continua disponível depois que a Pluggy para de devolvê-lo, e o app funciona com a Pluggy fora do ar.
- Transação que some da Pluggy dentro do período que ela ainda cobre (ex.: pendente que virou outra) recebe
  `removed_at` e deixa de aparecer, mas não é apagada. Mais antigas que a janela da Pluggy nunca são marcadas.

```sql
-- gastos por categoria em 2026, direto no banco
SELECT category, sum(amount) FROM transactions
WHERE removed_at IS NULL AND date_local >= '2026-01-01' AND type = 'DEBIT' GROUP BY 1 ORDER BY 2 DESC;
```

### Login com Google

O dashboard e a API exigem login com uma conta Google listada em `ALLOWED_EMAILS`. Sem `GOOGLE_CLIENT_ID` o
login fica desligado (uso local); com `PUBLIC_URL` definida, o app **não sobe** sem login configurado.

1. Em <https://console.cloud.google.com/apis/credentials>: **Criar credenciais → ID do cliente OAuth →
   Aplicativo da Web** (configure antes a tela de consentimento, tipo Externo, e adicione seu e-mail como
   usuário de teste se ela ficar em modo de teste).
2. **URI de redirecionamento autorizado**: `https://canguinha.seudominio.com.br/auth/google/callback`
   (para testar local, também `http://localhost:3010/auth/google/callback`).
3. No `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `ALLOWED_EMAILS=voce@gmail.com`.

Fluxo authorization code com PKCE, `state` e `nonce`; o `id_token` é validado (emissor, audiência, expiração,
nonce, e-mail verificado). A sessão é um cookie `HttpOnly`, `SameSite=Lax` (e `Secure` em HTTPS) de 30 dias; o
banco guarda só o hash (tabela `sessions`). Requisições que alteram dados com `Origin` de outro site são recusadas.
Ficam públicos apenas `/healthz`, `/webhooks/pluggy/<segredo>` e a página de login.

### Webhooks (produção)

Com o app publicado em HTTPS, defina no `.env`:

```bash
PUBLIC_URL=https://canguinha.seudominio.com.br
```

Ao subir, o app cadastra na Pluggy os eventos `item/updated`, `item/error`, `item/waiting_user_input`,
`item/login_succeeded` e `transactions/created|updated|deleted`, apontando para
`PUBLIC_URL/webhooks/pluggy/<segredo>`. O segredo é gerado e guardado no banco (tabela `settings`), ou vem de
`WEBHOOK_SECRET`. Trocar domínio ou segredo substitui os cadastros antigos; webhooks de outros sistemas não são tocados.

Cada aviso fica em `webhook_events` (90 dias) e dispara uma sincronização (avisos em sequência viram uma só, após 10 s).
O corpo do aviso não é usado como dado: o app sempre busca na API da Pluggy. Avisos de erro na conexão aparecem
no topo do dashboard. Sem `PUBLIC_URL`, continua só a sincronização periódica.

O proxy HTTPS precisa encaminhar `POST /webhooks/pluggy/*` para o app (porta 3000 do container).

## Bot do Telegram

Comandos para consultar as faturas e metas pelo Telegram (mesmos cálculos do dashboard):

| Comando | Resposta |
|---|---|
| `/diaria` | gasto de hoje e quanto ainda pode gastar hoje pelas metas mensal e semanal |
| `/semana` | meta semanal: gasto, quanto resta, quanto pode gastar por dia até domingo |
| `/mes` | meta mensal no ciclo da fatura: gasto (com parcelas previstas), por dia/semana, projeção |
| `/fatura` | fatura aberta, última fechada (vencimento, mínimo), limite, categorias e últimos lançamentos |
| `/saldo` | saldo das contas e limite usado dos cartões |

Para um cartão só, escreva parte do nome: `/fatura elo`.

1. No Telegram, fale com o [@BotFather](https://t.me/BotFather), mande `/newbot` e copie o token.
2. No `.env`: `TELEGRAM_BOT_TOKEN=<token>` e reinicie o app.
3. Mande `/start` para o seu bot: como o chat ainda não está autorizado, ele responde com o seu chat id.
4. No `.env`: `TELEGRAM_ALLOWED_CHAT_IDS=<chat id>` e reinicie. Outros chats só recebem a mensagem de não autorizado.

### Categorizar despesas novas pelo Telegram

Com o bot configurado e Postgres, cada **despesa nova** cuja descrição ainda não tem regra nem categoria escolhida
gera uma mensagem com botões: **✅ Manter** a categoria da Pluggy, escolher outra (atalhos, **Mais categorias…**) ou
**➕ Nova categoria** (responda com o nome). A escolha vira uma **regra pela descrição**, a mesma de "aplicar a todas
com esta descrição" no app: as próximas despesas com essa descrição já chegam categorizadas e não perguntam de novo.

- Uma pergunta por descrição: se a mesma chegar de novo antes da resposta, não repete.
- Só despesas dos últimos 7 dias, até 10 perguntas por vez; pagamento de fatura, transferências entre contas
  próprias e créditos ficam de fora. A primeira importação de uma conta não gera perguntas.
- Com webhooks (`PUBLIC_URL`), o aviso `transactions/created` sincroniza na hora só os últimos 7 dias da conta,
  e a pergunta chega em segundos. Sem webhooks, chega na próxima sincronização.
- Para trocar depois, apague ou mude a regra em **Categorias** no app. `TELEGRAM_CATEGORIZE=0` desliga as perguntas.

O bot usa long polling (`getUpdates`): não precisa de URL pública nem de porta aberta, funciona também no WSL.
Cada token só pode ser usado por uma instância: use um bot para desenvolvimento e outro para produção (com o mesmo
token, o log mostra `409 Conflict`).

## Rodar sem Docker

Requer Node 22+. Sem `DATABASE_URL`, os dados ficam em arquivos JSON em `data/`.

```bash
cp .env.example .env   # preencha as credenciais
npm install
npm start              # http://127.0.0.1:3000
```

Sem credenciais o app sobe em **modo demonstração** com dados fictícios.

### Container no WSL

Dentro de um container o servidor escuta em `0.0.0.0` automaticamente. Para abrir no navegador do Windows,
a porta precisa estar publicada no container (ex.: `-p 3000:3000` ou `ports: ["3000:3000"]` no compose);
o WSL2 repassa `localhost` do Windows para o WSL, então basta acessar <http://localhost:3000>.
Se a porta 3000 não estiver publicada, use uma que esteja: `PORT=8080 npm start`.

## Configurar a Pluggy (MeuPluggy)

1. Em <https://dashboard.pluggy.ai> crie uma aplicação e copie **Client ID** e **Client Secret** para o `.env`.
2. Em <https://meu.pluggy.ai> conecte seus bancos e cartões.
3. No dashboard da Pluggy, conecte o conector **MeuPluggy** à sua aplicação. Isso cria um *item*; copie o ID dele.
4. Coloque o ID em `PLUGGY_ITEM_IDS` no `.env` (vários separados por vírgula) **ou** adicione pela tela em **Conexões**
   (fica salvo em `data/items.json`).

## Funcionalidades

- Saldo total das contas, faturas a vencer e saldo líquido de faturas
- Entradas, saídas e resultado no período (este mês, mês passado, 30/90 dias, este ano ou personalizado)
- Filtro por conta/cartão: clique nos cards
- Gráficos: fluxo de entradas/saídas (diário, semanal ou mensal conforme o período), gastos por categoria e por conta/cartão
- Tabela de transações com busca, filtro por categoria e tipo, parcelas e exportação CSV
- **Categorias personalizadas**: crie em **Categorias** (topo) e clique na categoria de qualquer lançamento para trocá-la
  (por uma sua ou outra da Pluggy). Marcando "aplicar a todas com esta descrição", vira uma regra que vale também para
  os lançamentos futuros; a descrição é comparada sem datas, horários, parcelas e números longos
  (`PIX - ENVIADO 04/11 09:48 FULANO` → `pix - enviado fulano`). Prioridade: escolha manual > regra > Pluggy.
  O dado original da Pluggy nunca é alterado; excluir uma categoria devolve os lançamentos à categoria da Pluggy.
  Ficam no Postgres (`categories`, `tx_categories`, `category_rules`) ou em `data/categories.json` sem banco.
- **Despesas de outras pessoas** (botão **Pessoas**): em qualquer despesa, **+ dividir** registra quanto é de outra
  pessoa: toda dela, metade ou valores livres, com uma ou várias pessoas. Numa compra parcelada a divisão vale para todas
  as parcelas, proporcional ao valor de cada uma, inclusive as que ainda vão cair. Metas e totais contam só a sua parte
  (desligável na Visão geral). Em **Pessoas** fica o saldo de cada uma (parte dela − pagamentos que você registrou),
  com as despesas e os pagamentos. Tabelas `people`, `expense_shares` e `person_payments`.
- Opção de ignorar pagamento de fatura e transferências entre contas próprias, para não contar o mesmo gasto duas vezes
- Botão de sincronizar item (pede à Pluggy para atualizar os dados no banco)
- **Faturas** (aba própria, ou `/#faturas`): fatura aberta parcial com fechamento e vencimento estimados, próxima a pagar,
  média das últimas, histórico mensal, lista de faturas e os lançamentos/categorias de cada uma
- **Meta semanal por cartão** (aba Faturas): gasto da semana (seg–dom) vs. meta, quanto ainda pode gastar por dia,
  histórico das últimas 8 semanas, e a fatura aberta comparada à meta proporcional ao ciclo. Fica em `data/goals.json`.
  Pagamentos da fatura não contam; estornos abatem.
- **Meta mensal por cartão**, medida pelo ciclo da fatura (dia seguinte ao último fechamento até o próximo, estimado):
  quanto ainda pode gastar por dia, por semana e até domingo para fechar dentro da meta, projeção no ritmo atual e
  gráfico do gasto acumulado contra o ritmo da meta. Considera como já comprometidas as **parcelas previstas**:
  próximas parcelas de compras parceladas que estavam na última fatura e ainda não foram lançadas (valor da parcela anterior). Se houver meta semanal também, mostra qual das duas é mais apertada.
- Sinal de ritmo nas duas metas: avisa quando a média diária acumulada (semana: seg até hoje; mês: ciclo até hoje,
  com parcelas previstas) passa da meta diária (semanal ÷ 7; mensal ÷ dias do ciclo)
- Aviso no topo quando a média diária passa da meta diária, a meta semanal passa de 80% ou estoura, a mensal estoura ou a projeção passa dela, uma fatura fechada vence em até 7 dias ou a aberta fecha em até 3
- Tema claro/escuro

## Notas

- As credenciais ficam só no servidor; o navegador fala apenas com `/api/*`. Fora de container o servidor escuta só em `127.0.0.1`; dentro, em `0.0.0.0` (exposto apenas se a porta for publicada).
- Respostas da Pluggy ficam em cache por 5 minutos; **Atualizar** ignora o cache.
- Faturas vêm de `GET /bills?accountId=` (o `/v2/bills` responde 403). Cada lançamento do cartão traz `billId`;
  lançamentos sem `billId` ainda não foram faturados e formam a fatura aberta. O "saldo" do cartão na Pluggy é o
  limite usado total (inclui parcelas futuras), não a fatura do mês.
- Transações vêm de `GET /v2/transactions` (filtros `dateFrom`/`dateTo`, paginação por cursor em `next`).
- Direção pelo campo `type` (`DEBIT` = saída, `CREDIT` = entrada), em contas e cartões. Datas convertidas para
  `America/Sao_Paulo` (mude com `TZ_DISPLAY`). Ver `normalizeTransaction` em `server.js`.
- `?periodo=90` (ou `month`, `lastmonth`, `30`, `year`) na URL abre já com o período escolhido.
