// Bot do Telegram por long polling (getUpdates): não precisa de URL pública nem de dependências.
// Só atende os chats em `allowedChatIds`; os demais recebem o próprio chat id, para facilitar a configuração.
//
// handlers:
//   commands: [{ name, aliases?, description?, run(arg) → html }]
//   onCallback(query, bot) → texto curto do aviso (opcional): clique em botão inline
//   onReply(message, bot) → true se tratou: resposta (reply) a uma mensagem do bot

const MAX_LEN = 4000; // limite do Telegram é 4096 caracteres por mensagem

export function startTelegramBot({ token, allowedChatIds, commands, onCallback, onReply, log = console }) {
  const api = async (method, body, timeoutMs = 15000) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`${method}: ${data.description || `HTTP ${res.status}`}`);
      err.code = data.error_code || res.status;
      throw err;
    }
    return data.result;
  };

  // Envia HTML; textos longos viram várias mensagens (quebrando em linhas). `extra` vai só na última.
  const send = async (chatId, html, extra = {}) => {
    const parts = [];
    let cur = '';
    for (const line of html.split('\n')) {
      if (cur && cur.length + line.length + 1 > MAX_LEN) { parts.push(cur); cur = ''; }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) parts.push(cur);
    let last;
    for (const [i, text] of parts.entries()) {
      last = await api('sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(i === parts.length - 1 ? extra : {}),
      });
    }
    return last;
  };

  const bot = {
    api,
    send,
    chats: [...allowedChatIds],
    edit: (chatId, messageId, html, extra = {}) => api('editMessageText', {
      chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra,
    }).catch((err) => { if (!/not modified/.test(err.message)) throw err; }),
    editKeyboard: (chatId, messageId, reply_markup) => api('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup })
      .catch((err) => { if (!/not modified/.test(err.message)) throw err; }),
  };

  const allowed = (chatId) => allowedChatIds.has(String(chatId));

  async function handleMessage(msg) {
    const text = msg.text?.trim();
    if (!text) return;
    const chatId = msg.chat.id;
    if (!allowed(chatId)) {
      if (!text.startsWith('/')) return;
      log.warn(`[telegram] mensagem de chat não autorizado ${chatId} (${msg.from?.username || msg.from?.first_name || '?'})`);
      return send(chatId, `Chat não autorizado.\nSeu chat id é <code>${chatId}</code>: adicione em <code>TELEGRAM_ALLOWED_CHAT_IDS</code> e reinicie o Canguinha.`);
    }
    if (msg.reply_to_message && onReply && (await onReply(msg, bot))) return;
    if (!text.startsWith('/')) return;
    const [head, ...rest] = text.split(/\s+/);
    const name = head.slice(1).split('@')[0].toLowerCase();
    const cmd = commands.find((c) => c.name === name || c.aliases?.includes(name)) || commands.find((c) => c.name === 'ajuda');
    api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      await send(chatId, await cmd.run(rest.join(' ')));
    } catch (err) {
      log.error(`[telegram] /${name}:`, err.message);
      await send(chatId, `Não consegui responder agora: ${err.message.replace(/[<>&]/g, '')}`).catch(() => {});
    }
  }

  async function handleCallback(q) {
    const chatId = q.message?.chat?.id;
    if (!chatId || !allowed(chatId) || !onCallback) return api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    let notice;
    try { notice = await onCallback(q, bot); } catch (err) {
      log.error('[telegram] botão:', err.message);
      notice = `Erro: ${err.message}`.slice(0, 190);
    }
    await api('answerCallbackQuery', { callback_query_id: q.id, ...(notice ? { text: notice } : {}) }).catch(() => {});
  }

  let stopped = false;
  bot.ready = (async () => {
    try {
      const me = await api('getMe');
      await api('setMyCommands', { commands: commands.filter((c) => c.description).map((c) => ({ command: c.name, description: c.description })) });
      log.log(`[telegram] bot @${me.username} ativo · ${allowedChatIds.size} chat(s) autorizado(s)`);
      return true;
    } catch (err) {
      log.error('[telegram] não iniciou:', err.message);
      return !(err.code === 401 || err.code === 404); // token inválido: não adianta tentar de novo
    }
  })();

  bot.ready.then(async (ok) => {
    if (!ok) return;
    let offset = 0;
    while (!stopped) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 60000);
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message) handleMessage(u.message).catch((err) => log.error('[telegram]', err.message));
          if (u.callback_query) handleCallback(u.callback_query).catch((err) => log.error('[telegram]', err.message));
        }
      } catch (err) {
        // 409: outra instância usa o mesmo token (ex.: dev e produção) ou há webhook configurado
        log.error('[telegram]', err.message);
        await new Promise((r) => setTimeout(r, err.code === 409 ? 30000 : 5000));
      }
    }
  });

  bot.stop = () => { stopped = true; };
  return bot;
}
