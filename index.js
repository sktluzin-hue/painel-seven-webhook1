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

// Raw body parser — captura texto antes de processar
// Necessário para lidar com JSON inválido da Wiapy (usa "nulo" em vez de null)
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch(e) {
      try {
        const fixed = data
          .replace(/:\s*nulo/g, ': null')
          .replace(/:\s*verdadeiro/g, ': true')
          .replace(/:\s*falso/g, ': false');
        req.body = JSON.parse(fixed);
      } catch(e2) {
        req.body = {};
        req.bodyParseError = e2.message;
      }
    }
    next();
  });
});

// ===== CONFIGURAÇÃO =====
const SUNIZE_TOKEN = 'painel7sunize2026';
const WIAPY_TOKEN = 'painelseven7';

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
  if (oferta.includes('7 dia') || oferta.includes('semanal')) return { tipo: 'semanal', dias: 7 };
  if (oferta.includes('30 dia') || oferta.includes('mensal')) return { tipo: 'mensal', dias: 30 };
  if (oferta.includes('vitalicio') || oferta.includes('vitalício')) return { tipo: 'vitalicio', dias: null };
  console.log('⚠️ Sunize - plano não detectado, aplicando vitalício por padrão');
  return { tipo: 'vitalicio', dias: null };
}

function detectarPlanoWiapy(body, rawBody) {
  // Tenta do body parseado
  const titulo1 = (
    body?.['Confira']?.['título'] ||
    body?.checkout?.title ||
    body?.data?.checkout?.title ||
    body?.produtos?.[0]?.['título'] ||
    body?.data?.products?.[0]?.title || ''
  ).toLowerCase();

  // Tenta do rawBody via regex
  let titulo2 = '';
  if (rawBody) {
    const m = rawBody.match(/"t[íi]tulo"\s*:\s*"([^"]+)"/);
    titulo2 = (m?.[1] || '').toLowerCase();
  }

  const titulo = titulo1 || titulo2;
  console.log(`Wiapy - título: "${titulo}"`);

  if (titulo.includes('7 dia') || titulo.includes('semanal')) return { tipo: 'semanal', dias: 7 };
  if (titulo.includes('30 dia') || titulo.includes('mensal')) return { tipo: 'mensal', dias: 30 };
  if (titulo.includes('vitalicio') || titulo.includes('vitalício') || titulo.includes('vitalic')) return { tipo: 'vitalicio', dias: null };

  console.log('⚠️ Wiapy - plano não detectado, aplicando vitalício por padrão');
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

    const tokenRecebido =
      req.headers['x-webhook-token'] ||
      req.headers['x-token'] ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      body?.token || req.query?.token;
    console.log(`Token recebido: "${tokenRecebido}"`);

    if (tokenRecebido !== SUNIZE_TOKEN) {
      console.log('❌ Token inválido');
      return res.status(200).json({ ok: false, msg: 'Token inválido' });
    }

    const email =
      body?.corpo?.Cliente?.['e-mail'] ||
      body?.corpo?.Cliente?.email ||
      body?.body?.Customer?.email ||
      body?.customer?.email || body?.buyer?.email || body?.email;
    console.log(`Email Sunize: ${email}`);

    const evento = body?.evento || body?.event || body?.type || body?.status || '';
    console.log(`Evento Sunize: ${evento}`);

    const aprovado =
      evento === 'VENDA_APROVADA' || evento === 'SALE_APPROVED' ||
      evento === 'order.paid' || evento === 'purchase.approved' ||
      evento === 'compra_aprovada' || evento === 'approved' ||
      evento?.toLowerCase().includes('approv') ||
      evento?.toLowerCase().includes('aprovad');

    if (!email) return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
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
app.post('/webhook-wiapy', async (req, res) => {
  try {
    const body = req.body;
    const rawBody = req.rawBody || '';
    console.log('=== WIAPY Webhook recebido ===');
    console.log(JSON.stringify(body, null, 2));

    const tokenRecebido = req.headers['authorization'] || body?.token || '';
    console.log(`Token recebido: "${tokenRecebido}"`);

    if (tokenRecebido !== WIAPY_TOKEN) {
      console.log('❌ Token inválido');
      return res.status(200).json({ ok: false, msg: 'Token inválido' });
    }

    // Email
    const cliente = body?.cliente || {};
    let email = cliente['e-mail'] || cliente.email || body?.data?.customer?.email;
    if (!email && rawBody) {
      const m = rawBody.match(/"e-mail"\s*:\s*"([^"]+)"/);
      email = m?.[1] || '';
    }
    console.log(`Email Wiapy: ${email}`);

    // Status
    let status = (body?.pagamento?.status || '').toLowerCase();
    if (!status && rawBody) {
      const m = rawBody.match(/"status"\s*:\s*"([^"]+)"/);
      status = (m?.[1] || '').toLowerCase();
    }
    console.log(`Status Wiapy: "${status}"`);

    // ID do pagamento como fallback
    let pagamentoId = body?.pagamento?.id || '';
    if (!pagamentoId && rawBody) {
      const m = rawBody.match(/"pagamento"[\s\S]{0,50}"id"\s*:\s*"([^"]+)"/);
      pagamentoId = m?.[1] || '';
    }

    const aprovado = status === 'pago' || status === 'paid' ||
      status === 'aprovado' || status === 'approved' ||
      (pagamentoId && !status);

    if (!email) return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
    if (!aprovado) {
      console.log(`Evento Wiapy ignorado: status="${status}"`);
      return res.status(200).json({ ok: false, msg: `Status ignorado: ${status}` });
    }

    const { tipo, dias } = detectarPlanoWiapy(body, rawBody);
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
    const { GoogleAuth } = await import('google-auth-library');
    const gauth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    const client = await gauth.getClient();
    const accessToken = (await client.getAccessToken()).token;
    const projectId = serviceAccount.project_id;
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    let enviados = 0, erros = 0;
    for (const token of tokens) {
      try {
        const message = {
          message: {
            token,
            notification: { title: titulo, body: corpo },
            webpush: {
              notification: {
                title: titulo, body: corpo,
                icon: 'https://comforting-cupcake-b3214d.netlify.app/favicon.ico',
              },
              fcm_options: { link: link || 'https://comforting-cupcake-b3214d.netlify.app/' },
            },
          },
        };
        const response = await fetch(fcmUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });
        if (response.ok) { enviados++; } else { erros++; }
      } catch (e) { erros++; }
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
  endpoints: ['/webhook (Lowify)', '/webhook-sunize (Sunize)', '/webhook-wiapy (Wiapy)', '/send-push (Push)']
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
