import express from 'express';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// Firebase Admin SDK
const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const auth = admin.auth();
const db = admin.firestore();
const app = express();
app.use(express.json());

// Calcula data de expiração baseada no produto
function calcularExpiracao(nomeProduto) {
  const nome = nomeProduto?.toLowerCase() || '';

  if (nome.includes('7 dias') || nome.includes('7dias') || nome.includes('sete dias')) {
    const data = new Date();
    data.setDate(data.getDate() + 7);
    return { plano: '7dias', expiracao: data.toISOString() };
  }

  if (nome.includes('mensal') || nome.includes('30 dias') || nome.includes('30dias')) {
    const data = new Date();
    data.setDate(data.getDate() + 30);
    return { plano: 'mensal', expiracao: data.toISOString() };
  }

  // Vitalício (padrão)
  return { plano: 'vitalicio', expiracao: null };
}

// Senha padrão por plano
function senhaPorPlano(plano) {
  if (plano === '7dias') return 'painel7dias';
  if (plano === 'mensal') return 'painelmensal';
  return 'painel2026'; // vitalício
}

// Webhook principal
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook recebido:', JSON.stringify(body, null, 2));

    // Lowify envia dados do comprador nesse formato
    const email = body?.customer?.email || body?.email || body?.buyer_email;
    const nomeProduto = body?.product?.name || body?.product_name || body?.offer_name || '';
    const evento = body?.event || body?.status || '';

    // Só processa vendas aprovadas
    const eventosAprovados = ['order_approved', 'purchase_approved', 'venda_aprovada', 'approved', 'APPROVED'];
    const aprovado = eventosAprovados.some(e => evento?.toLowerCase().includes(e.toLowerCase()))
      || body?.order_status === 'approved'
      || body?.status === 'approved';

    if (!email) {
      console.log('Email não encontrado no payload');
      return res.status(200).json({ ok: false, msg: 'Email não encontrado' });
    }

    if (!aprovado) {
      console.log('Evento não é aprovação:', evento);
      return res.status(200).json({ ok: false, msg: 'Evento ignorado' });
    }

    const { plano, expiracao } = calcularExpiracao(nomeProduto);
    const senha = senhaPorPlano(plano);

    // Tenta criar usuário no Firebase Auth
    let uid;
    try {
      const usuario = await auth.createUser({ email, password: senha });
      uid = usuario.uid;
      console.log(`Usuário criado: ${email}`);
    } catch (e) {
      if (e.code === 'auth/email-already-exists') {
        // Usuário já existe, só atualiza o Firestore
        const usuario = await auth.getUserByEmail(email);
        uid = usuario.uid;
        console.log(`Usuário já existe, atualizando: ${email}`);
      } else {
        throw e;
      }
    }

    // Salva/atualiza no Firestore
    const dadosUsuario = {
      email,
      ativo: true,
      plano,
      criadoEm: new Date().toISOString(),
      ...(expiracao && { expiracao }),
    };

    await db.collection('usuarios').doc(uid).set(dadosUsuario, { merge: true });
    console.log(`Cliente cadastrado com sucesso: ${email} | Plano: ${plano}`);

    return res.status(200).json({ ok: true, email, plano });

  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Painel Seven Webhook ativo ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
