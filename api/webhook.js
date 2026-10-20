module.exports = async (req, res) => {
  // Таны Supabase URL анхдагч утгаар хадгалагдсан
  let rawUrl = (process.env.SUPABASE_URL || 'https://kwytoixgrvhdxkzbnafv.supabase.co').trim();
  const SUPABASE_URL = rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();

  async function sbFetch(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      return null;
    }
  }

  // Gemini AI дуудах функц (Gemini 3.1 загварууд + Автоматаар боломжит загвар илрүүлэгчтэй)
  async function askGemini(apiKey, systemPrompt, userText) {
    let models = [
      'gemini-3.1-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.0-flash',
      'gemini-flash-latest'
    ];

    // Түлхүүрт зөвшөөрөгдсөн загваруудыг Google-ээс шууд асууж жагсаалтыг баяжуулах
    try {
      const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const listData = await listRes.json();
      if (listData?.models) {
        const available = listData.models
          .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
          .map(m => m.name.replace('models/', ''))
          .filter(name => name.includes('gemini') && !name.includes('vision') && !name.includes('embedding') && !name.includes('2.5'));
        
        // Flash загваруудыг хамгийн эхэнд эрэмбэлэх (хурдтай + өндөр лимиттэй)
        const flashModels = available.filter(n => n.includes('flash'));
        const otherModels = available.filter(n => !n.includes('flash'));
        models = [...new Set([...flashModels, ...models, ...otherModels])];
      }
    } catch (e) {}

    let lastError = null;

    for (const model of models) {
      try {
        const aiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `${systemPrompt}\n\nХэрэглэгчийн мессеж: ${userText}` }] }]
            })
          }
        );
        const aiData = await aiRes.json();
        if (aiData?.error) {
          lastError = `${model}: ${aiData.error.message || JSON.stringify(aiData.error)}`;
          continue;
        }
        const parts = aiData?.candidates?.[0]?.content?.parts || [];
        const reply =
          parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n').trim() ||
          parts[0]?.text?.trim() ||
          '';
        if (reply) {
          return { reply, model, error: null };
        }
      } catch (err) {
        lastError = err.message;
      }
    }
    return { reply: '', model: null, error: lastError };
  }

  // 1. GET хүсэлт (Test горим ба Facebook Webhook баталгаажуулалт)
  if (req.method === 'GET') {
    if (req.query.test) {
      const settingsArr = await sbFetch('bot_settings?id=eq.1');
      const settings = (settingsArr && settingsArr[0]) || {};

      const geminiKey = (settings.gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
      const prompt = settings.ai_system_prompt || 'Та бол найрсаг туслах.';

      let aiTest = { reply: '', model: null, error: 'Gemini key олдсонгүй' };
      if (geminiKey) {
        aiTest = await askGemini(geminiKey, prompt, 'Сайн байна уу');
      }

      return res.status(200).json({
        status: 'Сервер хэвийн ажиллаж байна',
        supabase_url: SUPABASE_URL,
        supabase_key_configured: Boolean(SUPABASE_KEY),
        database_connected: Boolean(settingsArr && settingsArr.length > 0),
        facebook_token_saved: Boolean(settings.page_access_token || process.env.PAGE_ACCESS_TOKEN),
        gemini_key_saved: Boolean(geminiKey),
        page_id_saved: settings.page_id || process.env.PAGE_ID || 'Хадгалагдаагүй',
        ai_working_model: aiTest.model || 'Ажилласангүй',
        ai_sample_reply: aiTest.reply || null,
        ai_error: aiTest.error || null
      });
    }

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === 'noflow_secret_123') {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }

  // 2. POST хүсэлт (Webhook болон Broadcast)
  if (req.method === 'POST') {
    try {
      const settingsArr = await sbFetch('bot_settings?id=eq.1');
      const settings = (settingsArr && settingsArr[0]) || {};

      const PAGE_TOKEN = (settings.page_access_token || process.env.PAGE_ACCESS_TOKEN || '').trim();
      const GEMINI_KEY = (settings.gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
      const SYSTEM_PROMPT = settings.ai_system_prompt || 'Та бол найрсаг туслах.';

      const body = req.body || {};

      if (body.action === 'broadcast' && PAGE_TOKEN) {
        const contacts = await sbFetch('contacts?select=psid');
        let sent = 0;
        for (const c of (contacts || [])) {
          await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient: { id: c.psid }, message: { text: body.message } })
          });
          sent++;
        }
        return res.status(200).json({ sent });
      }

      if (body.object === 'page') {
        for (const entry of (body.entry || [])) {
          for (const event of (entry.messaging || [])) {
            const senderPsid = event.sender?.id;
            if (!senderPsid || event.message?.is_echo) continue;

            let userText = event.message?.text || '';
            if (event.postback) {
              const payload = event.postback.payload || '';
              const title = event.postback.title || '';
              if (payload === 'GET_STARTED' || title.toLowerCase().includes('get started') || !payload) {
                userText = 'Сайн байна уу? Танай байгууллагын талаар мэдээлэл авъя.';
              } else {
                userText = payload;
              }
            }

            if (!userText) continue;

            const phoneMatch = userText.match(/\b[6-9]\d{7}\b/);
            const contactData = { psid: senderPsid, last_active_at: new Date().toISOString() };
            if (phoneMatch) {
              contactData.phone = phoneMatch[0];
              contactData.conversion_stage = 'left_info';
            }
            await sbFetch('contacts?on_conflict=psid', {
              method: 'POST',
              headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
              body: JSON.stringify(contactData)
            });

            await sbFetch('messages', {
              method: 'POST',
              body: JSON.stringify({
                psid: senderPsid,
                sender: 'user',
                message_type: event.postback ? 'click' : 'text',
                content: userText
              })
            });

            const automations = await sbFetch('automations?is_active=eq.true&trigger_type=eq.message_keyword');
            let replyText = '';
            for (const auto of (automations || [])) {
              const kw = (auto.trigger_keyword || '').trim().toLowerCase();
              if (kw && userText.toLowerCase().includes(kw)) {
                replyText = auto.reply_message;
                break;
              }
            }

            if (!replyText && GEMINI_KEY) {
              const aiResult = await askGemini(GEMINI_KEY, SYSTEM_PROMPT, userText);
              replyText = aiResult.reply;
            }

            if (!replyText) {
              replyText = 'Сайн байна уу! Таны мессежийг хүлээн авлаа. Та утасны дугаараа үлдээнэ үү.';
            }

            if (PAGE_TOKEN) {
              await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient: { id: senderPsid }, message: { text: replyText } })
              });

              await sbFetch('messages', {
                method: 'POST',
                body: JSON.stringify({ psid: senderPsid, sender: 'bot', message_type: 'text', content: replyText })
              });
            }
          }

          for (const change of (entry.changes || [])) {
            if (change.field === 'feed' && change.value?.item === 'comment' && change.value?.verb === 'add') {
              const commentId = change.value.comment_id;
              const commenterId = change.value.from?.id;
              const commentText = change.value.message || '';

              if (commenterId === settings.page_id) continue;

              await sbFetch('messages', {
                method: 'POST',
                body: JSON.stringify({ psid: commenterId || 'commenter', sender: 'user', message_type: 'comment', content: commentText })
              });

              const commentAutos = await sbFetch('automations?is_active=eq.true&trigger_type=eq.comment');
              const replyMsg = (commentAutos && commentAutos[0]?.reply_message) || 'Сайн байна уу! Танд чатаар дэлгэрэнгүй мэдээлэл илгээлээ.';

              if (PAGE_TOKEN && commentId) {
                await fetch(`https://graph.facebook.com/v21.0/${commentId}/private_replies?access_token=${PAGE_TOKEN}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ message: replyMsg })
                });
              }
            }
          }
        }
        return res.status(200).send('EVENT_RECEIVED');
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(200).send('EVENT_RECEIVED');
    }
  }
};
