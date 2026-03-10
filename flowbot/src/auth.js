const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function register(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };
  return { user: data.user };
}

async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  return { user: data.user, token: data.session.access_token };
}

async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) return { error: error.message };
  return { message: 'Logout realizado!' };
}

module.exports = { register, login, logout };