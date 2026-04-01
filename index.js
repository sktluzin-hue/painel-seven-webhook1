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

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook recebido:', JSON.stringify(body, null, 2));

    const email = body?.cliente?.email || body?.customer?.email || body?.email || body?.buyer_email;
    const evento = body?.evento || body?.event || body?.status || '';

    console.log(`Evento: ${evento} | Email: ${email}`);

    // Aceita qualquer evento de venda paga/aprovada da Lowify
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
      plano: 'vitalicio',
      criadoEm: new Date().toISOString(),
    }, { merge: true });

    console.log(`✅ Cliente cadastrado com sucesso: ${email}`);
    return res.status(200).json({ ok: true, email });

  } catch (err) {
    console.error('Erro:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'Painel Seven Webhook ativo ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
