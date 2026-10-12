const root = document.querySelector('#app');
let polling,
  currentGame,
  currentPlay,
  imageStates = [],
  busy = false;
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const date = (value) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function notice(message) {
  const el = document.querySelector('#notice');
  el.textContent = message;
  setTimeout(() => {
    if (el.textContent === message) el.textContent = '';
  }, 6000);
}
async function api(path, options = {}) {
  const headers = {
    'X-Slop-Request': '1',
    ...(options.body && typeof options.body === 'string'
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...options.headers,
  };
  const response = await fetch(path, { ...options, headers });
  const result = await response.json();
  if (!response.ok) {
    const e = new Error(result.error);
    e.status = response.status;
    throw e;
  }
  return result;
}
const post = (path, value = {}) => api(path, { method: 'POST', body: JSON.stringify(value) });
function home() {
  root.innerHTML =
    `<section class="hero"><div><span class="badge">A game for skeptical eyes</span>` +
    `<h1>Real photo.<br>Fake photo.<br>Your call.</h1><p class="lede">One was captured by a human. The other was made by AI. Think you can tell them apart?</p>` +
    `<p class="muted">Got an invite? Open your game link to play.</p>` +
    `<a class="button" href="/create">Create a game ↗</a></div><div class="poster" aria-hidden="true">` +
    `<b>REAL</b><span class="vs">OR</span><b>SLOP?</b><span>Look closer.</span>` +
    `</div></section><div class="info-row"><span>01 / Two images</span>` +
    `<span>02 / One choice</span><span>03 / Trust your instincts</span>` +
    `</div>`;
}
function login() {
  root.innerHTML =
    `<section class="narrow"><p class="eyebrow">Creator studio</p>` +
    `<h1>Your photos.<br>Their guesses.</h1><p class="muted">Sign in to put your friends’ eyes to the test.</p>` +
    `<form id="login" class="panel"><label for="password">Owner password</label>` +
    `<input id="password" type="password" autocomplete="current-password" required>` +
    `<div class="actions"><button>Sign in →</button></div><p id="error" role="alert" class="error">` +
    `</p></form></section>`;
  document.querySelector('#login').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button');
    b.disabled = true;
    try {
      await post('/api/login', { password: document.querySelector('#password').value });
      await studio();
    } catch (e) {
      document.querySelector('#error').textContent = e.message;
      b.disabled = false;
    }
  };
}
const amount = (id, value) =>
  id === 'stored_bytes'
    ? `${(value / 1e9).toFixed(value < 1e8 ? 3 : 2)} GB`
    : Number(value).toLocaleString();
