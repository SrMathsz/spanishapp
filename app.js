const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';

// ---------- utilitários ----------
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function norm(s) { return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

// ---------- backend local (somente neste aparelho) ----------
function makeLocal() {
  var mem = {}, listeners = [];
  function sget(k) { try { var v = localStorage.getItem(k); return v === null ? (mem[k] === undefined ? null : mem[k]) : v; } catch (e) { return mem[k] === undefined ? null : mem[k]; } }
  function sset(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch (e) {} }
  function sdel(k) { delete mem[k]; try { localStorage.removeItem(k); } catch (e) {} }
  function jget(k, d) { try { var v = sget(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  async function hash(s) {
    try {
      var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (e) { return btoa(unescape(encodeURIComponent(s))); }
  }
  var session = sget('session') || '';
  function owner() { return session || 'guest'; }
  function words() {
    var w = jget('words:' + owner(), null);
    if (w === null) {
      w = owner() === 'guest' ? [
        { id: uid(), pt: 'amadurecer', es: 'madurar', hits: 0 },
        { id: uid(), pt: 'buscar', es: 'buscar', hits: 0 }
      ] : [];
      save(w);
    }
    return w;
  }
  function save(w) { sset('words:' + owner(), JSON.stringify(w)); }
  function notify() { listeners.forEach(function (f) { f(); }); }
  return {
    mode: 'local',
    words: words,
    user: function () { return session; },
    onChange: function (f) { listeners.push(f); },
    add: function (pt, es) { var w = words(); w.push({ id: uid(), pt: pt, es: es, hits: 0 }); save(w); notify(); },
    remove: function (id) { save(words().filter(function (x) { return x.id !== id; })); notify(); },
    hit: function (id) { var w = words(); w.forEach(function (x) { if (x.id === id) x.hits = (x.hits || 0) + 1; }); save(w); },
    register: async function (email, pass) {
      var users = jget('users', {});
      if (users[email]) throw new Error('Esse e-mail já está em uso.');
      users[email] = await hash(pass); sset('users', JSON.stringify(users));
      sset('words:' + email, JSON.stringify(jget('words:guest', [])));
      session = email; sset('session', email); notify();
    },
    login: async function (email, pass) {
      var users = jget('users', {});
      if (users[email] !== await hash(pass)) throw new Error('E-mail ou senha incorretos.');
      session = email; sset('session', email); notify();
    },
    logout: async function () { session = ''; sdel('session'); notify(); }
  };
}

// ---------- backend na nuvem (Firebase Auth + Firestore) ----------
async function makeCloud(cfg) {
  var appM = await import(FB + 'firebase-app.js');
  var A = await import(FB + 'firebase-auth.js');
  var F = await import(FB + 'firebase-firestore.js');
  var app = appM.initializeApp(cfg);
  var auth = A.getAuth(app);
  var db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  var listeners = [], cache = [], unsub = null;
  function notify() { listeners.forEach(function (f) { f(); }); }
  function col() { return F.collection(db, 'users', auth.currentUser.uid, 'words'); }
  function watch() {
    if (unsub) { unsub(); unsub = null; }
    cache = [];
    if (!auth.currentUser) { notify(); return; }
    unsub = F.onSnapshot(col(), function (snap) {
      cache = snap.docs.map(function (d) { var x = d.data(); return { id: d.id, pt: x.pt || '', es: x.es || '', hits: x.hits || 0 }; });
      notify();
    }, function () {});
  }
  function msg(e) {
    switch (e && e.code) {
      case 'auth/invalid-email': return 'E-mail inválido.';
      case 'auth/email-already-in-use':
      case 'auth/credential-already-in-use': return 'Esse e-mail já está em uso.';
      case 'auth/weak-password': return 'A senha precisa ter pelo menos 6 caracteres.';
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential': return 'E-mail ou senha incorretos.';
      case 'auth/network-request-failed': return 'Sem conexão com a internet.';
      case 'auth/operation-not-allowed': return 'Ative o login por e-mail/senha no Firebase.';
      default: return 'Erro: ' + ((e && (e.code || e.message)) || 'desconhecido');
    }
  }
  async function wrap(fn) { try { return await fn(); } catch (e) { throw new Error(msg(e)); } }

  await auth.authStateReady();
  if (!auth.currentUser) { try { await A.signInAnonymously(auth); } catch (e) {} }
  watch();
  A.onAuthStateChanged(auth, function () { watch(); });

  return {
    mode: 'cloud',
    words: function () { return cache; },
    user: function () { var u = auth.currentUser; return u && !u.isAnonymous ? (u.email || '') : ''; },
    onChange: function (f) { listeners.push(f); },
    add: function (pt, es) {
      if (!auth.currentUser) return;
      F.addDoc(col(), { pt: pt, es: es, ptLower: pt.toLowerCase(), hits: 0, createdAt: F.serverTimestamp() }).catch(function () {});
    },
    remove: function (id) { F.deleteDoc(F.doc(db, 'users', auth.currentUser.uid, 'words', id)).catch(function () {}); },
    hit: function (id) { F.updateDoc(F.doc(db, 'users', auth.currentUser.uid, 'words', id), { hits: F.increment(1) }).catch(function () {}); },
    register: function (email, pass) {
      return wrap(async function () {
        var u = auth.currentUser;
        if (u && u.isAnonymous) { await A.linkWithCredential(u, A.EmailAuthProvider.credential(email, pass)); notify(); }
        else await A.createUserWithEmailAndPassword(auth, email, pass);
      });
    },
    login: function (email, pass) { return wrap(function () { return A.signInWithEmailAndPassword(auth, email, pass); }); },
    logout: function () { return wrap(async function () { await A.signOut(auth); await A.signInAnonymously(auth); }); }
  };
}

// ---------- escolhe o backend ----------
var backend, cloudError = '';
var cfg = window.FIREBASE_CONFIG;
if (!cfg) cloudError = 'Firebase não configurado: o firebase-config.js está vazio, não foi encontrado ou o navegador guardou a versão antiga.';
else if (!cfg.apiKey || !cfg.projectId || !cfg.appId) cloudError = 'A configuração do Firebase está incompleta (faltam apiKey, projectId ou appId).';
if (!cloudError) {
  try { backend = await makeCloud(cfg); }
  catch (e) { cloudError = 'Não foi possível conectar ao Firebase (' + ((e && (e.code || e.message)) || 'erro desconhecido') + '). Usando o armazenamento deste aparelho.'; }
}
if (!backend) backend = makeLocal();

// ---------- interface ----------
var $main = document.getElementById('main');
var navBtns = Array.prototype.slice.call(document.querySelectorAll('nav button'));
var tab = 'home', screen = null; // screen: null | 'add' | 'quiz' | 'auth'
var quiz = null, authMode = 'login', query = '', armed = null;

function go(t, s) { tab = t; screen = s || null; render(); }
navBtns.forEach(function (b) { b.addEventListener('click', function () { go(b.getAttribute('data-tab')); }); });

// Atualiza só telas de leitura, para não atrapalhar quem está digitando.
backend.onChange(function () {
  if (tab === 'words' && document.getElementById('list')) drawList();
  else if (tab === 'home' && !screen) viewHome();
  else if (tab === 'profile' && !screen) viewProfile();
});

function render() {
  navBtns.forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (tab === 'home') { if (screen === 'add') return viewAdd(); if (screen === 'quiz') return viewQuiz(); return viewHome(); }
  if (tab === 'words') return viewWords();
  if (screen === 'auth') return viewAuth();
  return viewProfile();
}
function topBar(title) {
  return '<div class="top"><button class="btn back" id="back" aria-label="Voltar">←</button><h1>' + esc(title) + '</h1></div>';
}

// Início
function viewHome() {
  var n = backend.words().length;
  $main.innerHTML =
    '<h1>Treine seu espanhol</h1>' +
    '<p class="hint" style="text-align:left">' + n + (n === 1 ? ' palavra salva' : ' palavras salvas') + '</p>' +
    '<button class="btn primary" id="add">Adicionar palavra</button>' +
    '<button class="btn" id="qpt">Adivinhar em português</button>' +
    '<button class="btn" id="qes">Adivinhar em espanhol</button>';
  document.getElementById('add').onclick = function () { go('home', 'add'); };
  document.getElementById('qpt').onclick = function () { startQuiz(true); };
  document.getElementById('qes').onclick = function () { startQuiz(false); };
}

// Adicionar palavra
function viewAdd() {
  $main.innerHTML = topBar('Nova palavra') +
    '<button class="btn primary" id="save">Adicionar palavra</button>' +
    '<div class="grow"></div>' +
    '<input class="field" id="pt" placeholder="Palavra em português" autocomplete="off" autocapitalize="none">' +
    '<button class="swap" id="swap" aria-label="Trocar os textos">⇅</button>' +
    '<input class="field" id="es" placeholder="Palavra em espanhol" autocomplete="off" autocapitalize="none">' +
    '<p class="msg" id="msg" role="status"></p>' +
    '<div class="grow"></div><div class="grow"></div>';
  var pt = document.getElementById('pt'), es = document.getElementById('es'), msg = document.getElementById('msg');
  document.getElementById('back').onclick = function () { go('home'); };
  document.getElementById('swap').onclick = function () { var t = pt.value; pt.value = es.value; es.value = t; };
  function save() {
    var a = pt.value.trim(), b = es.value.trim();
    if (!a || !b) { msg.className = 'msg bad'; msg.textContent = 'Preencha as duas palavras.'; return; }
    backend.add(a, b);
    msg.className = 'msg ok'; msg.textContent = '"' + a + ' = ' + b + '" adicionada!';
    pt.value = ''; es.value = ''; pt.focus();
  }
  document.getElementById('save').onclick = save;
  es.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
  pt.addEventListener('keydown', function (e) { if (e.key === 'Enter') es.focus(); });
}

// Treino
function startQuiz(fromPt) {
  quiz = { fromPt: fromPt, list: shuffle(backend.words()).slice(0, 10), i: 0, score: 0, checked: false, ok: false, answer: '', misses: 0, wrong: false };
  go('home', 'quiz');
}
function viewQuiz() {
  var q = quiz, title = q.fromPt ? 'Português → Espanhol' : 'Espanhol → Português';
  var head = topBar(title);
  if (!q.list.length) {
    $main.innerHTML = head + '<p class="empty">Adicione pelo menos uma palavra para começar a treinar.</p><button class="btn primary" id="toadd">Adicionar palavra</button>';
    document.getElementById('back').onclick = function () { go('home'); };
    document.getElementById('toadd').onclick = function () { go('home', 'add'); };
    return;
  }
  if (q.i >= q.list.length) {
    $main.innerHTML = head + '<div class="center"><p class="prompt">Você acertou ' + q.score + ' de ' + q.list.length + ' de primeira!</p>' +
      '<button class="btn primary" id="again">Treinar de novo</button><button class="btn" id="home">Voltar</button></div>';
    document.getElementById('back').onclick = document.getElementById('home').onclick = function () { go('home'); };
    document.getElementById('again').onclick = function () { startQuiz(q.fromPt); };
    return;
  }
  var w = q.list[q.i], ask = q.fromPt ? w.pt : w.es, want = q.fromPt ? w.es : w.pt;
  $main.innerHTML = head +
    '<div class="center">' +
    '<div class="count">' + (q.i + 1) + ' / ' + q.list.length + '</div>' +
    '<p class="prompt">' + esc(ask) + '</p>' +
    '<input class="field" id="ans" placeholder="' + (q.fromPt ? 'Digite em espanhol' : 'Digite em português') + '" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"' + (q.checked ? ' disabled' : '') + '>' +
    '<p class="msg ' + (q.checked ? 'ok' : (q.wrong ? 'bad' : '')) + '" role="status">' + (q.checked ? 'Correto! ✅' : (q.wrong ? 'Errado, tente de novo ❌' : '')) + '</p>' +
    '<button class="btn primary" id="go">' + (q.checked ? 'Próxima' : 'Verificar') + '</button>' +
    '</div>';
  var ans = document.getElementById('ans');
  ans.value = q.answer;
  document.getElementById('back').onclick = function () { go('home'); };
  function check() {
    if (!ans.value.trim()) { ans.focus(); return; }
    if (norm(ans.value) === norm(want)) {
      q.checked = true; q.answer = ans.value;
      if (!q.misses) { q.score++; backend.hit(w.id); } // só conta se acertou de primeira
      viewQuiz();
      document.getElementById('go').focus();
    } else {
      q.misses++; q.wrong = true; q.answer = '';
      viewQuiz();
    }
  }
  function next() { q.i++; q.checked = false; q.ok = false; q.answer = ''; q.misses = 0; q.wrong = false; viewQuiz(); }
  document.getElementById('go').onclick = q.checked ? next : check;
  if (!q.checked) { ans.focus(); ans.addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); }); }
}

// Lista de palavras
function viewWords() {
  $main.innerHTML = '<input class="field round" id="q" type="search" placeholder="Pesquisar" autocomplete="off" aria-label="Pesquisar palavras"><div id="list"></div>';
  var q = document.getElementById('q'); q.value = query;
  q.addEventListener('input', function () { query = q.value; armed = null; drawList(); });
  drawList();
}
function drawList() {
  var box = document.getElementById('list'), term = norm(query);
  var items = backend.words().filter(function (w) { return !term || norm(w.pt).indexOf(term) > -1 || norm(w.es).indexOf(term) > -1; })
    .sort(function (a, b) { return a.pt.localeCompare(b.pt, 'pt'); });
  if (!items.length) { box.innerHTML = '<p class="empty">' + (term ? 'Nenhuma palavra encontrada.' : 'Nenhuma palavra ainda. Adicione na aba Início.') + '</p>'; return; }
  var html = '', last = '';
  items.forEach(function (w) {
    var l = (w.pt.charAt(0) || '#').toUpperCase();
    if (norm(l).toUpperCase() !== last) { last = norm(l).toUpperCase(); html += '<div class="letter">' + esc(l) + '....</div>'; }
    html += '<div class="row"><span class="w">' + esc(w.pt) + ' = ' + esc(w.es) + '</span>' +
      (w.hits ? '<span class="hits" title="Acertos no treino">✓ ' + w.hits + '</span>' : '') +
      '<button class="del' + (armed === w.id ? ' armed' : '') + '" data-id="' + esc(w.id) + '" aria-label="Apagar ' + esc(w.pt) + '">' + (armed === w.id ? 'Apagar?' : '×') + '</button></div>';
  });
  box.innerHTML = html;
  Array.prototype.forEach.call(box.querySelectorAll('.del'), function (b) {
    b.onclick = function () {
      var id = b.getAttribute('data-id');
      if (armed === id) { armed = null; backend.remove(id); }
      else { armed = id; drawList(); }
    };
  });
}

// Perfil
function viewProfile() {
  var email = backend.user(), out = !!email;
  var status = backend.mode === 'cloud'
    ? 'Palavras sincronizadas na nuvem.'
    : (cloudError || 'Suas palavras ficam salvas só neste aparelho.');
  $main.innerHTML = '<div class="avatar" aria-hidden="true">👤</div>' +
    (out ? '<p>' + esc(email) + '</p>' : '<p class="hint" style="text-align:left">Você está usando o app sem conta.</p>') +
    '<p class="hint" style="text-align:left">' + esc(status) + '</p>' +
    '<div class="grow"></div>' +
    (out ? '<button class="btn round" id="logout">Sair</button>'
         : '<button class="btn round" id="login">Login</button><button class="btn round" id="reg">Registrar-se</button>') +
    '<div class="grow"></div><div class="grow"></div>';
  if (out) document.getElementById('logout').onclick = async function () { try { await backend.logout(); } catch (e) {} go('profile'); };
  else {
    document.getElementById('login').onclick = function () { authMode = 'login'; go('profile', 'auth'); };
    document.getElementById('reg').onclick = function () { authMode = 'register'; go('profile', 'auth'); };
  }
}
function viewAuth() {
  var reg = authMode === 'register';
  $main.innerHTML = topBar(reg ? 'Registrar-se' : 'Login') +
    '<input class="field round" id="em" type="email" placeholder="E-mail" autocomplete="email" autocapitalize="none">' +
    '<input class="field round" id="pw" type="password" placeholder="Senha (mínimo 6 caracteres)" autocomplete="' + (reg ? 'new-password' : 'current-password') + '">' +
    '<p class="msg bad" id="err" role="alert"></p>' +
    '<button class="btn primary round" id="ok">' + (reg ? 'Criar conta' : 'Entrar') + '</button>' +
    '<p class="hint">' + (reg ? 'As palavras que você já adicionou passam para a nova conta.' : 'Ao entrar em outra conta, você verá as palavras dela.') +
    (backend.mode === 'local' ? ' Neste modo, as contas ficam salvas só neste navegador.' : '') + '</p>';
  document.getElementById('back').onclick = function () { go('profile'); };
  var em = document.getElementById('em'), pw = document.getElementById('pw'), err = document.getElementById('err'), ok = document.getElementById('ok');
  async function submit() {
    var email = em.value.trim().toLowerCase(), pass = pw.value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'E-mail inválido.'; return; }
    if (pass.length < 6) { err.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
    ok.disabled = true; err.textContent = '';
    try { await (reg ? backend.register(email, pass) : backend.login(email, pass)); go('profile'); }
    catch (e) { err.textContent = e.message; ok.disabled = false; }
  }
  ok.onclick = submit;
  pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
}

render();
