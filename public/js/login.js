import { api } from './api.js';
import './ui.js';

const form = document.getElementById('auth-form');
const nameField = document.getElementById('name-field');
const pwHint = document.getElementById('pw-hint');
const errorBox = document.getElementById('error');
const submit = document.getElementById('submit');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');

let registering = false;

function setMode(isRegister) {
  registering = isRegister;
  nameField.classList.toggle('hidden', !isRegister);
  pwHint.classList.toggle('hidden', !isRegister);
  tabLogin.setAttribute('aria-pressed', String(!isRegister));
  tabRegister.setAttribute('aria-pressed', String(isRegister));
  submit.textContent = isRegister ? 'Create account' : 'Log in';
  document.getElementById('password').autocomplete = isRegister ? 'new-password' : 'current-password';
  errorBox.textContent = '';
}

tabLogin.addEventListener('click', () => setMode(false));
tabRegister.addEventListener('click', () => setMode(true));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.textContent = '';
  const body = {
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
  };
  if (registering) body.name = document.getElementById('name').value;

  submit.disabled = true;
  try {
    await api(registering ? '/auth/register' : '/auth/login', { method: 'POST', body });
    location.href = '/dashboard.html';
  } catch (err) {
    errorBox.textContent = err.message;
    submit.disabled = false;
  }
});
