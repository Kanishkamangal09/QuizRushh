export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

// returns the logged in user, or sends the visitor to the login page
export async function requireLogin() {
  try {
    const { user } = await api('/auth/me');
    return user;
  } catch (err) {
    if (err.status === 401) {
      location.href = '/login.html';
      return null;
    }
    throw err;
  }
}

export async function logout() {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}
