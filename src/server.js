const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();
const { register, login } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-41a3.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_KEY  || 'flowbot123';

// ── Pixel config em memória ──
let pixelConfig = {
  pixelId:   process.env.META_PIXEL_ID   || '',
  token:     process.env.META_TOKEN      || '',
  adAccount: process.env.META_AD_ACCOUNT || '',
};

// ── Jornada de Compra ──
let journeySteps = [
  { id:1, order:1, name:'Fez Contato',         event:'Contact',        triggerType:'auto_first',  keywords:'', product:'', fixedValue:'', currency:'BRL' },
  { id:2, order:2, name:'Demonstrou Interesse', event:'Lead',           triggerType:'auto_second', keywords:'tenho interesse,quero comprar,quanto custa,qual o valor,me manda o link', product:'', fixedValue:'', currency:'BRL' },
  { id:3, order:3, name:'Dados de Pagamento',   event:'AddPaymentInfo', triggerType:'keyword',     keywords:'meu cpf,meu endereço,minha chave pix,dados para pagamento,como pagar', product:'', fixedValue:'', currency:'BRL' },
  { id:4, order:4, name:'Comprou',              event:'Purchase',       triggerType:'keyword',     keywords:'paguei,comprei,pix enviado,boleto pago,pagamento feito,pedido confirmado', product:'Produto', fixedValue:'', currency:'BRL' },
];

// ── Estado em memória ──
const leadTracker = {};  // phone → { stepId, stepOrder, msgCount, firstSeen, lastSeen, messages, unread }
const funnelStats = {};  // stepId → count
const pixelLog    = [];  // array de log entries

// ── Cache de histórico já sincronizado por instância+phone ──
const historySynced = {}; // `${instanceName}:${phone}` → true

// ── Histórico diário para gráfico ──
const chartHistory = {};
function recordDay(type) {
  const key = new Date().toISOString().split('T')[0];
  if (!chartHistory[key]) chartHistory[key] = { contacts: 0, purchases: 0 };
  if (type === 'contact')  chartHistory[key].contacts++;
  if (type === 'purchase') chartHistory[key].purchases++;
}

