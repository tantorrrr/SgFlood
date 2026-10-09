// §19a Cloudflare Turnstile token for Supabase anonymous sign-in (only when config.turnstileSiteKey is set).
// Docs:
//   Explicit render API:  https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
//   Widget options:       https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/
//   Supabase captcha:     https://supabase.com/docs/guides/auth/auth-captcha
//   signInAnonymously:    https://supabase.com/docs/reference/javascript/auth-signinanonymously
//                         → supabase.auth.signInAnonymously({ options: { captchaToken } })
const API = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TIMEOUT_MS = 30_000;
let loading = null;

function loadApi() {
  if (globalThis.turnstile) return Promise.resolve(globalThis.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = API;
    s.async = true;
    s.onload = () => (globalThis.turnstile ? resolve(globalThis.turnstile) : reject(new Error('turnstile_missing')));
    s.onerror = () => { loading = null; s.remove(); reject(new Error('turnstile_load')); };
    document.head.append(s);
  });
  return loading;
}

// Resolves with a one-time token (valid 300 s); rejects on widget error or timeout. The widget stays invisible
// unless Cloudflare needs an interaction ('interaction-only').
export async function captchaToken(siteKey, containerId = 'captcha') {
  const turnstile = await loadApi();
  const box = document.getElementById(containerId);
  box.hidden = false;
  let widgetId;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turnstile_timeout')), TIMEOUT_MS);
      widgetId = turnstile.render(box, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        language: 'vi',
        callback: (token) => { clearTimeout(timer); resolve(token); },
        'error-callback': (code) => { clearTimeout(timer); reject(new Error(`turnstile_${code}`)); return true; },
        'expired-callback': () => { clearTimeout(timer); reject(new Error('turnstile_expired')); },
      });
    });
  } finally {
    if (widgetId != null) turnstile.remove(widgetId);
    box.hidden = true;
  }
}
