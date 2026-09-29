import { api } from './dom.js';

const form = document.getElementById('auth-form');
const errorEl = document.getElementById('auth-error');
const submit = document.getElementById('auth-submit');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const confirmField = document.getElementById('confirm-field');
let mode = 'login';

function setMode(next) {
  mode = next;
  tabLogin.setAttribute('aria-selected', String(mode === 'login'));
  tabRegister.setAttribute('aria-selected', String(mode === 'register'));
  confirmField.hidden = mode !== 'register';
  form.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  submit.textContent = mode === 'register' ? 'Sukurti paskyrą' : 'Prisijungti';
  errorEl.textContent = '';
}

tabLogin.addEventListener('click', () => setMode('login'));
tabRegister.addEventListener('click', () => setMode('register'));

api('/api/auth/config')
  .then(({ allowRegistration }) => {
    if (!allowRegistration) tabRegister.hidden = true;
  })
  .catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  const email = form.email.value.trim();
  const password = form.password.value;
  if (!email || !password) {
    errorEl.textContent = 'Įveskite el. paštą ir slaptažodį.';
    return;
  }
  if (mode === 'register') {
    if (password.length < 8) {
      errorEl.textContent = 'Slaptažodis turi būti bent 8 simbolių.';
      return;
    }
    if (password !== form.confirm.value) {
      errorEl.textContent = 'Slaptažodžiai nesutampa.';
      return;
    }
  }
  submit.disabled = true;
  try {
    await api(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    window.location.href = '/app';
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});