// ── Helper Evolution API ──
async function evo(method, endpoint, body = null) {
  const fetch = (await import('node-fetch')).default;
  const opts  = { method, headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${EVOLUTION_URL}${endpoint}`, opts);
  if (!r.ok) { const t = await r.text(); throw new Error(`Evolution ${r.status}: ${t.substring(0,200)}`); }
  return r.json();
}

// ══════════════════════════
// SINCRONIZA HISTÓRICO DO EVOLUTION para um contato
// Chama a Evolution API e injeta mensagens antigas no leadTracker
// ══════════════════════════
async function syncHistoryFromEvolution(instanceName, phone) {
  const cacheKey = `${instanceName}:${phone}`;
  if (historySynced[cacheKey]) return; // já sincronizou, não repete
  historySynced[cacheKey] = true;

  try {
    // Busca até 100 mensagens históricas do contato
    const result = await evo('GET', `/chat/findMessages/${instanceName}?where[key][remoteJid]=${phone}@s.whatsapp.net&limit=100`);
    const msgs = result?.messages?.records || result?.records || result?.messages || [];
    if (!msgs.length) return;

    // Garante que o lead existe na memória
    const now = Date.now();
    if (!leadTracker[phone]) {
      leadTracker[phone] = { stepId: null, stepOrder: 0, msgCount: 0, firstSeen: now, lastSeen: now, messages: [], unread: 0, name: phone };
    }
    const lead = leadTracker[phone];

    // Converte mensagens do Evolution para o formato interno
    const historicMsgs = msgs
      .filter(m => m.message) // só mensagens com conteúdo
      .map(m => ({
        fromMe: m.key?.fromMe || false,
        text:   m.message?.conversation
             || m.message?.extendedTextMessage?.text
             || m.message?.imageMessage?.caption
             || m.message?.videoMessage?.caption
             || (m.key?.fromMe ? '[mensagem enviada]' : '[mídia]'),
        ts:     (m.messageTimestamp || 0) * 1000, // Evolution usa segundos
        pixelEvent: null,
      }))
      .sort((a, b) => a.ts - b.ts); // ordem cronológica

    // Mescla: histórico antigo + mensagens já em memória (evita duplicatas por timestamp)
    const existingTs = new Set(lead.messages.map(m => m.ts));
    const toAdd = historicMsgs.filter(m => !existingTs.has(m.ts));

    if (toAdd.length) {
      lead.messages = [...toAdd, ...lead.messages].sort((a, b) => a.ts - b.ts);
      // Limita a 200 mensagens mais recentes
      if (lead.messages.length > 200) lead.messages = lead.messages.slice(-200);
      console.log(`📂 Histórico sincronizado: ${phone} → +${toAdd.length} mensagens`);
    }

    // Atualiza nome se disponível
    const lastWithName = msgs.find(m => m.pushName);
    if (lastWithName?.pushName) lead.name = lastWithName.pushName;

  } catch(err) {
    // Não quebra o fluxo se falhar (Evolution pode não ter o endpoint disponível)
    console.log(`⚠️  Histórico ${phone}: ${err.message.substring(0, 80)}`);
    // Remove do cache para tentar novamente depois
    delete historySynced[cacheKey];
  }
}

// ══════════════════════════
// BUSCA TODAS AS CONVERSAS DO EVOLUTION e pré-carrega históricos
// Chamado quando o dashboard abre /conversations
// ══════════════════════════
async function syncAllChatsFromEvolution(instanceName) {
  try {
    const result = await evo('GET', `/chat/findChats/${instanceName}`);
    const chats = Array.isArray(result) ? result : (result?.chats || []);
    if (!chats.length) return;

    const individual = chats.filter(c => {
      const jid = c.id || c.remoteJid || '';
      return jid.includes('@s.whatsapp.net');
    });

    console.log(`📋 ${individual.length} conversas encontradas no Evolution`);

    for (const chat of individual.slice(0, 50)) {
      const jid   = chat.id || chat.remoteJid || '';
      const phone = jid.replace('@s.whatsapp.net', '');
      const name  = chat.name || chat.pushName || phone;
      const now   = Date.now();

      if (!leadTracker[phone]) {
        leadTracker[phone] = {
          stepId: null, stepOrder: 0, msgCount: 0,
          firstSeen: now, lastSeen: now,
          messages: [], unread: 0, name,
        };
      } else if (name !== phone) {
        leadTracker[phone].name = name;
      }

      // Carrega mensagens se ainda não tem
      if (!leadTracker[phone].messages?.length) {
        try {
          const msgs = await evo('POST', `/chat/findMessages/${instanceName}`, {
            where: { key: { remoteJid: jid } },
            limit: 50
          });
          const list = Array.isArray(msgs) ? msgs : (msgs?.messages?.records || msgs?.messages || []);
          if (list.length) {
            leadTracker[phone].messages = list.map(m => ({
              text:    m.message?.conversation || m.message?.extendedTextMessage?.text || '',
              fromMe:  m.key?.fromMe || false,
              ts:      m.messageTimestamp ? m.messageTimestamp * 1000 : Date.now(),
            })).filter(m => m.text);
            leadTracker[phone].lastSeen = leadTracker[phone].messages.at(-1)?.ts || now;
          }
        } catch(e) {}
      }
    }
  } catch(err) {
    console.log(`⚠️  syncAllChats: ${err.message.substring(0, 80)}`);
  }
}

// ══════════════════════════
// AUTH
// ══════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'dashboard.html')));
app.post('/auth/register', async (req, res) => res.json(await register(req.body.email, req.body.password)));
app.post('/auth/login',    async (req, res) => res.json(await login(req.body.email, req.body.password)));

// ══════════════════════════
// PIXEL CONFIG
// ══════════════════════════
app.post('/pixel/config', (req, res) => {
  const { pixelId, token, adAccount } = req.body;
  if (!pixelId || !token) return res.status(400).json({ error: 'pixelId e token obrigatórios' });
  pixelConfig = { pixelId: pixelId.trim(), token: token.trim(), adAccount: adAccount || '' };
  console.log(`🎯 Pixel configurado → ID: ${pixelConfig.pixelId}`);
  res.json({ success: true });
});

app.post('/pixel/test', async (req, res) => {
  const pid = (req.body.pixelId || pixelConfig.pixelId).trim();
  const tok = (req.body.token   || pixelConfig.token).trim();
  if (!pid || !tok) return res.json({ error: 'Pixel não configurado' });
  try {
    const fetch = (await import('node-fetch')).default;
    const payload = { data: [{
      event_name: 'PageView',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'other',
      user_data: { client_ip_address: '127.0.0.1', client_user_agent: 'FlowBot/1.0' }
    }] };
    const r = await fetch(`https://graph.facebook.com/v18.0/${pid}/events?access_token=${tok}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (d.error) return res.json({ error: d.error.message });
    console.log(`✅ Pixel test OK: ${pid} → ${JSON.stringify(d)}`);
    res.json({ success: true, events_received: d.events_received });
  } catch(err) { res.json({ error: err.message }); }
});

