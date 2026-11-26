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
(function () {
  var st = document.createElement('style');
  st.textContent = '.game-lock{align-items:center;text-align:center}' +
    '.meter{width:100%;max-width:280px;height:10px;border-radius:5px;background:var(--surface);overflow:hidden}' +
    '.meter span{display:block;height:100%;background:var(--accent)}' +
    '.gbar{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}' +
    '.gcv{display:block;margin:0 auto;width:min(100%,360px,45vh);width:min(100%,360px,45dvh);aspect-ratio:3/4;background:var(--surface);border:3px solid var(--fg);border-radius:4px;touch-action:manipulation}';
  document.head.appendChild(st);
  var nav = document.querySelector('nav'), b = document.createElement('button');
  b.setAttribute('data-tab', 'game');
  b.innerHTML = '<span class="pill"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M6 7h12a4 4 0 0 1 4 4v3a3 3 0 0 1-5.2 2L15 14H9l-1.8 2A3 3 0 0 1 2 14v-3a4 4 0 0 1 4-4zM7.2 9v1.2H6v1.6h1.2V13h1.6v-1.2H10v-1.6H8.8V9zM16 9.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm2.4 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg></span>Jogo';
  nav.insertBefore(b, nav.querySelector('[data-tab="profile"]'));
})();
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
  else if (tab === 'game' && !screen) viewGame();
});

function render() {
  stopGame();
  navBtns.forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (tab === 'home') { if (screen === 'add') return viewAdd(); if (screen === 'quiz') return viewQuiz(); return viewHome(); }
  if (tab === 'words') return viewWords();
  if (tab === 'game') return screen === 'play' ? viewGamePlay() : viewGame();
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

// ---------- Jogo: chuva de palavras ----------
var GAME_MIN = 20, GAME_W = 360, GAME_H = 480, GAME_BLOCK_H = 34;
var game = null;

function bestScore() { try { return parseInt(localStorage.getItem('best-game') || '0', 10) || 0; } catch (e) { return 0; } }
function saveBest(n) { try { localStorage.setItem('best-game', String(n)); } catch (e) {} }
function stopGame() { if (game && game.raf) { cancelAnimationFrame(game.raf); game.raf = 0; } }
function themeColors() {
  var cs = getComputedStyle(document.documentElement);
  function v(n) { return cs.getPropertyValue(n).trim(); }
  return { board: v('--surface'), block: v('--accent'), ink: v('--accent-ink'), limit: v('--bad'), fg: v('--fg') };
}

function viewGame() {
  var n = backend.words().length;
  if (n < GAME_MIN) {
    $main.innerHTML = '<div class="center game-lock">' +
      '<svg viewBox="0 0 24 24" width="52" height="52" fill="currentColor" aria-hidden="true"><path d="M17 9V7a5 5 0 0 0-10 0v2H5v12h14V9h-2zm-8 0V7a3 3 0 0 1 6 0v2H9z"/></svg>' +
      '<p class="prompt" style="font-size:1.2rem">Você precisa registrar 20 palavras para liberar este espaço.</p>' +
      '<div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="' + GAME_MIN + '" aria-valuenow="' + n + '"><span style="width:' + Math.round(n / GAME_MIN * 100) + '%"></span></div>' +
      '<p class="count">' + n + ' de ' + GAME_MIN + ' palavras</p>' +
      '<button class="btn primary" id="toadd">Adicionar palavra</button></div>';
    document.getElementById('toadd').onclick = function () { go('home', 'add'); };
    return;
  }
  $main.innerHTML = '<h1>Chuva de palavras</h1>' +
    '<p class="hint" style="text-align:left">Os blocos caem e se empilham. Digite a palavra de um bloco para apagá-lo. Se a pilha passar da linha pontilhada, o jogo acaba.</p>' +
    '<p class="count" style="text-align:left">Recorde: ' + bestScore() + '</p>' +
    '<button class="btn primary" id="gm-pt">Ver em português, digitar em espanhol</button>' +
    '<button class="btn" id="gm-es">Ver em espanhol, digitar em espanhol</button>';
  document.getElementById('gm-pt').onclick = function () { startGame('pt'); };
  document.getElementById('gm-es').onclick = function () { startGame('es'); };
}

function startGame(mode) {
  stopGame();
  var pool = backend.words().filter(function (w) { return w.pt && w.es; });
  game = { mode: mode, pool: shuffle(pool), idx: 0, blocks: [], score: 0, over: false, spawn: 0.3, raf: 0, last: 0 };
  go('game', 'play');
}

function viewGamePlay() {
  var g = game;
  $main.innerHTML =
    '<div class="top"><button class="btn back" id="back" aria-label="Sair do jogo">←</button><h1>Chuva de palavras</h1></div>' +
    '<div class="gbar"><span>Pontos <b id="gs">' + g.score + '</b></span><span>Recorde <b id="gb">' + bestScore() + '</b></span></div>' +
    '<canvas id="gcv" class="gcv" aria-label="Área do jogo"></canvas>' +
    '<div id="gfoot"><p class="hint" style="margin-bottom:8px">' + (g.mode === 'pt' ? 'Veja em português e digite em espanhol.' : 'Digite a palavra em espanhol.') + '</p>' +
    '<input class="field" id="gin" placeholder="Digite aqui" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Digite a palavra"></div>';
  document.getElementById('back').onclick = function () { go('game'); };
  var cv = document.getElementById('gcv'), dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.width = GAME_W * dpr; cv.height = GAME_H * dpr;
  g.cv = cv; g.ctx = cv.getContext('2d'); g.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.tc = themeColors(); g.inp = document.getElementById('gin');
  g.inp.addEventListener('input', function () { tryMatch(false); });
  g.inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryMatch(true); });
  cv.addEventListener('pointerdown', function () { g.inp.focus(); });
  g.inp.focus();
  g.last = 0;
  g.raf = requestAnimationFrame(tickGame);
}

