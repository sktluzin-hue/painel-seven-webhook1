import express from 'express';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const auth = admin.auth();
const db = admin.firestore();
const app = express();
app.use(express.json());

// ===== CONFIGURAÇÃO =====
const SUNIZE_TOKEN = 'painel7sunize2026';

const PLANOS_POR_ID = {
  '32851': { tipo: 'semanal',   dias: 7    },
  '32852': { tipo: 'mensal',    dias: 30   },
  '32853': { tipo: 'vitalicio', dias: null },
  'pIVUTw': { tipo: 'semanal',   dias: 7    },
  'ndsYnY': { tipo: 'mensal',    dias: 30   },
  '8rT4ZU': { tipo: 'vitalicio', dias: null },
};

// ===== UTILITÁRIOS =====
function calcularExpiracao(dias) {
  if (!dias) return null;
  const data = new Date();
  data.setDate(data.getDate() + dias);
  return data.toISOString();
}

function detectarPlanoLowify(body) {
  const idNumerico = body?.produto?.id?.toString() || body?.product?.id?.toString() || '';
  console.log(`ID numérico do produto: "${idNumerico}"`);
  if (idNumerico && PLANOS_POR_ID[idNumerico]) {
    const plano = PLANOS_POR_ID[idNumerico];
    console.log(`✅ Plano detectado pelo ID numérico: ${plano.tipo}`);
    return { ...plano };
  }
  const idAlfa = body?.produto?.code || body?.product?.code || body?.offer_id || '';
  if (idAlfa && PLANOS_POR_ID[idAlfa]) {
    const plano = PLANOS_POR_ID[idAlfa];
    console.log(`✅ Plano detectado pelo ID alfanumérico: ${plano.tipo}`);
    return { ...plano };
  }
  const nomeProduto = (body?.produto?.name || body?.product?.name || '').toLowerCase();
  if (nomeProduto.includes('7 dia') || nomeProduto.includes('semanal')) return { tipo: 'semanal', dias: 7 };
  if (nomeProduto.includes('30 dia') || nomeProduto.includes('mensal')) return { tipo: 'mensal', dias: 30 };
  if (nomeProduto.includes('vitalicio') || nomeProduto.includes('vitalício')) return { tipo: 'vitalicio', dias: null };
  console.log('⚠️ Plano não detectado — aplicando vitalício por padrão');
  return { tipo: 'vitalicio', dias: null };
}

function detectarPlanoSunize(body) {
  const oferta = (
    body?.corpo?.Produto?.nome_do_produto ||
    body?.body?.Product?.product_name ||
    body?.offer?.name || body?.plan?.name || body?.product?.name ||
    body?.order?.plan_name || ''
  ).toLowerCase();
  console.log(`Sunize - oferta: "${oferta}"`);
  if (oferta.includes('7 dia') || oferta.includes('semanal') || oferta.includes('weekly')) return { tipo: 'semanal', dias: 7 };
  if (oferta.includes('30 dia') || oferta.includes('mensal') || oferta.includes('monthly')) return { tipo: 'mensal', dias: 30 };
  if (oferta.includes('vitalicio') || oferta.includes('vitalício') || oferta.includes('lifetime')) return { tipo: 'vitalicio', dias: null };
  console.log('⚠️ Sunize - plano não detectado, aplicando vitalício por padrão');
  return { tipo: 'vitalicio', dias: null };
}

async function cadastrarOuAtualizar(email, tipo, dias) {
  const dataExpiracao = calcularExpiracao(dias);
  let uid;
  try {
    const usuario = await auth.createUser({ email, password: 'painel2026' });
    uid = usuario.uid;
    console.log(`✅ Usuário criado: ${email}`);
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      const usuario = await auth.getUserByEmail(email);
      uid = usuario.uid;
      console.log(`ℹ️ Usuário já existe: ${email}`);
    } else {
      throw e;
    }
  }
  await db.collection('usuarios').doc(uid).set({
    email, ativo: true, plano: tipo, dataExpiracao,
    criadoEm: new Date().toISOString(),
  }, { merge: true });
  console.log(`✅ Cliente cadastrado: ${email} | Plano: ${tipo} | Expira: ${dataExpiracao ?? 'nunca'}`);
  return { uid, dataExpiracao };
}

