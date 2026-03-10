const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const { register, login, logout } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'dashboard.html')));
git commit -m "adiciona rota dashboard"
git push

// ── CONFIG ──
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'flowbot123';

// ── HELPER: chama a Evolution API ──
async function evolutionRequest(method, endpoint, body = null) {
  const fetch = (await import('node-fetch')).default;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_KEY,
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${EVOLUTION_URL}${endpoint}`, options);
  return res.json();
}

// ── AUTH ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'login.html'));
});

app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const result = await register(email, password);
  res.json(result);
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await login(email, password);
  res.json(result);
});

app.post('/auth/logout', async (req, res) => {
  const result = await logout();
  res.json(result);
});

// ── WHATSAPP: cria instância e retorna QR Code ──
app.post('/whatsapp/connect', async (req, res) => {
  try {
    const { userId } = req.body;
    const instanceName = `user_${userId || 'default'}`;

    // Deleta instância antiga se existir
    try { await evolutionRequest('DELETE', `/instance/delete/${instanceName}`); } catch(e) {}

    // Cria nova instância
    const created = await evolutionRequest('POST', '/instance/create', {
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });

    if (created.error) return res.json({ error: created.error });

    // Aguarda 2 segundos e busca QR Code
    await new Promise(r => setTimeout(r, 2000));
    const qr = await evolutionRequest('GET', `/instance/connect/${instanceName}`);

    res.json({
      instanceName,
      instanceId: created.instance?.instanceId,
      qrcode: qr.base64 || qr.qrcode?.base64 || null,
      pairingCode: qr.pairingCode || null,
    });
  } catch (err) {
    console.error('WhatsApp connect error:', err);
    res.json({ error: 'Erro ao conectar WhatsApp: ' + err.message });
  }
});

// ── WHATSAPP: verifica status da conexão ──
app.get('/whatsapp/status/:instanceName', async (req, res) => {
  try {
    const { instanceName } = req.params;
    const data = await evolutionRequest('GET', `/instance/fetchInstances?instanceName=${instanceName}`);
    const instance = Array.isArray(data) ? data[0] : data;
    const connected = instance?.instance?.state === 'open';
    const number = instance?.instance?.profileName || instance?.instance?.wuid?.split('@')[0] || null;
    res.json({ connected, number, state: instance?.instance?.state });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ── WHATSAPP: desconecta ──
app.post('/whatsapp/disconnect', async (req, res) => {
  try {
    const { instanceName } = req.body;
    await evolutionRequest('DELETE', `/instance/logout/${instanceName}`);
    res.json({ success: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── WHATSAPP: webhook recebe mensagens ──
app.post('/webhook/messages', async (req, res) => {
  try {
    const event = req.body;
    console.log('📨 Webhook recebido:', JSON.stringify(event, null, 2));

    if (event.event === 'messages.upsert') {
      const msg = event.data?.messages?.[0];
      if (msg && !msg.key?.fromMe) {
        const phone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '');
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        console.log(`📱 Mensagem de ${phone}: ${text}`);
        await processMessage(phone, text, event.instance);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.json({ error: err.message });
  }
});

// ── PROCESSA MENSAGEM: detecta keywords e dispara pixel ──
async function processMessage(phone, text, instanceName) {
  const textLower = text.toLowerCase();
  const events = getDefaultEvents();
  for (const ev of events) {
    const keywords = (ev.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const matched = keywords.some(k => textLower.includes(k));
    if (matched) {
      console.log(`🎯 Keyword detectada! Evento: ${ev.name} | Fone: ${phone}`);
      await firePixelEvent(ev, phone);
      break;
    }
  }
}

// ── DISPARA PIXEL META ADS ──
async function firePixelEvent(ev, phone) {
  try {
    const fetch = (await import('node-fetch')).default;
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_TOKEN;
    if (!pixelId || !token) { console.log('⚠️ Pixel não configurado'); return; }

    const payload = {
      data: [{
        event_name: ev.name,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'other',
        user_data: { ph: [phone] },
        ...(ev.name === 'Purchase' && ev.value ? {
          custom_data: {
            currency: ev.currency || 'BRL',
            value: parseFloat(ev.value),
            content_name: ev.product || 'Produto',
          }
        } : {})
      }]
    };

    const r = await fetch(`https://graph.facebook.com/v18.0/${pixelId}/events?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await r.json();
    console.log(`✅ Pixel ${ev.name} disparado:`, result);
  } catch (err) {
    console.error('❌ Erro ao disparar pixel:', err.message);
  }
}

function getDefaultEvents() {
  return [
    { name: 'Contact', keywords: 'oi,olá,bom dia,boa tarde,vim pelo link,quero saber', value: '', currency: 'BRL' },
    { name: 'Lead', keywords: 'tenho interesse,quero comprar,quanto custa,qual o valor', value: '', currency: 'BRL' },
    { name: 'Purchase', keywords: 'paguei,comprei,pix enviado,boleto pago,pagamento feito,confirmado', value: '297', currency: 'BRL', product: 'Produto' },
    { name: 'AddPaymentInfo', keywords: 'meu cpf,meu endereço,minha chave pix', value: '', currency: 'BRL' },
  ];
}

// ── CONFIGURA WEBHOOK NA EVOLUTION API ──
app.post('/whatsapp/setup-webhook', async (req, res) => {
  try {
    const { instanceName } = req.body;
    const webhookUrl = process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/messages';
    const result = await evolutionRequest('POST', `/webhook/set/${instanceName}`, {
      url: webhookUrl,
      webhook_by_events: false,
      webhook_base64: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    });
    res.json({ success: true, result });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── JOURNEY ──
app.post('/journey/steps', (req, res) => {
  console.log('Journey step saved:', req.body);
  res.json({ success: true, step: req.body });
});

app.post('/journey/reorder', (req, res) => {
  console.log('Journey reordered:', req.body);
  res.json({ success: true });
});

app.delete('/journey/steps/:id', (req, res) => {
  console.log('Journey step deleted:', req.params.id);
  res.json({ success: true });
});

// ── EVENTS ──
app.post('/events', (req, res) => {
  console.log('Event saved:', req.body);
  res.json({ success: true, event: req.body });
});

app.delete('/events/:id', (req, res) => {
  console.log('Event deleted:', req.params.id);
  res.json({ success: true });
});

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FlowBot rodando na porta ${PORT}`);
  console.log(`📡 Evolution API: ${EVOLUTION_URL}`);
});