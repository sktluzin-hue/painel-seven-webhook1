# Painel Seven — Servidor Webhook

Servidor que recebe notificações da Lowify e cadastra clientes automaticamente no Firebase.

## Senhas por plano
- Vitalício: `painel2026`
- Mensal: `painelmensal`
- 7 dias: `painel7dias`

## Como fazer deploy no Render.com

1. Acesse render.com e crie uma conta gratuita
2. Clique em "New" → "Web Service"
3. Conecte seu GitHub e suba esse projeto
4. Configure:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Em "Environment Variables", adicione a variável SECRET_KEY com o conteúdo do serviceAccountKey.json
6. Copie a URL gerada (ex: https://painel-seven-webhook.onrender.com)
7. Cole essa URL na Lowify em: Integrações → Webhooks → Endpoint URL → /webhook

## Endpoint
POST /webhook