// ===== WEBHOOK LOWIFY =====
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('=== LOWIFY Webhook recebido ===');
    console.log(JSON.stringify(body, null, 2));

    const email = body?.cliente?.email || body?.customer?.email || body?.email || body?.buyer_email;
    const evento = body?.evento || body?.event || body?.status || '';
    console.log(`Evento: ${evento} | Email: ${email}`);

    const eventoLower = evento.toLowerCase();
    const aprovado =
      eventoLower.includes('paid') || eventoLower.includes('pag') ||
      eventoLower.includes('aprovad') || eventoLower.includes('approved') ||
      eventoLower.includes('completed') || eventoLower === 'sale.paid' ||
      eventoLower === 'venda.paga' || eventoLower === 'venda.aprovada' ||
      body?.status === 'approved' || body?.status === 'paid' || body?.status === 'pago';

    if (!aprovado) {
      console.log(`Evento ignorado: ${evento}`);
      return res.status(200).json({ ok: false, msg: `Evento ignorado: ${evento}` });
    }
    if (!email) {
      console.log('Email não encontrado');
      return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
    }

    const { tipo, dias } = detectarPlanoLowify(body);
    await cadastrarOuAtualizar(email, tipo, dias);
    return res.status(200).json({ ok: true, email, plano: tipo });

  } catch (err) {
    console.error('Erro Lowify:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== WEBHOOK SUNIZE =====
app.post('/webhook-sunize', async (req, res) => {
  try {
    const body = req.body;
    console.log('=== SUNIZE Webhook recebido ===');
    console.log(JSON.stringify(body, null, 2));

    // Validação do token (aceita em vários lugares)
    const tokenRecebido =
      req.headers['x-webhook-token'] ||
      req.headers['x-token'] ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      body?.token ||
      req.query?.token;

    console.log(`Token recebido: "${tokenRecebido}"`);

    if (tokenRecebido !== SUNIZE_TOKEN) {
      console.log('❌ Token inválido');
      // Retorna 200 mesmo assim para não causar reenvios, mas não processa
      return res.status(200).json({ ok: false, msg: 'Token inválido' });
    }

    // Extrai email — Sunize envia dentro de corpo.Cliente["e-mail"]
    const email =
      body?.corpo?.Cliente?.['e-mail'] ||
      body?.corpo?.Cliente?.email ||
      body?.body?.Customer?.email ||
      body?.body?.customer?.email ||
      body?.customer?.email || body?.buyer?.email ||
      body?.email;

    console.log(`Email Sunize: ${email}`);

    // Extrai evento — Sunize envia como "VENDA_APROVADA" ou "SALE_APPROVED"
    const evento = body?.evento || body?.event || body?.type ||
      body?.status || body?.corpo?.order_status || '';
    console.log(`Evento Sunize: ${evento}`);

    const aprovado =
      evento === 'VENDA_APROVADA' || evento === 'SALE_APPROVED' ||
      evento === 'order.paid' || evento === 'purchase.approved' ||
      evento === 'sale.approved' || evento === 'payment.approved' ||
      evento === 'compra_aprovada' || evento === 'approved' ||
      evento?.toLowerCase().includes('approv') ||
      evento?.toLowerCase().includes('paid') ||
      evento?.toLowerCase().includes('aprovad');

    if (!email) {
      console.log('⚠️ Email não encontrado no payload Sunize');
      return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
    }

    if (!aprovado) {
      console.log(`Evento Sunize ignorado: ${evento}`);
      return res.status(200).json({ ok: false, msg: `Evento ignorado: ${evento}` });
    }

    const { tipo, dias } = detectarPlanoSunize(body);
    await cadastrarOuAtualizar(email, tipo, dias);
    return res.status(200).json({ ok: true, email, plano: tipo });

  } catch (err) {
    console.error('Erro Sunize:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== WEBHOOK WIAPY =====
const WIAPY_TOKEN = 'painelseven7';

function detectarPlanoWiapy(body) {
  const titulo = (
    body?.data?.checkout?.title ||
    body?.data?.products?.[0]?.title || ''
  ).toLowerCase();

  console.log(`Wiapy - título do checkout: "${titulo}"`);

  if (titulo.includes('7 dia') || titulo.includes('semanal')) return { tipo: 'semanal', dias: 7 };
  if (titulo.includes('30 dia') || titulo.includes('mensal')) return { tipo: 'mensal', dias: 30 };
  if (titulo.includes('vitalicio') || titulo.includes('vitalício')) return { tipo: 'vitalicio', dias: null };

  console.log('⚠️ Wiapy - plano não detectado, aplicando vitalício por padrão');
  return { tipo: 'vitalicio', dias: null };
}

app.post('/webhook-wiapy', async (req, res) => {
  try {
    const body = req.body;
    console.log('=== WIAPY Webhook recebido ===');
    console.log(JSON.stringify(body, null, 2));

    const tokenRecebido = req.headers['authorization'] || body?.token || '';
    console.log(`Token recebido: "${tokenRecebido}"`);

    if (tokenRecebido !== WIAPY_TOKEN) {
      console.log('❌ Token inválido');
      return res.status(200).json({ ok: false, msg: 'Token inválido' });
    }

    const email = body?.data?.customer?.email;
    console.log(`Email Wiapy: ${email}`);

    const status = body?.data?.payment?.status || '';
    console.log(`Status Wiapy: ${status}`);

    if (status !== 'paid') {
      console.log(`Evento Wiapy ignorado: ${status}`);
      return res.status(200).json({ ok: false, msg: `Status ignorado: ${status}` });
    }

    if (!email) {
      console.log('⚠️ Email não encontrado no payload Wiapy');
      return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
    }

    const { tipo, dias } = detectarPlanoWiapy(body);
    await cadastrarOuAtualizar(email, tipo, dias);
    return res.status(200).json({ ok: true, email, plano: tipo });

  } catch (err) {
    console.error('Erro Wiapy:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== PUSH NOTIFICATIONS =====
app.post('/send-push', async (req, res) => {
  try {
    const { titulo, corpo, link, tokens } = req.body;

    if (!tokens || tokens.length === 0) {
      return res.status(200).json({ ok: false, error: 'Nenhum token fornecido' });
    }

    console.log(`Enviando push para ${tokens.length} tokens...`);

    // Get access token for FCM V1
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    const client = await auth.getClient();
    const accessToken = (await client.getAccessToken()).token;

    const projectId = serviceAccount.project_id;
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    let enviados = 0;
    let erros = 0;

    // Send to each token (FCM V1 sends one at a time)
    for (const token of tokens) {
      try {
        const message = {
          message: {
            token,
            notification: {
              title: titulo,
              body: corpo,
            },
            webpush: {
              notification: {
                title: titulo,
                body: corpo,
                icon: 'https://comforting-cupcake-b3214d.netlify.app/favicon.ico',
                click_action: link || 'https://comforting-cupcake-b3214d.netlify.app/',
              },
              fcm_options: {
                link: link || 'https://comforting-cupcake-b3214d.netlify.app/',
              },
            },
          },
        };

        const response = await fetch(fcmUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(message),
        });

        if (response.ok) {
          enviados++;
        } else {
          erros++;
          const err = await response.json();
          console.log(`Erro token ${token.slice(0,20)}...: ${JSON.stringify(err)}`);
        }
      } catch (e) {
        erros++;
      }
    }

    console.log(`✅ Push enviado: ${enviados} ok, ${erros} erros`);
    return res.status(200).json({ ok: true, enviados, erros });

  } catch (err) {
    console.error('Erro send-push:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({
  status: 'Painel Seven Webhook ativo ✅',
  endpoints: ['/webhook (Lowify)', '/webhook-sunize (Sunize)', '/webhook-wiapy (Wiapy)', '/send-push (Push Notifications)']
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
