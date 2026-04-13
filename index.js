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
    body?.offer?.name || body?.plan?.name || body?.product?.name ||
    body?.order?.plan_name || body?.subscription?.plan?.name ||
    body?.data?.offer?.name || body?.data?.product?.name || ''
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

    // Extrai email de vários campos possíveis
    const email =
      body?.customer?.email || body?.buyer?.email || body?.client?.email ||
      body?.email || body?.order?.customer?.email || body?.data?.customer?.email ||
      body?.data?.buyer?.email;

    console.log(`Email Sunize: ${email}`);

    // Extrai evento
    const evento = body?.event || body?.type || body?.status ||
      body?.data?.status || body?.data?.event || '';
    console.log(`Evento Sunize: ${evento}`);

    const aprovado =
      evento === 'order.paid' || evento === 'purchase.approved' ||
      evento === 'sale.approved' || evento === 'payment.approved' ||
      evento === 'compra_aprovada' || evento === 'approved' ||
      evento?.toLowerCase().includes('approv') || evento?.toLowerCase().includes('paid') ||
      evento?.toLowerCase().includes('pago');

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

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({
  status: 'Painel Seven Webhook ativo ✅',
  endpoints: ['/webhook (Lowify)', '/webhook-sunize (Sunize)']
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
