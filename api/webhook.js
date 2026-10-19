module.exports = async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  // Туслах функц: Supabase REST API дуудах
  async function sbFetch(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
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
    return response.json();
  }

  // 1. Facebook Webhook баталгаажуулалт (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === 'noflow_secret_123') {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }

  // 2. Мессеж, Коммент болон Масс илгээлт хүлээн авах (POST)
  if (req.method === 'POST') {
    try {
      const settingsArr = await sbFetch('bot_settings?id=eq.1');
      const settings = (settingsArr && settingsArr[0]) || {};
      const PAGE_TOKEN = settings.page_access_token;
      const GEMINI_KEY = settings.gemini_api_key;
      const SYSTEM_PROMPT = settings.ai_system_prompt || 'Та бол найрсаг туслах.';

      const body = req.body || {};

      // A. Масс мессеж илгээх команд
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

      // B. Facebook-ээс ирсэн дохио
      if (body.object === 'page') {
        for (const entry of (body.entry || [])) {
          
          // 1) Messenger-ээр ирсэн чат
          for (const event of (entry.messaging || [])) {
            const senderPsid = event.sender?.id;
            if (!senderPsid || event.message?.is_echo) continue;

            const userText = event.message?.text || event.postback?.payload || '';
            if (!userText) continue;

            // Хэрэглэгчийг бүртгэх + Утасны дугаар таних
            const phoneMatch = userText.match(/\b[6-9]\d{7}\b/);
            const contactData = { psid: senderPsid, last_active_at: new Date().toISOString() };
            if (phoneMatch) {
              contactData.phone = phoneMatch[0];
              contactData.conversion_stage = 'left_info';
            }
            await sbFetch('contacts?on_conflict=psid', {
              method: 'POST',
              headers: { 'Prefer': 'resolution=merge-duplicates' },
              body: JSON.stringify(contactData)
            });

            // Хэрэглэгчийн мессежийг хадгалах
            await sbFetch('messages', {
              method: 'POST',
              body: JSON.stringify({
                psid: senderPsid,
                sender: 'user',
                message_type: event.postback ? 'click' : 'text',
                content: userText
              })
            });

            // Түлхүүр үгийн автоматжуулалт шалгах
            const automations = await sbFetch('automations?is_active=eq.true&trigger_type=eq.message_keyword');
            let replyText = '';
            for (const auto of (automations || [])) {
              if (!auto.trigger_keyword || userText.toLowerCase().includes(auto.trigger_keyword.toLowerCase())) {
                replyText = auto.reply_message;
                break;
              }
            }

            // Хэрэв дүрэм таараагүй бол 24/7 Gemini AI хариулна
            if (!replyText && GEMINI_KEY) {
              const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nХэрэглэгчийн мессеж: ${userText}` }] }]
                })
              });
              const aiData = await aiRes.json();
              replyText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            }

            if (replyText && PAGE_TOKEN) {
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

          // 2) Постын доорх Коммент уншиж чат бичих
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