app.get('/pixel/logs', (req, res) => res.json({ logs: pixelLog.slice(-100) }));

// ══════════════════════════
// CHART DATA
// ══════════════════════════
app.get('/chart/data', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.json({ data: chartHistory });
  const result = {};
  const cur = new Date(from + 'T00:00:00');
  const end = new Date(to   + 'T23:59:59');
  while (cur <= end) {
    const k = cur.toISOString().split('T')[0];
    result[k] = chartHistory[k] || { contacts: 0, purchases: 0 };
    cur.setDate(cur.getDate() + 1);
  }
  res.json({ data: result });
});

// ══════════════════════════
// JORNADA
// ══════════════════════════
app.get('/journey', (req, res) => res.json({ steps: journeySteps }));
app.post('/journey/sync', (req, res) => {
  if (Array.isArray(req.body.steps)) {
    journeySteps = req.body.steps;
    console.log(`🗺️  Jornada sincronizada: ${journeySteps.length} etapas`);
    journeySteps.sort((a,b)=>a.order-b.order).forEach(s =>
      console.log(`   #${s.order} "${s.name}" → ${s.event||'sem pixel'} [${s.triggerType}]`));
  }
  res.json({ success: true });
});
app.post('/journey/steps',       (req, res) => { const i=journeySteps.findIndex(s=>s.id===req.body.id); if(i>=0) journeySteps[i]=req.body; else journeySteps.push(req.body); res.json({success:true}); });
app.delete('/journey/steps/:id', (req, res) => { journeySteps=journeySteps.filter(s=>s.id!==parseInt(req.params.id)); res.json({success:true}); });
app.post('/journey/reorder',     (req, res) => { if(Array.isArray(req.body.steps)) journeySteps=req.body.steps; res.json({success:true}); });

// ══════════════════════════
// FUNNEL STATS
// ══════════════════════════
app.get('/funnel/stats', (req, res) => res.json({ stats: funnelStats }));

// ══════════════════════════
// EVENTOS
// ══════════════════════════
app.get('/events', (req, res) => res.json({ events: [] }));

// ══════════════════════════
// UTILITÁRIOS
// ══════════════════════════
function extractValue(text) {
  const pats = [
    /R\$\s*([\d.]+(?:,\d{2})?)/i,
    /valor[:\s]+R?\$?\s*([\d.]+(?:,\d{2})?)/i,
    /pagamento[:\s]+R?\$?\s*([\d.]+(?:,\d{2})?)/i,
    /total[:\s]+R?\$?\s*([\d.]+(?:,\d{2})?)/i,
    /pix de[:\s]+R?\$?\s*([\d.]+(?:,\d{2})?)/i,
    /(\d{1,3}(?:\.\d{3})*,\d{2})/,
    /(\d+,\d{2})/,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) { const v = parseFloat(m[1].replace(/\./g,'').replace(',','.')); if (!isNaN(v) && v > 0) return v; }
  }
  return null;
}

function matchKeyword(text, keywords) {
  if (!keywords) return false;
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  const t = norm(text);
  return keywords.split(',').some(kw => { const k=norm(kw); return k && t.includes(k); });
}

