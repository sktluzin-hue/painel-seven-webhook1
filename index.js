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

// ✅ Mapeamento por ID do produto (Lowify)
// Cada produto separado na Lowify tem um ID único
const PLANOS_POR_ID = {
  // IDs numéricos (vêm na URL ao editar o produto)
  '32851': { tipo: 'semanal',   dias: 7    },  // Painel Seven 7 Dias
  '32852': { tipo: 'mensal',    dias: 30   },  // Painel Seven 30 Dias
  '32853': { tipo: 'vitalicio', dias: null },  // Painel Seven Vitalício

  // IDs alfanuméricos (aparecem no dashboard)
  'pIVUTw': { tipo: 'semanal',   dias: 7    },  // Painel Seven 7 Dias
  'ndsYnY': { tipo: 'mensal',    dias: 30   },  // Painel Seven 30 Dias
  '8rT4ZU': { tipo: 'vitalicio', dias: null },  // Painel Seven Vitalício
};

function calcularExpiracao(dias) {
  if (!dias) return null;
  const data = new Date();
  data.setDate(data.getDate() + dias);
  return data.toISOString();
}

function detectarPlano(body) {
  // Tenta pelo ID numérico do produto
  const idNumerico = body?.produto?.id?.toString() || body?.product?.id?.toString() || '';
  console.log(`ID numérico do produto: "${idNumerico}"`);

  if (idNumerico && PLANOS_POR_ID[idNumerico]) {
    const plano = PLANOS_POR_ID[idNumerico];
    console.log(`✅ Plano detectado pelo ID numérico: ${plano.tipo}`);
    return { ...plano };
  }

  // Tenta pelo ID alfanumérico (campo alternativo)
  const idAlfa = body?.produto?.code || body?.product?.code || body?.offer_id || '';
  console.log(`ID alfanumérico do produto: "${idAlfa}"`);

  if (idAlfa && PLANOS_POR_ID[idAlfa]) {
    const plano = PLANOS_POR_ID[idAlfa];
    console.log(`✅ Plano detectado pelo ID alfanumérico: ${plano.tipo}`);
    return { ...plano };
  }

  // Tenta pelo nome do produto como fallback
  const nomeProduto = (body?.produto?.name || body?.product?.name || '').toLowerCase();
  console.log(`Nome do produto: "${nomeProduto}"`);

  if (nomeProduto.includes('7 dia') || nomeProduto.includes('semanal')) {
    return { tipo: 'semanal', dias: 7 };
  }
  if (nomeProduto.includes('30 dia') || nomeProduto.includes('mensal')) {
    return { tipo: 'mensal', dias: 30 };
  }
  if (nomeProduto.includes('vitalicio') || nomeProduto.includes('vitalício')) {
    return { tipo: 'vitalicio', dias: null };
  }

  // Padrão seguro: vitalício
  console.log(`⚠️ Plano não detectado — aplicando vitalício por padrão`);
  return { tipo: 'vitalicio', dias: null };
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook recebido:', JSON.stringify(body, null, 2));

    const email = body?.cliente?.email || body?.customer?.email || body?.email || body?.buyer_email;
    const evento = body?.evento || body?.event || body?.status || '';

    console.log(`Evento: ${evento} | Email: ${email}`);

    const eventoLower = evento.toLowerCase();
    const aprovado =
      eventoLower.includes('paid') ||
      eventoLower.includes('pag') ||
      eventoLower.includes('aprovad') ||
      eventoLower.includes('approved') ||
      eventoLower.includes('completed') ||
      eventoLower === 'sale.paid' ||
      eventoLower === 'venda.paga' ||
      eventoLower === 'venda.aprovada' ||
      body?.status === 'approved' ||
      body?.status === 'paid' ||
      body?.status === 'pago';

    if (!aprovado) {
      console.log(`Evento ignorado: ${evento}`);
      return res.status(200).json({ ok: false, msg: `Evento ignorado: ${evento}` });
    }

    if (!email) {
      console.log('Email não encontrado');
      return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
    }

    const { tipo, dias } = detectarPlano(body);
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
      email,
      ativo: true,
      plano: tipo,
      dataExpiracao,
      criadoEm: new Date().toISOString(),
    }, { merge: true });

    console.log(`✅ Cliente cadastrado: ${email} | Plano: ${tipo} | Expira: ${dataExpiracao ?? 'nunca'}`);
    return res.status(200).json({ ok: true, email, plano: tipo, dataExpiracao });

  } catch (err) {
    console.error('Erro:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'Painel Seven Webhook ativo ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
