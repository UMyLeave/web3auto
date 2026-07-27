const form = document.getElementById('loginForm');
const button = document.getElementById('loginButton');
const error = document.getElementById('loginError');

function safeDestination() {
  const requested = new URLSearchParams(window.location.search).get('next');
  return requested?.startsWith('/') && !requested.startsWith('//') ? requested : '/';
}

async function checkExistingSession() {
  const response = await fetch('/api/auth/status', { cache: 'no-store' });
  if (!response.ok) return;
  const status = await response.json();
  if (!status.enabled || status.authenticated) window.location.replace(safeDestination());
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  button.textContent = '正在验证…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.username.value.trim(),
        password: form.password.value
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '登录失败');
    window.location.replace(safeDestination());
  } catch (loginError) {
    error.textContent = loginError.message;
    form.password.select();
  } finally {
    button.disabled = false;
    button.textContent = '安全登录';
  }
});

void checkExistingSession();
