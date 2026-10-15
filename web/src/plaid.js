// Plaid Link in the browser. Only short-lived link/public tokens ever touch the browser;
// the long-lived access token is created and kept on the server.
import { api, storage, store } from './lib.js';

let scriptPromise = null;
function loadLink() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.onload = () => resolve(window.Plaid);
      s.onerror = () => { scriptPromise = null; reject(new Error('Couldn’t load Plaid Link. Check your connection.')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

function open(token, ctx, { itemId, receivedRedirectUri } = {}) {
  return new Promise(async (resolve) => {
    const Plaid = await loadLink();
    const handler = Plaid.create({
      token,
      receivedRedirectUri,
      onSuccess: async (publicToken, metadata) => {
        store('bb_link', null);
        try {
          if (itemId) {
            // Update mode: the existing connection was repaired; just sync it.
            await api('POST', `/api/plaid/items/${itemId}/sync`);
            ctx.notify('Connection fixed');
          } else {
            const r = await api('POST', '/api/plaid/exchange', {
              public_token: publicToken,
              institution: metadata.institution,
              accounts: (metadata.accounts || []).map((a) => ({ mask: a.mask, name: a.name })),
            });
            ctx.notify(`${r.item.institution_name} connected`);
          }
          await ctx.refresh();
          window.dispatchEvent(new Event('bb:data'));
        } catch (e) { ctx.notify(e.message, true); }
        resolve(true);
      },
      onExit: (err) => {
        store('bb_link', null);
        if (err) ctx.notify(err.display_message || err.error_message || 'Bank connection was not completed.', true);
        resolve(false);
      },
    });
    handler.open();
  });
}

export async function connectBank(ctx, itemId) {
  try {
    const { link_token } = await api('POST', '/api/plaid/link-token', itemId ? { item_id: itemId } : {});
    store('bb_link', { token: link_token, itemId: itemId || null }); // needed if the bank redirects back (OAuth)
    return await open(link_token, ctx, { itemId });
  } catch (e) {
    ctx.notify(e.message, true);
    return false;
  }
}

/** Called on /oauth-return after a bank's OAuth page sends you back. */
export async function resumeOAuth(ctx) {
  const saved = storage('bb_link', null);
  const received = location.href; // includes oauth_state_id, which Link needs to finish
  history.replaceState(null, '', '/#/accounts');
  if (!saved?.token) return;
  await open(saved.token, ctx, { itemId: saved.itemId, receivedRedirectUri: received });
}
