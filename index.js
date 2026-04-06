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

// ✅ Configuração dos planos — edite aqui se mudar os nomes das ofertas
const PLANOS = {
  'ACESSO SEMANAL':   { tipo: 'semanal',   dias: 7    },
  'ACESSO MENSAL':    { tipo: 'mensal',     dias: 30   },
  'ACESSO VITALÍCIO': { tipo: 'vitalicio',  dias: null },
  'mensal++':         { tipo: 'mensal',     dias: 30   },
  'Vitalicio++':      { tipo: 'vitalicio',  dias: null },
  'ACESSO PREMIUM':   { tipo: 'vitalicio',  dias: null },
  'PROMOÇÃO 3':       { tipo: 'vitalicio',  dias: null },
};

function calcularExpiracao(dias) {
  if (!dias) return null;
  const data = new Date();
  data.setDate(data.getDate() + dias);
  return data.toISOString();
}

function detectarPlano(body) {
  const nomeOferta =
    body?.offer?.name ||
    body?.oferta?.nome ||
    body?.offer_name ||
    body?.produto?.oferta ||
    body?.item?.name ||
    '';

  console.log(`Oferta detectada: "${nomeOferta}"`);

  const plano = PLANOS[nomeOferta];
  if (plano) return { ...plano, ofertaNome: nomeOferta };

  // Fallback: tenta detectar pelo nome parcial
  for (const [nome, config] of Object.entries(PLANOS)) {
    if (nomeOferta.toLowerCase().includes(nome.toLowerCase())) {
      return { ...config, ofertaNome: nomeOferta };
    }
  }

  // Padrão seguro: vitalício
  console.log(`⚠️ Oferta não mapeada: "${nomeOferta}" — aplicando vitalício por padrão`);
  return { tipo: 'vitalicio', dias: null, ofertaNome: nomeOferta || 'desconhecida' };
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
      body?.status === 'paid';

    if (!aprovado) {
      console.log(`Evento ignorado: ${evento}`);
      return res.status(200).json({ ok: false, msg: `Evento ignorado: ${evento}` });
    }

    if (!email) {
      console.log('Email não encontrado');
      return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
    }

    const { tipo, dias, ofertaNome } = detectarPlano(body);
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
      ofertaNome,
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