// Free-tier counters against their caps (80% of each free allowance) plus the kill switches.
function meter(usage) {
  return (
    `<section class="panel meter" id="meter"><h2>Free-tier usage</h2>` +
    usage.counters
      .map((c) => {
        const ratio = c.cap ? Math.min(1, c.used / c.cap) : 1;
        return (
          `<div class="meter-row${ratio >= 0.9 ? ' near' : ''}"><div class="meter-label">` +
          `<span>${esc(c.label)}</span><span>${amount(c.id, c.used)} / ${amount(c.id, c.cap)}</span></div>` +
          `<div class="progress"><span style="width:${(ratio * 100).toFixed(1)}%"></span></div></div>`
        );
      })
      .join('') +
    usage.warnings.map((w) => `<p class="muted loading-note">⚠ ${esc(w)}</p>`).join('') +
    (usage.generationBlocked ? `<p class="error">${esc(usage.generationBlocked)}</p>` : '') +
    `<label class="switch"><input type="checkbox" data-switch="generationDisabled"${usage.switches.generationDisabled ? ' checked' : ''}> Pause generation</label>` +
    `<label class="switch"><input type="checkbox" data-switch="storageReadOnly"${usage.switches.storageReadOnly ? ' checked' : ''}> Storage read-only</label>` +
    `</section>`
  );
}
function bindMeter() {
  document.querySelectorAll('[data-switch]').forEach(
    (el) =>
      (el.onchange = async () => {
        el.disabled = true;
        try {
          const usage = await post('/api/owner/switches', { [el.dataset.switch]: el.checked });
          document.querySelector('#meter').outerHTML = meter(usage);
        } catch (e) {
          el.checked = !el.checked;
          notice(e.message);
        } finally {
          el.disabled = false;
        }
        bindMeter();
      }),
  );
}
async function studio() {
  clearInterval(polling);
  currentGame = null;
  try {
    const data = await api('/api/owner/games');
    root.innerHTML =
      `<div class="studio-head"><div><p class="eyebrow">Creator studio</p>` +
      `<h1>Make them look twice.</h1></div><button class="secondary" id="logout">Sign out</button>` +
      `</div><p class="muted">Create a set of up to 10 photo pairs, then share a private invite.</p>` +
      (!data.generationConfigured || !data.storageConfigured
        ? '<p class="panel error">Image storage and generation need configuration before photos can be uploaded.</p>'
        : '') +
      `<form class="panel" id="new-game"><label for="title">Give your game a name</label>` +
      `<input id="title" maxlength="80" placeholder="The weekend photo test" required>` +
      `<div class="actions"><button>Create draft +</button></div></form>` +
      `<p class="muted loading-note">Generation capacity reserved today: ${data.budget.reserved} / ${data.budget.limit} units · Resets ${esc(data.budget.resets)}</p>` +
      `<div class="game-list">` +
      (data.games
        .map(
          (g) =>
            `<a href="#${g.id}" data-game="${g.id}" class="panel game-card">` +
            `<span class="status">${g.published ? 'Published' : 'Draft'}</span>` +
            `<h2>${esc(g.title)}</h2><p class="muted">${g.published ? 'Expires ' + date(g.published + 604800000) : 'Created ' + date(g.created)} ↗</p>` +
            `</a>`,
        )
        .join('') || '<p class="muted">Your first game starts here.</p>') +
      `</div>` +
      meter(data.usage);
    bindMeter();
    document.querySelector('#logout').onclick = async () => {
      await post('/api/logout');
      login();
    };
    document.querySelector('#new-game').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const g = await post('/api/owner/games', { title: document.querySelector('#title').value });
        await game(g.id);
      } catch (e) {
        notice(e.message);
      }
    };
    document.querySelectorAll('[data-game]').forEach(
      (el) =>
        (el.onclick = (e) => {
          e.preventDefault();
          game(el.dataset.game);
        }),
    );
  } catch (e) {
    if (e.status === 401) login();
    else failure(e.message);
  }
}
async function game(id, silent = false) {
  try {
    const g = await api(`/api/owner/games/${id}`);
    currentGame = id;
    if (silent && busy) return;
    if (silent && JSON.stringify(g) === root.dataset.gameSnapshot) return;
    root.dataset.gameSnapshot = JSON.stringify(g);
    const ready = g.questions.length > 0 && g.questions.every((q) => q.state === 'ready');
    const labels = {
      uploading: 'Uploading',
      describe: 'Describing photo',
      generate: 'Generating image',
      ready: 'Ready to play',
      failed: 'Needs attention',
    };
    root.innerHTML =
      `<button class="secondary" id="back">← All games</button><div class="game-head">` +
      `<div><p class="eyebrow">${g.published ? 'Published game' : 'Game draft'}</p>` +
      `<h2>${esc(g.title)}</h2></div><span class="badge">${g.questions.length} / 10 questions</span>` +
      `</div>` +
      (g.published
        ? `<section class="panel"><p class="eyebrow">Your invite is ready</p>` +
          `<p class="invite-url"><a href="/g/${g.invite}">${esc(location.origin + '/g/' + g.invite)}</a>` +
          `</p><button id="copy">Copy invite</button><p class="muted">Expires ${date(g.published + 604800000)}. This question set is frozen.</p>` +
          `</section>`
        : `<div class="upload"><strong>Add a real photo</strong><p class="muted">JPEG, PNG or WebP · Up to 10 MB each</p>` +
          `<input id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple ${g.questions.length >= 10 ? 'disabled' : ''} aria-label="Upload photos">` +
          `<p id="upload-status" role="status"></p></div>`) +
      `<div>` +
      g.questions
        .map(
          (q, i) =>
            `<article class="panel question-row"><img src="${q.preview}" alt="Uploaded photo ${i + 1}">` +
            `<div class="details"><strong>Question ${i + 1}</strong><p><span class="status ${q.state}">${labels[q.state]}</span>` +
            `</p>${q.error ? `<p class="error">${esc(q.error)}</p>` : ''}</div>` +
            (!g.published
              ? `<div class="actions">` +
                (q.state === 'failed' && q.manualRetries < 2
                  ? `<button data-retry="${q.id}">Retry</button>`
                  : '') +
                `<button class="secondary" data-remove="${q.id}">Remove</button>` +
                `</div>`
              : '') +
            `</article>`,
        )
        .join('') +
      `</div>` +
      (!g.published
        ? `<div class="actions"><button id="publish" ${!ready ? 'disabled' : ''}>Publish & get invite ↗</button>` +
          `</div><p class="muted">Every included question must be ready. Invites last seven days.</p>`
        : '');
    document.querySelector('#back').onclick = studio;
    if (g.published)
      document.querySelector('#copy').onclick = async () => {
        try {
          await navigator.clipboard.writeText(location.origin + '/g/' + g.invite);
          notice('Invite copied.');
        } catch {
          notice('Select the invite link to copy it.');
        }
      };
    else {
      document.querySelector('#photos').onchange = async (e) => {
        const files = [...e.target.files];
        busy = true;
        e.target.disabled = true;
        for (const [index, file] of files.entries()) {
          const status = document.querySelector('#upload-status');
          status.textContent = `Uploading ${index + 1} of ${files.length}…`;
          if (file.size > 10 * 1024 * 1024) {
            notice(`${file.name}: exceeds 10 MB.`);
            continue;
          }
          try {
            await api(`/api/owner/games/${id}/questions`, {
              method: 'POST',
              body: file,
              headers: { 'Content-Type': file.type },
            });
          } catch (e) {
            notice(e.message);
            break;
          }
        }
        busy = false;
        await game(id);
      };
      document
        .querySelectorAll('[data-retry]')
        .forEach(
          (el) =>
            (el.onclick = () =>
              mutate(el, () => post(`/api/owner/questions/${el.dataset.retry}/retry`), id)),
        );
      document
        .querySelectorAll('[data-remove]')
        .forEach(
          (el) =>
            (el.onclick = () =>
              mutate(
                el,
                () => api(`/api/owner/questions/${el.dataset.remove}`, { method: 'DELETE' }),
                id,
              )),
        );
      document.querySelector('#publish').onclick = (e) =>
        mutate(e.target, () => post(`/api/owner/games/${id}/publish`), id);
    }
    if (!silent) {
      clearInterval(polling);
      if (!g.published)
        polling = setInterval(() => {
          if (currentGame === id) game(id, true);
        }, 3000);
    }
  } catch (e) {
    if (e.status === 401) {
      clearInterval(polling);
      login();
    } else if (silent) notice(e.message);
    else failure(e.message);
  }
}
async function mutate(button, fn, id) {
  button.disabled = true;
  busy = true;
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  } finally {
    busy = false;
    await game(id);
  }
}
function savePlay(invite, id) {
  try {
    localStorage.setItem('slop:' + invite, id);
  } catch {
    notice('Browser storage is unavailable. Keep this tab open to preserve your playthrough link.');
  }
}
function savedPlay(invite) {
  try {
    return localStorage.getItem('slop:' + invite);
  } catch {
    return null;
  }
}
async function invitePage(invite) {
  try {
    const g = await api('/api/invites/' + invite),
      saved = savedPlay(invite);
    if (saved) {
      try {
        const p = await api('/api/plays/' + saved);
        if (p.invite === invite) {
          renderPlay(p);
          return;
        }
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    root.innerHTML =
      `<section class="summary"><span class="badge">You’re invited</span>` +
      `<h1>${esc(g.title)}</h1><p class="lede">Which one is slop?</p>` +
      `<p>Slop means AI-generated. In every pair, one photo is real and one was made by AI. Pick the AI image.</p>` +
      `<p class="muted">${g.total} questions · No account needed</p>` +
      `<div class="actions"><button id="start">Let’s play →</button>` +
      `</div></section>`;
    document.querySelector('#start').onclick = async (e) => {
      e.target.disabled = true;
      try {
        await startPlay(invite);
      } catch (error) {
        notice(error.message);
        e.target.disabled = false;
      }
    };
  } catch (e) {
    failure(e.message);
  }
}
async function startPlay(invite) {
  const p = await post(`/api/invites/${invite}/start`);
  savePlay(invite, p.id);
  renderPlay(p);
}
function renderPlay(p) {
  currentPlay = p;
  busy = false;
  if (!p.question) {
    root.innerHTML =
      `<section class="summary"><span class="badge">The verdict is in</span>` +
      `<h1>How sharp<br>are your eyes?</h1><div class="score">${p.score}<small> / ${p.total}</small>` +
      `</div><p>Correct answers out of ${p.total} questions.</p><p class="muted">` +
      (p.score === p.total
        ? 'You saw right through the slop.'
        : 'Some slop is surprisingly convincing.') +
      `</p><div class="actions"><button id="again">Play Again ↻</button>` +
      `</div><p class="muted">A fresh game with fresh guesses.</p></section>`;
    document.querySelector('#again').onclick = async (e) => {
      e.target.disabled = true;
      try {
        await startPlay(p.invite);
      } catch (error) {
        notice(error.message);
        e.target.disabled = false;
      }
    };
    return;
  }
  imageStates = ['loading', 'loading'];
  root.innerHTML =
    `<section class="play"><div class="game-head"><span class="eyebrow">${esc(p.title)}</span>` +
    `<span class="badge">${p.current + 1} / ${p.total}</span></div>` +
    `<div class="progress"><span style="width:${(100 * p.current) / p.total}%">` +
    `</span></div><h1>Which one is slop?</h1><p class="muted">Slop = AI-generated. Pick the image made by AI.</p>` +
    `<div class="pair">` +
    p.question.images
      .map(
        (src, i) =>
          `<button class="choice loading ${p.question.chosen === i ? 'selected' : ''}" data-side="${i}" disabled aria-label="Choose image ${i ? 'B' : 'A'} as AI-generated">` +
          `<img src="${src}" alt="Image ${i ? 'B' : 'A'}"><span class="letter">${i ? 'B' : 'A'}</span>` +
          `</button>`,
      )
      .join('') +
    `</div><p id="image-status" class="muted loading-note" role="status">Loading images…</p>` +
    `<button id="retry-images" class="secondary" hidden>Retry images ↻</button>` +
    `<div id="feedback" aria-live="polite"></div></section>`;
  document.querySelectorAll('.choice').forEach((el) => {
    const i = Number(el.dataset.side),
      img = el.querySelector('img');
    img.onload = () => imageState(i, 'ready');
    img.onerror = () => imageState(i, 'broken');
    el.onclick = () => answer(i);
    if (img.complete) imageState(i, img.naturalWidth ? 'ready' : 'broken');
  });
  document.querySelector('#retry-images').onclick = () => {
    const retry = Date.now();
    document.querySelectorAll('.choice img').forEach((img, i) => {
      imageState(i, 'loading');
      img.src = p.question.images[i] + '?retry=' + retry;
    });
  };
  feedback();
}
function imageState(i, state) {
  imageStates[i] = state;
  document.querySelectorAll('.choice').forEach((el, index) => {
    el.classList.toggle('loading', imageStates[index] === 'loading');
    el.classList.toggle('broken', imageStates[index] === 'broken');
    el.disabled =
      busy || currentPlay.question.chosen !== null || !imageStates.every((s) => s === 'ready');
  });
  const failed = imageStates.includes('broken');
  document.querySelector('#retry-images').hidden = !failed;
  document.querySelector('#image-status').textContent = failed
    ? 'An image didn’t load. Retry without losing your progress.'
    : imageStates.includes('loading')
      ? 'Loading images…'
      : '';
}
async function answer(side) {
  if (busy || currentPlay.question.chosen !== null || !imageStates.every((s) => s === 'ready'))
    return;
  busy = true;
  imageState(side, 'ready');
  try {
    currentPlay = await post(`/api/plays/${currentPlay.id}/answer`, {
      questionId: currentPlay.question.id,
      side,
    });
    feedback();
  } catch (e) {
    notice(e.message);
  } finally {
    busy = false;
    imageState(side, 'ready');
  }
}
function feedback() {
  const p = currentPlay,
    q = p.question;
  if (q.chosen === null) return;
  document
    .querySelectorAll('.choice')
    .forEach((el, i) => el.classList.toggle('selected', q.chosen === i));
  document.querySelector('#feedback').innerHTML =
    `<div class="feedback ${q.correct ? '' : 'wrong'}"><strong>${q.correct ? '✓ You spotted the slop.' : 'That one was real.'}</strong>` +
    `<p>${q.correct ? 'Your eyes win this round.' : 'The other image was AI-generated.'}</p>` +
    `<button id="next">${p.current + 1 === p.total ? 'See my score' : 'Next'} →</button>` +
    `</div>`;
  document.querySelector('#next').onclick = async (e) => {
    e.target.disabled = true;
    try {
      renderPlay(await post(`/api/plays/${p.id}/next`, { questionId: q.id }));
    } catch (error) {
      notice(error.message);
      e.target.disabled = false;
    }
  };
}
function failure(message) {
  root.innerHTML =
    `<section class="narrow"><p class="eyebrow">Slop or Not</p><h1>Can’t play<br>this one.</h1>` +
    `<p class="error" role="alert">${esc(message)}</p><p class="muted">Ask the creator for a new invite.</p>` +
    `<a href="/" class="button secondary">Back home</a></section>`;
}
if (location.pathname === '/create') studio();
else if (location.pathname.startsWith('/g/')) invitePage(location.pathname.split('/')[2]);
else home();