async function firePixel(step, phone, messageText) {
  if (!step.event) return;
  const { pixelId, token } = pixelConfig;
  let value = null;
  if (step.event === 'Purchase')
    value = step.fixedValue ? parseFloat(step.fixedValue) : extractValue(messageText || '');

  const entry = { id: Date.now(), ts: new Date().toISOString(), phone, event: step.event, stepName: step.name, value, sent: false, result: null };

  if (!pixelId || !token) {
    entry.result = 'Pixel não configurado — configure em Conexões';
    pixelLog.push(entry);
    console.log(`⚠️  [${step.event}] Pixel não configurado`);
    return;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const ed = {
      event_name: step.event,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'other',
      user_data: { ph: [phone.replace(/\D/g,'')] },
    };
    if (step.event === 'Purchase' && value)
      ed.custom_data = { currency: step.currency || 'BRL', value, content_name: step.product || 'Produto' };

    const r = await fetch(`https://graph.facebook.com/v18.0/${pixelId}/events?access_token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [ed] })
    });
    const d = await r.json();
    entry.sent   = !d.error;
    entry.result = d.events_received ? `✅ recebido (${d.events_received})` : (d.error?.message || JSON.stringify(d));
    console.log(`${entry.sent?'✅':'❌'} Pixel ${step.event} | ${phone}${value ? ' | R$'+value : ''} | ${entry.result}`);
  } catch(err) {
    entry.result = 'Erro: ' + err.message;
    console.error(`❌ Pixel ${step.event}:`, err.message);
  }
  pixelLog.push(entry);
}

async function advanceLead(phone, step, text) {
  const lead = leadTracker[phone];
  lead.stepId    = step.id;
  lead.stepOrder = step.order;
  lead.lastSeen  = Date.now();
  funnelStats[step.id] = (funnelStats[step.id] || 0) + 1;
  console.log(`➡️  ${phone} → "${step.name}" (${step.event || 'sem pixel'})`);
  if (step.event === 'Contact')  recordDay('contact');
  if (step.event === 'Purchase') recordDay('purchase');
  await firePixel(step, phone, text);
}

async function processMessage(phone, text, metadata = {}) {
  const sorted = [...journeySteps].sort((a,b) => a.order - b.order);
  if (!sorted.length) return;
  const now = Date.now();
  if (!leadTracker[phone])
    leadTracker[phone] = { stepId: null, stepOrder: 0, msgCount: 0, firstSeen: now, lastSeen: now, messages: [], name: metadata.name || phone, unread: 0 };
  const lead = leadTracker[phone];
  if (!lead.messages) lead.messages = [];
  lead.messages.push({ fromMe: false, text, ts: now });
  if (lead.messages.length > 200) lead.messages = lead.messages.slice(-200);
  lead.msgCount++;
  lead.lastSeen = now;
  lead.unread = (lead.unread || 0) + 1;
  if (metadata.name && metadata.name !== phone) lead.name = metadata.name;
  let firedEvent = null;
  for (const step of sorted) {
    if (step.order <= (lead.stepOrder || 0)) continue;
    const { triggerType, keywords } = step;
    let matched = false;
    if (triggerType === 'auto_first'  && lead.msgCount === 1)           matched = true;
    if (triggerType === 'auto_second' && lead.msgCount >= 2)            matched = true;
    if (triggerType === 'keyword'     && matchKeyword(text, keywords))  matched = true;
    if (matched) { firedEvent = step.event; await advanceLead(phone, step, text); break; }
  }
  if (firedEvent && lead.messages.length > 0) {
    lead.messages[lead.messages.length - 1].pixelEvent = firedEvent;
  }
}

// ══════════════════════════
// WHATSAPP
// ══════════════════════════
app.post('/whatsapp/connect', async (req, res) => {
  const { userId = 'default', method = 'qr', phone } = req.body;
  const instanceName = `flowbot_${userId}`;
  try {
    try {
      const status = await evo('GET', `/instance/connectionState/${instanceName}`);
      if (status?.instance?.state === 'open') {
        // Pré-carrega conversas em background quando já conectado
        syncAllChatsFromEvolution(instanceName).catch(() => {});
        return res.json({ instanceName, connected: true, number: status?.instance?.ownerJid?.replace('@s.whatsapp.net','') });
      }
    } catch(e) {}
    try { await evo('DELETE', `/instance/delete/${instanceName}`); } catch(e) {}
    await new Promise(r => setTimeout(r, 800));
    await evo('POST', '/instance/create', {
      instanceName,
      qrcode: method === 'qr',
      integration: 'WHATSAPP-BAILEYS',
    });
    await new Promise(r => setTimeout(r, 2000));

    if (method === 'pairing' && phone) {
      const result = await evo('POST', `/instance/pairingCode/${instanceName}`, { phoneNumber: phone });
      const code   = result.code || result.pairingCode || null;
      if (!code) return res.json({ error: 'Código não gerado. Tente pelo QR Code.' });
      return res.json({ instanceName, pairingCode: code });
    } else {
      const qr = await evo('GET', `/instance/connect/${instanceName}`);
      const qrcode = qr.base64 || qr.qrcode?.base64 || null;
      if (!qrcode) return res.json({ error: 'QR Code não gerado. Aguarde e tente novamente.' });
      return res.json({ instanceName, qrcode });
    }
  } catch(err) {
    console.error('WA connect error:', err.message);
    res.json({ error: err.message });
  }
});

app.get('/whatsapp/status/:instanceName', async (req, res) => {
  try {
    const data = await evo('GET', `/instance/connectionState/${req.params.instanceName}`);
    const state = data?.instance?.state || data?.state;
    const number = data?.instance?.ownerJid?.replace('@s.whatsapp.net','') || null;

    // Quando conectado, pré-carrega todas as conversas em background
    if (state === 'open') {
      syncAllChatsFromEvolution(req.params.instanceName).catch(() => {});
    }

    res.json({ connected: state === 'open', number, state });
  } catch(err) { res.json({ connected: false }); }
});

app.post('/whatsapp/disconnect', async (req, res) => {
  try { await evo('DELETE', `/instance/logout/${req.body.instanceName}`); res.json({ success: true }); }
  catch(err) { res.json({ error: err.message }); }
});

app.post('/whatsapp/setup-webhook', async (req, res) => {
  const webhookUrl = process.env.WEBHOOK_URL || 'https://flowbot-production-2d32.up.railway.app/webhook/messages'
  try {
    const r = await evo('POST', `/webhook/set/${req.body.instanceName}`, {
      url: webhookUrl,
      webhook_by_events: false,
      webhook_base64: true,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    });
    console.log(`🔗 Webhook → ${webhookUrl}`);
    res.json({ success: true });
  } catch(err) { res.json({ error: err.message }); }
});

// ══════════════════════════
// WEBHOOK — recebe mensagens
// ══════════════════════════
app.post('/webhook/messages', async (req, res) => {
  res.json({ received: true });
  try {
    const ev = req.body;
    if (ev.event === 'messages.upsert') {
      const msg = ev.data?.messages?.[0];
      if (msg) {
        const phone    = (msg.key?.remoteJid || '').replace('@s.whatsapp.net','').replace('@g.us','');
        const text     = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const pushName = msg.pushName || msg.notifyName || null;
        const fromMe   = msg.key?.fromMe || false;

        if (phone && !phone.includes('@') && !phone.includes('-')) {
          if (fromMe) {
            // ── Mensagem ENVIADA pelo usuário do WhatsApp ──
            if (!leadTracker[phone]) {
              leadTracker[phone] = { stepId: null, stepOrder: 0, msgCount: 0, firstSeen: Date.now(), lastSeen: Date.now(), messages: [], unread: 0, name: phone };
            }
            const lead = leadTracker[phone];
            if (text) {
              lead.messages.push({ fromMe: true, text, ts: Date.now() });
              if (lead.messages.length > 200) lead.messages = lead.messages.slice(-200);
            }
            lead.lastSeen = Date.now();
          } else {
            // ── Mensagem RECEBIDA ──
            if (text) {
              console.log(`📨 ${pushName||phone}: ${text.substring(0,80)}`);
              await processMessage(phone, text, { name: pushName });
            }
          }
        }
      }
    }
    if (ev.event === 'connection.update') {
      console.log(`🔌 ${ev.instance} → ${ev.data?.state}`);
      // Quando reconectar, limpa cache de histórico para re-sincronizar
      if (ev.data?.state === 'open') {
        const instance = ev.instance;
        Object.keys(historySynced).forEach(k => {
          if (k.startsWith(instance + ':')) delete historySynced[k];
        });
        syncAllChatsFromEvolution(instance).catch(() => {});
      }
    }
  } catch(err) { console.error('Webhook error:', err.message); }
});

// ══════════════════════════════════════════════
// CONVERSAS — API para o dashboard
// ══════════════════════════════════════════════

// Lista todas as conversas
app.get('/conversations', async (req, res) => {
  const { instanceName } = req.query;
  
  // Se leadTracker vazio, espera o sync terminar antes de responder
  if (instanceName && Object.keys(leadTracker).length === 0) {
    await syncAllChatsFromEvolution(instanceName).catch(() => {});
  } else if (instanceName) {
    syncAllChatsFromEvolution(instanceName).catch(() => {});
  }

  const convs = Object.entries(leadTracker).map(([phone, lead]) => {
    const step = journeySteps.find(s => s.id === lead.stepId);
    const msgs = (lead.messages || []).map(m => ({
      dir:  m.fromMe ? 'out' : 'in',
      txt:  m.text,
      time: new Date(m.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
      date: new Date(m.ts).toLocaleDateString('pt-BR'),
      pixelEvent: m.pixelEvent || null
    }));
    return {
      id:       phone,
      phone,
      name:     lead.name || phone,
      stage:    step?.name || 'Novo',
      lastTime: lead.lastSeen ? new Date(lead.lastSeen).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '',
      unread:   lead.unread || 0,
      msgs,
    };
  }).sort((a, b) => {
    const aT = leadTracker[a.phone]?.lastSeen || 0;
    const bT = leadTracker[b.phone]?.lastSeen || 0;
    return bT - aT;
  });
  res.json({ conversations: convs });
});
```


// ── NOVO: Histórico completo de uma conversa específica ──
// GET /conversations/:phone?instanceName=flowbot_default
app.get('/conversations/:phone', async (req, res) => {
  const { phone } = req.params;
  const { instanceName = 'flowbot_default' } = req.query;

  // Sincroniza histórico do Evolution para este contato
  await syncHistoryFromEvolution(instanceName, phone);

  const lead = leadTracker[phone];
  if (!lead) return res.json({ phone, messages: [], name: phone, stage: 'Novo' });

  // Zera unread quando o dashboard abre a conversa
  lead.unread = 0;

  const step = journeySteps.find(s => s.id === lead.stepId);
  const messages = (lead.messages || []).map(m => ({
    dir:        m.fromMe ? 'out' : 'in',
    txt:        m.text,
    time:       new Date(m.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
    date:       new Date(m.ts).toLocaleDateString('pt-BR'),
    ts:         m.ts,
    pixelEvent: m.pixelEvent || null,
  }));

  res.json({
    phone,
    name:     lead.name || phone,
    stage:    step?.name || 'Novo',
    msgCount: lead.msgCount,
    firstSeen: lead.firstSeen,
    lastSeen:  lead.lastSeen,
    messages,
  });
});

// Envia mensagem pelo WhatsApp
app.post('/whatsapp/send', async (req, res) => {
  const { instanceName, phone, message } = req.body;
  if (!instanceName || !phone || !message) return res.status(400).json({ error: 'instanceName, phone e message são obrigatórios' });
  try {
    const result = await evo('POST', `/message/sendText/${instanceName}`, {
      number:  phone.replace(/\D/g,'') + '@s.whatsapp.net',
      options: { delay: 200 },
      textMessage: { text: message }
    });
    if (!leadTracker[phone]) leadTracker[phone] = { stepId: null, stepOrder: 0, msgCount: 0, firstSeen: Date.now(), lastSeen: Date.now(), messages: [], unread: 0 };
    if (!leadTracker[phone].messages) leadTracker[phone].messages = [];
    leadTracker[phone].messages.push({ fromMe: true, text: message, ts: Date.now() });
    if (leadTracker[phone].messages.length > 200) leadTracker[phone].messages = leadTracker[phone].messages.slice(-200);
    leadTracker[phone].lastSeen = Date.now();
    res.json({ success: true, result });
  } catch(err) {
    console.error('Send message error:', err.message);
    res.json({ error: err.message });
  }
});

// ══════════════════════════
// START
// ══════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ═══════════════════════════════════════');
  console.log(`   FlowBot rodando → http://localhost:${PORT}`);
  console.log('════════════════════════════════════════════');
  console.log(`📡 Evolution API  : ${EVOLUTION_URL}`);
  console.log(`🎯 Pixel Meta     : ${pixelConfig.pixelId ? '✅ ' + pixelConfig.pixelId : '⚠️  Não configurado — configure em Conexões'}`);
  console.log(`🗺️  Jornada        : ${journeySteps.length} etapas`);
  console.log(`🔗 Webhook        : ${process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/messages'}`);
  console.log('');
  console.log('  Passos para iniciar:');
  console.log('  1. docker-compose up -d');
  console.log('  2. Acesse http://localhost:3000');
  console.log('  3. Vá em Conexões → Conectar WhatsApp');
  console.log('  4. Configure o Pixel em Conexões → Meta Ads');
  console.log('');
});