function tryMatch(force) {
  var g = game; if (!g || g.over) return;
  var v = norm(g.inp.value); if (!v) return;
  var hit = null;
  g.blocks.forEach(function (b) { if (norm(b.want) === v && (!hit || b.y > hit.y)) hit = b; }); // o mais baixo primeiro
  if (hit) {
    g.blocks.splice(g.blocks.indexOf(hit), 1);
    g.score++;
    document.getElementById('gs').textContent = g.score;
    g.inp.value = '';
  } else if (force) g.inp.value = '';
}

function spawnBlock(g) {
  if (g.idx >= g.pool.length) { g.pool = shuffle(g.pool); g.idx = 0; }
  var w0 = g.pool[g.idx++], txt = g.mode === 'pt' ? w0.pt : w0.es, size = 16, ctx = g.ctx, tw;
  do { ctx.font = '500 ' + size + 'px "DM Sans", system-ui, sans-serif'; tw = ctx.measureText(txt).width; size--; } while (tw > GAME_W - 40 && size >= 9);
  var w = Math.min(GAME_W - 8, Math.ceil(tw + 28));
  g.blocks.push({ txt: txt, want: w0.es, font: ctx.font, x: 4 + Math.random() * (GAME_W - 8 - w), y: -GAME_BLOCK_H, w: w, h: GAME_BLOCK_H, rest: false });
}

function tickGame(ts) {
  var g = game; if (!g || g.over) return;
  var dt = g.last ? Math.min(0.05, (ts - g.last) / 1000) : 0; g.last = ts;
  g.spawn -= dt;
  if (g.spawn <= 0) { spawnBlock(g); g.spawn = Math.max(1.15, 2.8 - g.score * 0.045); }
  var step = (50 + Math.min(90, g.score * 2.2)) * dt;
  // do mais baixo para o mais alto: cada bloco cai até encostar no chão ou em outro bloco
  var bs = g.blocks.slice().sort(function (a, b) { return (b.y + b.h) - (a.y + a.h); });
  bs.forEach(function (b) {
    var support = GAME_H;
    bs.forEach(function (o) {
      if (o !== b && o.y >= b.y + b.h - 1 && b.x < o.x + o.w && o.x < b.x + b.w && o.y < support) support = o.y;
    });
    if (b.y + b.h + step >= support) { b.y = support - b.h; b.rest = true; }
    else { b.y += step; b.rest = false; }
  });
  var limit = GAME_H * 0.25; // linha a 75% da altura, contando de baixo
  for (var i = 0; i < g.blocks.length; i++) { if (g.blocks[i].rest && g.blocks[i].y < limit - 0.5) { endGame(); return; } }
  drawGame(g);
  g.raf = requestAnimationFrame(tickGame);
}

function drawGame(g) {
  var ctx = g.ctx, tc = g.tc, typed = norm(g.inp.value);
  ctx.clearRect(0, 0, GAME_W, GAME_H);
  ctx.fillStyle = tc.board; ctx.fillRect(0, 0, GAME_W, GAME_H);
  ctx.save(); ctx.setLineDash([7, 6]); ctx.lineWidth = 2; ctx.strokeStyle = tc.limit;
  ctx.beginPath(); ctx.moveTo(0, GAME_H * 0.25); ctx.lineTo(GAME_W, GAME_H * 0.25); ctx.stroke(); ctx.restore();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  g.blocks.forEach(function (b) {
    var active = typed && norm(b.want).indexOf(typed) === 0;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, 5); else ctx.rect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = active ? tc.fg : tc.block; ctx.fill();
    ctx.save(); ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5; ctx.strokeStyle = tc.ink; ctx.stroke(); ctx.restore();
    ctx.font = b.font; ctx.fillStyle = active ? tc.board : tc.ink;
    ctx.fillText(b.txt, b.x + b.w / 2, b.y + b.h / 2 + 1);
  });
}

function endGame() {
  var g = game; g.over = true; if (g.raf) { cancelAnimationFrame(g.raf); g.raf = 0; }
  drawGame(g);
  var best = bestScore(), isBest = g.score > best;
  if (isBest) { saveBest(g.score); best = g.score; }
  var gb = document.getElementById('gb'); if (gb) gb.textContent = best;
  document.getElementById('gfoot').innerHTML =
    '<p class="prompt" style="font-size:1.5rem">Fim de jogo</p>' +
    '<p class="msg ' + (isBest ? 'ok' : '') + '" role="status">' + g.score + (g.score === 1 ? ' palavra' : ' palavras') + (isBest ? ' · novo recorde!' : '') + '</p>' +
    '<div style="display:flex;flex-direction:column;gap:10px"><button class="btn primary" id="again">Jogar de novo</button><button class="btn" id="gend">Voltar</button></div>';
  document.getElementById('again').onclick = function () { startGame(g.mode); };
  document.getElementById('gend').onclick = function () { go('game'); };
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
