# TempMail Manifest

Frontend web + backend separado para o cliente TempmailBee original.

## Estrutura

- `server.js` — backend (Node puro, sem dependências). Fala com a API do
  TempmailBee e expõe rotas locais para o frontend.
- `public/index.html` — frontend (HTML + CSS + JS num único arquivo).

## Como rodar

```bash
node server.js
```

Depois abra **http://localhost:3000** no navegador.

## Rotas da API (server.js)

| Método | Rota           | Descrição                              |
|--------|----------------|-----------------------------------------|
| POST   | `/api/create`  | Cria uma caixa nova. Body opcional: `{ "username": "..." }` |
| GET    | `/api/status`  | Retorna a caixa ativa (se houver)       |
| GET    | `/api/emails`  | Busca os e-mails recebidos na caixa ativa |
| DELETE | `/api/mailbox` | Apaga a caixa ativa                     |
| GET    | `/api/domains` | Lista domínios disponíveis              |

Requer Node 18+.
